begin;
create extension if not exists pgtap with schema extensions;

select plan(72);

-- Org 1 (seed, default policy) has Erin. Org 2 has a short policy; org 3's policy is
-- out of range or not a number, so it falls back to / is clamped to the limits.
\set org1 '''00000000-0000-4000-8000-000000000001'''
\set org2 '''00000000-0000-4000-8000-000000000002'''
\set org3 '''00000000-0000-4000-8000-000000000003'''
\set erin '''00000000-0000-4000-8000-0000000000c1'''
\set u2 '''00000000-0000-4000-8000-0000000000d2'''
\set u3 '''00000000-0000-4000-8000-0000000000d3'''
\set dev1 '''00000000-0000-4000-8000-0000000000e1'''
\set dev2 '''00000000-0000-4000-8000-0000000000e2'''
\set dev3 '''00000000-0000-4000-8000-0000000000e3'''
\set max '''00000000-0000-4000-8000-0000000000b1'''

insert into public.orgs (id, name, policy) values
  (:org2, 'Short Co',
   '{"image_retention_days": 7, "event_retention_months": 6, "timesheet_retention_years": 5}'),
  (:org3, 'Wild Co',
   '{"image_retention_days": 1000, "event_retention_months": "bad", "timesheet_retention_years": 1}');
insert into auth.users (id, email) values (:u2, 'u2@short.test'), (:u3, 'u3@wild.test');
insert into public.users (id, org_id, full_name, email, role) values
  (:u2, :org2, 'Una Short', 'u2@short.test', 'owner'),
  (:u3, :org3, 'Ugo Wild', 'u3@wild.test', 'owner');
insert into public.devices (id, org_id, user_id, platform, os_version, agent_version, hardware_hash) values
  (:dev1, :org1, :erin, 'macos', '26.0', '0.1.0', 'h1'),
  (:dev2, :org2, :u2, 'macos', '26.0', '0.1.0', 'h2'),
  (:dev3, :org3, :u3, 'macos', '26.0', '0.1.0', 'h3');

create function pg_temp.act_as(uid uuid) returns void
language sql as $$
  select set_config('role', 'postgres', true);
  select set_config('request.jwt.claims',
    (internal.custom_access_token_hook(jsonb_build_object(
      'user_id', uid, 'claims', jsonb_build_object('sub', uid, 'role', 'authenticated')
    )) -> 'claims')::text, true);
  select set_config('role', 'authenticated', true);
$$;

create function pg_temp.act_as_postgres() returns void
language sql as $$
  select set_config('role', 'postgres', true);
  select set_config('request.jwt.claims', '', true);
$$;

-- The UTC date p_years back from now, plus p_days: how the purge reads its cutoff.
create function pg_temp.d(p_years int, p_days int default 0) returns date
language sql as $$
  select ((now() - make_interval(years => p_years)) at time zone 'UTC')::date + p_days
$$;

create function pg_temp.partition_exists(parent text, ts timestamptz) returns boolean
language sql as $$
  select to_regclass(format('partitions.%I', parent || '_p'
    || to_char(date_trunc('week', ts at time zone 'UTC'), 'YYYYMMDD'))) is not null
$$;

-- Settings -----------------------------------------------------------------------------

select is(internal.image_retention_days('{}'), 30, 'images default to 30 days');
select is(internal.image_retention_days('{"image_retention_days": 3}'), 7, 'images clamp up to 7');
select is(internal.image_retention_days('{"image_retention_days": 400}'), 90, 'and down to 90');
select is(internal.event_retention_months('{}'), 12, 'events default to 12 months');
select is(
  array[internal.event_retention_months('{"event_retention_months": 1}'),
        internal.event_retention_months('{"event_retention_months": 99}'),
        internal.event_retention_months('{"event_retention_months": "x"}')],
  array[3, 36, 12], 'events clamp to 3-36 and ignore non-numbers'
);
select is(internal.timesheet_retention_years('{}'), 3, 'timesheets default to 3 years');
select is(
  array[internal.timesheet_retention_years('{"timesheet_retention_years": 1}'),
        internal.timesheet_retention_years('{"timesheet_retention_years": 50}')],
  array[3, 10], 'timesheets never go below 3 years'
);

-- Fixtures --------------------------------------------------------------------------------

-- Partitions for the old weeks the rows below land in.
select internal.ensure_weekly_partitions(t, d, d)
from (values ('public.agent_events_raw'::regclass), ('public.activity_samples'::regclass)) tb (t),
     (values (now() - interval '13 months'), (now() - interval '7 months'), (now() - interval '2 months')) ds (d);

-- Raw events and activity samples: 13, 7 and 2 months old, in orgs 1 and 2.
insert into public.agent_events_raw (id, org_id, device_id, user_id, seq, type, at)
select gen_random_uuid(), o, d, u, s, 'heartbeat', now() - age
from (values (:org1::uuid, :dev1::uuid, :erin::uuid, 1, interval '13 months'), (:org1, :dev1, :erin, 2, interval '7 months'),
             (:org1, :dev1, :erin, 3, interval '2 months'), (:org2, :dev2, :u2, 1, interval '7 months'),
             (:org2, :dev2, :u2, 2, interval '2 months')) v (o, d, u, s, age);
insert into public.activity_samples (id, org_id, user_id, device_id, minute, app_name, seconds)
select gen_random_uuid(), o, u, d, date_trunc('minute', now() - age), 'Editor', 60
from (values (:org1::uuid, :dev1::uuid, :erin::uuid, interval '13 months'), (:org1, :dev1, :erin, interval '7 months'),
             (:org2, :dev2, :u2, interval '7 months'), (:org2, :dev2, :u2, interval '2 months')) v (o, d, u, age);

-- Check-ins. Files: org 1 at 31 days (expired) and 29 days (not), org 2 at 8 days
-- (expired, its limit is 7), org 3 at 60 days (kept, 1000 clamps to 90) and 91 days.
create function pg_temp.checkin(id text, org uuid, usr uuid, dev uuid, age interval, keys text[], purged boolean default false)
returns void language sql as $$
  insert into public.checkin_events (id, org_id, user_id, device_id, scheduled_at, outcome, object_keys, captures_purged_at)
  values (id::uuid, org, usr, dev, now() - age, (case when cardinality(keys) = 0 then 'miss' else 'pass' end)::public.checkin_outcome,
          keys, case when purged then now() end)
$$;
select pg_temp.checkin('00000000-0000-4000-8000-00000000f101', :org1, :erin, :dev1, interval '31 days', '{screen-1.webp,webcam.webp}');
select pg_temp.checkin('00000000-0000-4000-8000-00000000f102', :org1, :erin, :dev1, interval '29 days', '{screen-1.webp}');
select pg_temp.checkin('00000000-0000-4000-8000-00000000f103', :org2, :u2, :dev2, interval '8 days', '{screen-1.webp}');
select pg_temp.checkin('00000000-0000-4000-8000-00000000f104', :org3, :u3, :dev3, interval '60 days', '{screen-1.webp}');
select pg_temp.checkin('00000000-0000-4000-8000-00000000f105', :org3, :u3, :dev3, interval '91 days', '{screen-1.webp}');
-- Past the event window: one with files already deleted, one whose files are still there.
select pg_temp.checkin('00000000-0000-4000-8000-00000000f106', :org1, :erin, :dev1, interval '13 months', '{screen-1.webp}', true);
select pg_temp.checkin('00000000-0000-4000-8000-00000000f107', :org1, :erin, :dev1, interval '13 months', '{screen-1.webp}');
select pg_temp.checkin('00000000-0000-4000-8000-00000000f108', :org1, :erin, :dev1, interval '2 months', '{}');
-- A miss 7 months old: past org 2's 6 months, inside org 1's 12.
select pg_temp.checkin('00000000-0000-4000-8000-00000000f109', :org2, :u2, :dev2, interval '7 months', '{}');
select pg_temp.checkin('00000000-0000-4000-8000-00000000f10a', :org1, :erin, :dev1, interval '7 months', '{}');

-- Status periods: a closed one 13 months old (gone), an open one that old (kept).
insert into public.status_periods (org_id, user_id, status, start_at, end_at) values
  (:org1, :erin, 'idle', now() - interval '13 months', now() - interval '13 months' + interval '1 hour'),
  (:org1, :erin, 'active', now() - interval '13 months' + interval '2 hours', null);

-- Shift records: ended 4 years ago (gone, with its break) and 2 years ago (kept). Org 3
-- asked for 1 year, which clamps to 3, so its 2-year-old session stays too.
create temp table sessions (id uuid, org uuid, usr uuid, dev uuid, ended interval);
insert into sessions values
  ('00000000-0000-4000-8000-00000000a001', :org1, :erin, :dev1, interval '4 years'),
  ('00000000-0000-4000-8000-00000000a002', :org1, :erin, :dev1, interval '2 years'),
  ('00000000-0000-4000-8000-00000000a003', :org3, :u3, :dev3, interval '2 years');
insert into public.clock_sessions (id, org_id, user_id, device_id, start_at, end_at, start_event_id)
select id, org, usr, dev, now() - ended - interval '8 hours', now() - ended, gen_random_uuid() from sessions;
insert into public.breaks (org_id, user_id, clock_session_id, start_at, end_at)
select org, usr, id, now() - ended - interval '4 hours', now() - ended - interval '3 hours' from sessions where id = '00000000-0000-4000-8000-00000000a001';

-- Timesheet tables. The cutoff date is today minus the org's years; a day or week is
-- purged once it ended before the day before that (d(3, -1) is the last one kept).
-- Org 1: default 3 years. Org 2: 5 years. Org 3: asked for 1, which clamps to 3.
insert into public.time_segments (org_id, user_id, day, start_at, end_at, type, counted, flagged)
select org, usr, day, day::timestamptz + interval '10 hours', day::timestamptz + interval '11 hours',
  'verified', true, false
from (values (:org1::uuid, :erin::uuid, pg_temp.d(4)), (:org1, :erin, pg_temp.d(3, -2)),
             (:org1, :erin, pg_temp.d(3, -1)), (:org1, :erin, pg_temp.d(2)),
             (:org2, :u2, pg_temp.d(6)), (:org2, :u2, pg_temp.d(4)),
             (:org3, :u3, pg_temp.d(4)), (:org3, :u3, pg_temp.d(2))) v (org, usr, day);

insert into public.dirty_days (user_id, day) values
  (:erin, pg_temp.d(4)), (:erin, pg_temp.d(2)), (:u2, pg_temp.d(6)), (:u2, pg_temp.d(4))
on conflict do nothing;

-- A week is labelled by its start; ends 6 days later. The old ones are a draft and an
-- approved week: status makes no difference.
insert into public.timesheets (org_id, user_id, period_start, status)
select org, usr, ps, st
from (values (:org1::uuid, :erin::uuid, pg_temp.d(4), 'draft'), (:org1, :erin, pg_temp.d(3, -8), 'approved'),
             (:org1, :erin, pg_temp.d(3, -7), 'approved'), (:org1, :erin, pg_temp.d(2), 'submitted'),
             (:org2, :u2, pg_temp.d(6), 'approved'), (:org2, :u2, pg_temp.d(4), 'approved')) v (org, usr, ps, st);

insert into public.timesheet_edits (org_id, timesheet_id, user_id, kind, start_at, end_at, reason)
select t.org_id, t.id, t.user_id, 'exclude', t.period_start::timestamptz + interval '1 hour',
  t.period_start::timestamptz + interval '2 hours', 'retention fixture'
from public.timesheets t, generate_series(1, 2) g
where t.period_start in (pg_temp.d(4), pg_temp.d(3, -7), pg_temp.d(6));
insert into public.timesheet_edits (org_id, timesheet_id, user_id, kind, start_at, end_at, reason)
select t.org_id, t.id, t.user_id, 'exclude', t.period_start::timestamptz + interval '1 hour',
  t.period_start::timestamptz + interval '2 hours', 'retention fixture'
from public.timesheets t
where t.period_start = pg_temp.d(2);

-- Entries end 4 years ago, an hour before org 1's cutoff, an hour after it, 2 years ago.
insert into public.manual_entries (org_id, user_id, start_at, end_at, reason, status, decided_at)
select org, usr, e - interval '1 hour', e, label, st, case when st = 'pending' then null else now() end
from (values (:org1::uuid, :erin::uuid, now() - interval '4 years', 'a-4y-approved', 'approved'),
             (:org1, :erin, now() - interval '4 years', 'b-4y-pending', 'pending'),
             (:org1, :erin, now() - interval '3 years' - interval '1 hour', 'c-just-past', 'rejected'),
             (:org1, :erin, now() - interval '3 years' + interval '1 hour', 'd-just-inside', 'approved'),
             (:org1, :erin, now() - interval '2 years', 'e-2y', 'approved'),
             (:org2, :u2, now() - interval '6 years', 'f-6y', 'approved'),
             (:org2, :u2, now() - interval '4 years', 'g-4y', 'approved')) v (org, usr, e, label, st);

insert into public.reminders_sent (org_id, kind, user_id, period_start, recipient_id)
values (:org1, 'submit', :erin, pg_temp.d(4), :max), (:org1, 'submit', :erin, pg_temp.d(2), :max),
       (:org2, 'submit', :u2, pg_temp.d(6), :u2), (:org2, 'submit', :u2, pg_temp.d(4), :u2);

-- Notifications follow the events window: 12 months for orgs 1 and 3, 6 for org 2.
insert into public.notifications (org_id, user_id, kind, payload, created_at)
values (:org1, :erin, 'timesheet.returned', '{"k": "old"}', now() - interval '13 months'),
       (:org1, :erin, 'timesheet.returned', '{"k": "recent"}', now() - interval '2 months'),
       (:org2, :u2, 'timesheet.returned', '{"k": "old"}', now() - interval '7 months'),
       (:org2, :u2, 'timesheet.returned', '{"k": "recent"}', now() - interval '2 months'),
       (:org3, :u3, 'timesheet.returned', '{"k": "kept"}', now() - interval '7 months');

-- The audit log, with an entry far older than any retention.
insert into public.audit_log (org_id, action, metadata, at) values
  (:org1, 'member.invited', '{}', now() - interval '5 years');

select pg_temp.act_as_postgres();

-- Images --------------------------------------------------------------------------------------

select is(
  (select array_agg(checkin_id::text order by checkin_id::text) from public.retention_expired_captures(100)),
  array['00000000-0000-4000-8000-00000000f101', '00000000-0000-4000-8000-00000000f103',
        '00000000-0000-4000-8000-00000000f105', '00000000-0000-4000-8000-00000000f107'],
  'expired captures follow each org''s setting, clamped (not purged ones only)'
);
select is(
  (select paths from public.retention_expired_captures(100) where checkin_id = '00000000-0000-4000-8000-00000000f101'),
  array[format('%s/%s/%s/00000000-0000-4000-8000-00000000f101/screen-1.webp', :org1::text, :erin::text,
                 to_char(now() - interval '31 days', 'YYYY-MM-DD')),
        format('%s/%s/%s/00000000-0000-4000-8000-00000000f101/webcam.webp', :org1::text, :erin::text,
                 to_char(now() - interval '31 days', 'YYYY-MM-DD'))],
  'with the Storage paths of their files'
);
select is((select count(*)::int from public.retention_expired_captures(2)), 2, 'in batches');

select is(
  public.retention_mark_captures_purged(
    array['00000000-0000-4000-8000-00000000f101', '00000000-0000-4000-8000-00000000f103']::uuid[]),
  3::bigint, 'marking returns the number of files'
);
select is(
  (select count(*)::int from public.checkin_events where captures_purged_at is not null and id in
    ('00000000-0000-4000-8000-00000000f101', '00000000-0000-4000-8000-00000000f103')),
  2, 'the check-ins carry the purge time'
);
select is(
  (select count(*)::int from public.retention_expired_captures(100) where checkin_id in
    ('00000000-0000-4000-8000-00000000f101', '00000000-0000-4000-8000-00000000f103')),
  0, 'and are not listed again'
);
select is(
  (select jsonb_agg(jsonb_build_array(org_id, category, deleted) order by org_id)
   from public.retention_runs where category = 'captures'),
  jsonb_build_array(jsonb_build_array(:org1::uuid, 'captures', 2), jsonb_build_array(:org2::uuid, 'captures', 1)),
  'file counts are logged per org'
);
select is(
  (select metadata from public.audit_log where action = 'retention.purged' and org_id = :org2),
  '{"captures": 1}'::jsonb, 'and in the org''s audit log'
);

-- Viewing: purged captures are expired even inside the window.
select pg_temp.act_as(:erin);
select public.capture_view('00000000-0000-4000-8000-00000000f102');
create temp table seen as
  select (public.capture_view('00000000-0000-4000-8000-00000000f102') ->> 'expired')::boolean as recent;
select pg_temp.act_as_postgres();
select is((select recent from seen), false, 'a capture inside the window is not expired');
select public.retention_mark_captures_purged(array['00000000-0000-4000-8000-00000000f102']::uuid[]);
select pg_temp.act_as(:erin);
select is(
  (public.capture_view('00000000-0000-4000-8000-00000000f102') ->> 'expired')::boolean, true,
  'once purged it is expired, with its file names kept'
);
select is(
  public.capture_view('00000000-0000-4000-8000-00000000f102') -> 'objects' -> 0 ->> 'name', 'screen-1.webp',
  'names stay for the dashboard to label'
);
select pg_temp.act_as_postgres();

-- Rows ------------------------------------------------------------------------------------------

create temp table purged as select public.retention_purge_rows() as r;

select is(
  (select count(*)::int from public.agent_events_raw where org_id = :org2), 1,
  'org 2 (6 months): its 7-month-old events are deleted, the 2-month-old one stays'
);
select is(
  (select count(*)::int from public.agent_events_raw where org_id = :org1), 3,
  'org 1 is on the longest setting: its old events wait for the partitions job'
);
select is(
  (select count(*)::int from public.activity_samples where org_id = :org2), 1,
  'same for activity samples'
);
select is(
  (select array_agg(right(id::text, 4) order by id) from public.checkin_events where org_id = :org1),
  array['f101', 'f102', 'f107', 'f108', 'f10a'],
  'org 1: check-ins past 12 months go, unless their files are still in Storage'
);
select is(
  (select array_agg(right(id::text, 4) order by id) from public.checkin_events where org_id = :org2),
  array['f103'], 'org 2: the 7-month-old miss goes (6 months)'
);
select is(
  (select array_agg(status::text order by status) from public.status_periods where org_id = :org1),
  array['active'], 'status periods: closed ones past retention go, an open one stays'
);
select is(
  (select array_agg(right(id::text, 4) order by id) from public.clock_sessions),
  array['a002', 'a003'], 'shift records past 3 years go (org 3''s 1 year clamps to 3)'
);
select is((select count(*)::int from public.breaks), 0, 'with their breaks');
select is(
  (select r ->> 'clock_sessions' from purged), '1', 'the totals come back per category'
);
select is(
  (select deleted from public.retention_runs where org_id = :org1 and category = 'clock_sessions'),
  1::bigint, 'row counts are logged per org and category'
);
select is(
  (select metadata ->> 'agent_events_raw' from public.audit_log
   where action = 'retention.purged' and org_id = :org2 order by id desc limit 1),
  '1', 'and in the org''s audit log'
);

-- Timesheet tables (#130) -----------------------------------------------------------------------

select is(
  (select array_agg(day order by day) from public.time_segments where org_id = :org1),
  array[pg_temp.d(3, -1), pg_temp.d(2)],
  'segments: days over before the 3-year cutoff go, the last day inside it stays'
);
select is(
  (select array_agg(day) from public.time_segments where org_id = :org2),
  array[pg_temp.d(4)], 'org 2 keeps 5 years: its 4-year-old day stays, the 6-year-old goes'
);
select is(
  (select array_agg(day) from public.time_segments where org_id = :org3),
  array[pg_temp.d(2)], 'org 3 asked for 1 year, clamped to 3: its 4-year-old day goes'
);
select ok(
  not exists (select 1 from public.dirty_days where user_id = :erin and day < pg_temp.d(3, -1))
  and exists (select 1 from public.dirty_days where user_id = :erin and day = pg_temp.d(2)),
  'dirty days: old marks go, recent ones stay'
);
select ok(
  not exists (select 1 from public.dirty_days where user_id = :u2 and day = pg_temp.d(6))
  and exists (select 1 from public.dirty_days where user_id = :u2 and day = pg_temp.d(4)),
  'and by the org''s own setting'
);
select is(
  (select array_agg(period_start order by period_start) from public.timesheets where org_id = :org1),
  array[pg_temp.d(3, -7), pg_temp.d(2)],
  'timesheets: a week goes once it ended before the cutoff, draft or approved'
);
select is(
  (select array_agg(period_start) from public.timesheets where org_id = :org2),
  array[pg_temp.d(4)], 'org 2''s 4-year-old week stays (5 years)'
);
select is(
  (select count(*)::int from public.timesheet_edits where org_id = :org1), 3,
  'edits go with their timesheet (the two kept weeks keep theirs)'
);
select is(
  (select count(*)::int from public.timesheet_edits where org_id = :org2), 2,
  'org 2 keeps its 4-year-old week''s edit'
);
select is(
  (select array_agg(reason order by reason) from public.manual_entries where org_id = :org1),
  array['d-just-inside', 'e-2y'], 'manual entries go by end time, whatever their status'
);
select is(
  (select array_agg(reason) from public.manual_entries where org_id = :org2),
  array['g-4y'], 'org 2''s 4-year-old entry stays'
);
select is(
  (select array_agg(period_start) from public.reminders_sent where org_id = :org1),
  array[pg_temp.d(2)], 'reminders sent go with their week'
);
select is(
  (select array_agg(period_start) from public.reminders_sent where org_id = :org2),
  array[pg_temp.d(4)], 'by the org''s setting'
);
select is(
  (select array_agg(payload ->> 'k') from public.notifications where org_id = :org1),
  array['recent'], 'notifications follow the events window (12 months)'
);
select is(
  (select array_agg(payload ->> 'k') from public.notifications where org_id = :org2),
  array['recent'], 'org 2 on 6 months'
);
select is(
  (select array_agg(payload ->> 'k') from public.notifications where org_id = :org3),
  array['kept'], 'org 3 on the default 12: its 7-month-old one stays'
);
select is(
  (select jsonb_object_agg(category, deleted) from public.retention_runs
   where org_id = :org1 and category in ('time_segments', 'timesheets', 'timesheet_edits', 'manual_entries',
                                         'reminders_sent', 'notifications')),
  '{"time_segments": 2, "timesheets": 2, "timesheet_edits": 2, "manual_entries": 3,
    "reminders_sent": 1, "notifications": 1}'::jsonb,
  'org 1 counts are logged per category (children counted before their parents go)'
);
select is(
  (select jsonb_object_agg(category, deleted) from public.retention_runs
   where org_id = :org2 and category in ('time_segments', 'timesheets', 'timesheet_edits', 'manual_entries',
                                         'reminders_sent', 'notifications')),
  '{"time_segments": 1, "timesheets": 1, "timesheet_edits": 2, "manual_entries": 1,
    "reminders_sent": 1, "notifications": 1}'::jsonb,
  'org 2 counts too'
);
select is(
  (select jsonb_object_agg(category, deleted) from public.retention_runs
   where org_id = :org3 and category in ('time_segments', 'timesheets', 'timesheet_edits', 'manual_entries',
                                         'reminders_sent', 'notifications')),
  '{"time_segments": 1}'::jsonb, 'org 3 lost one segment and nothing else'
);
select ok(
  (select sum(deleted) from public.retention_runs where category = 'dirty_days') > 0,
  'dirty days are counted'
);
select is(
  (select metadata ->> 'timesheets' from public.audit_log
   where action = 'retention.purged' and org_id = :org2 order by id desc limit 1),
  '1', 'the org''s audit row carries the timesheet counts'
);
select is((select r ->> 'timesheets' from purged), '3', 'the totals include them');
select is(public.retention_purge_rows(), '{}'::jsonb, 'a second run finds nothing more');

-- The audit log is never purged -----------------------------------------------------------------

select is(
  (select count(*)::int from public.audit_log where action = 'member.invited' and at < now() - interval '4 years'),
  1, 'the 5-year-old audit row is still there'
);

-- Partitions ---------------------------------------------------------------------------------

-- Two upcoming weeks go missing; the job brings them back.
create function pg_temp.drop_partition(parent text, ts timestamptz) returns void
language plpgsql as $f$
begin
  execute format('drop table partitions.%I', parent || '_p'
    || to_char(date_trunc('week', ts at time zone 'UTC'), 'YYYYMMDD'));
end;
$f$;
select pg_temp.drop_partition('agent_events_raw', now() + interval '2 weeks');
select pg_temp.drop_partition('activity_samples', now() + interval '4 weeks');

select ok(
  pg_temp.partition_exists('agent_events_raw', now() - interval '13 months')
  and pg_temp.partition_exists('activity_samples', now() - interval '13 months'),
  'the 13-month-old weeks exist before the job'
);

-- Org 3 keeps 36 months: nothing may be dropped while an org still needs it.
update public.orgs set policy = '{"event_retention_months": 36}' where id = :org3;
create temp table first_run as select internal.maintain_partitions() as r;
select is((select r from first_run), '{"created": 2, "dropped": 0}'::jsonb,
  'two missing weeks created, nothing dropped while one org keeps 36 months');
select ok(pg_temp.partition_exists('agent_events_raw', now() - interval '13 months'),
  'the 13-month-old week is kept');

update public.orgs set policy = '{}' where id = :org3;
create temp table second_run as select internal.maintain_partitions() as r;
select is((select r from second_run), '{"created": 0, "dropped": 2}'::jsonb,
  'on the next run the expired weeks of both tables are dropped, nothing is created twice');

select ok(
  pg_temp.partition_exists('agent_events_raw', now() + interval '2 weeks')
  and pg_temp.partition_exists('activity_samples', now() + interval '4 weeks')
  and pg_temp.partition_exists('agent_events_raw', now() + interval '4 weeks'),
  'partitions exist up to four weeks ahead'
);
select ok(
  pg_temp.partition_exists('agent_events_raw', now()) and pg_temp.partition_exists('activity_samples', now())
  and pg_temp.partition_exists('agent_events_raw', now() - interval '7 days'),
  'the current and last weeks are kept'
);
select ok(
  not pg_temp.partition_exists('agent_events_raw', now() - interval '13 months')
  and not pg_temp.partition_exists('activity_samples', now() - interval '13 months'),
  'the expired weeks are gone'
);
select ok(
  pg_temp.partition_exists('agent_events_raw', now() - interval '7 months')
  and pg_temp.partition_exists('activity_samples', now() - interval '7 months')
  and pg_temp.partition_exists('agent_events_raw', now() - interval '2 months'),
  'weeks inside the longest retention are kept, even when a shorter org no longer needs them'
);
select is(
  (select count(*)::int from public.agent_events_raw where org_id = :org1), 2,
  'org 1''s 13-month-old event went with its week'
);
select is(
  (select deleted from public.retention_runs where org_id = :org1 and category = 'agent_events_raw'),
  1::bigint, 'rows dropped with a week are counted per org'
);
select is(
  (select deleted from public.retention_runs where org_id = :org1 and category = 'activity_samples'),
  1::bigint, 'for each table'
);
select is(
  (select array_agg(category || '=' || deleted order by category) from public.retention_runs where org_id is null),
  array['partitions_created=2', 'partitions_dropped=2'],
  'and the partitions themselves'
);
select is(
  (select count(*)::int from public.audit_log where action = 'member.invited' and at < now() - interval '4 years'),
  1, 'the audit log is still untouched'
);

-- Scheduling -------------------------------------------------------------------------------

select is(
  (select schedule from cron.job where jobname = 'retention'), '0 2 * * *', 'retention runs nightly at 02:00 UTC'
);
select ok(
  (select command like '%internal.invoke_retention_purge()%' from cron.job where jobname = 'retention'),
  'and calls the Edge Function'
);
select is(
  (select schedule from cron.job where jobname = 'partitions'), '0 3 * * 1', 'partitions runs weekly'
);
delete from vault.secrets where name in ('project_url', 'service_role_key');
select throws_ok(
  'select internal.invoke_retention_purge()', 'P0001',
  'vault secrets project_url and service_role_key are not set',
  'the call fails loudly without its Vault secrets'
);

-- Only the service role runs the job's RPCs.
select ok(
  has_function_privilege('service_role', 'public.retention_purge_rows()', 'execute')
  and has_function_privilege('service_role', 'public.retention_expired_captures(int)', 'execute')
  and has_function_privilege('service_role', 'public.retention_mark_captures_purged(uuid[])', 'execute'),
  'the service role can run the retention RPCs'
);
select ok(
  not (has_function_privilege('authenticated', 'public.retention_purge_rows()', 'execute')
    or has_function_privilege('anon', 'public.retention_purge_rows()', 'execute')
    or has_function_privilege('authenticated', 'public.retention_expired_captures(int)', 'execute')
    or has_function_privilege('authenticated', 'public.retention_mark_captures_purged(uuid[])', 'execute')),
  'and nobody else'
);

select * from finish();
rollback;
