-- #67: late clock-ins recorded (SHF-06), top apps (ACT-04), the managers' daily digest (ALR-03).
begin;
create extension if not exists pgtap with schema extensions;

select plan(63);

\set ada '''00000000-0000-4000-8000-0000000000a1'''
\set max '''00000000-0000-4000-8000-0000000000b1'''
\set erin '''00000000-0000-4000-8000-0000000000c1'''
\set lucas '''00000000-0000-4000-8000-0000000000c2'''
\set org '''00000000-0000-4000-8000-000000000001'''
\set dev_erin '''00000000-0000-4000-8000-0000000067d1'''
\set dev_lucas '''00000000-0000-4000-8000-0000000067d2'''
\set dev_max '''00000000-0000-4000-8000-0000000067d3'''

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

insert into public.devices (id, org_id, user_id, platform, os_version, agent_version, hardware_hash)
values
  (:dev_erin, :org, :erin, 'macos', '26.0', '0.1.0', 'hash-erin-67'),
  (:dev_lucas, :org, :lucas, 'macos', '26.0', '0.1.0', 'hash-lucas-67'),
  (:dev_max, :org, :max, 'macos', '26.0', '0.1.0', 'hash-max-67');

-- A closed clock session.
create function pg_temp.session(who uuid, from_at timestamptz, to_at timestamptz) returns uuid
language sql as $$
  insert into public.clock_sessions (org_id, user_id, device_id, start_at, end_at, start_event_id)
  values ('00000000-0000-4000-8000-000000000001', who,
          case who when '00000000-0000-4000-8000-0000000000c1' then '00000000-0000-4000-8000-0000000067d1'::uuid
                   when '00000000-0000-4000-8000-0000000000c2' then '00000000-0000-4000-8000-0000000067d2'::uuid
                   else '00000000-0000-4000-8000-0000000067d3'::uuid end,
          from_at, to_at, gen_random_uuid())
  returning id
$$;

create function pg_temp.late(who uuid) returns int
language sql as $$
  select count(*)::int from public.late_clock_ins where user_id = who
$$;

create function pg_temp.reset_late() returns void
language sql as $$
  delete from public.clock_sessions;
  delete from public.late_clock_ins;
  update public.orgs set policy = '{}' where id = '00000000-0000-4000-8000-000000000001';
$$;

-- Late clock-ins (SHF-06) ------------------------------------------------------------------------
-- Seed shifts: Erin Mon-Fri 09:00-17:00 Los Angeles (PDT, -07, in mid March 2026); Lucas
-- Mon-Thu 22:00-06:00 Chicago (CDT, -05). Tuesday 17 March 2026.

select pg_temp.reset_late();
select pg_temp.session(:erin, '2026-03-17 09:10:00-07', '2026-03-17 12:00:00-07');
select is(pg_temp.late(:erin), 0, 'late: 10 minutes after the shift start is inside the 15 minute grace');

select pg_temp.reset_late();
select pg_temp.session(:erin, '2026-03-17 09:20:00-07', '2026-03-17 12:00:00-07');
select is(pg_temp.late(:erin), 1, 'late: 20 minutes after the start is recorded');
select results_eq(
  $$ select day::text, shift_start, clocked_in_at, late_s, grace_min from public.late_clock_ins $$,
  $$ values ('2026-03-17', '2026-03-17 16:00:00+00'::timestamptz, '2026-03-17 16:20:00+00'::timestamptz, 1200, 15) $$,
  'late: with the shift''s local day, its start, the clock-in, the seconds late and the grace');

select pg_temp.session(:erin, '2026-03-17 13:00:00-07', '2026-03-17 16:00:00-07');
select is(pg_temp.late(:erin), 1, 'late: a second session in the same shift is not another late clock-in');

select pg_temp.reset_late();
select pg_temp.session(:erin, '2026-03-17 10:00:00-07', '2026-03-17 12:00:00-07');
select pg_temp.session(:erin, '2026-03-17 09:30:00-07', '2026-03-17 09:50:00-07');
select is((select clocked_in_at from public.late_clock_ins where user_id = :erin),
  '2026-03-17 09:30:00-07'::timestamptz, 'late: sessions synced out of order keep the first clock-in');
select is((select late_s from public.late_clock_ins where user_id = :erin), 1800, '(30 minutes late)');

select pg_temp.reset_late();
select pg_temp.session(:erin, '2026-03-17 09:40:00-07', '2026-03-17 12:00:00-07');
select pg_temp.session(:erin, '2026-03-17 08:55:00-07', '2026-03-17 09:30:00-07');
select is(pg_temp.late(:erin), 0, 'late: a session synced later that covered the start clears it');

select pg_temp.reset_late();
select pg_temp.session(:erin, '2026-03-17 08:00:00-07', '2026-03-17 12:00:00-07');
select pg_temp.session(:erin, '2026-03-17 13:00:00-07', '2026-03-17 16:00:00-07');
select is(pg_temp.late(:erin), 0, 'late: clocked in before the shift started: on time');

select pg_temp.reset_late();
update public.orgs set policy = '{"late_clock_in_min": 45}' where id = :org;
select pg_temp.session(:erin, '2026-03-17 09:30:00-07', '2026-03-17 12:00:00-07');
select is(pg_temp.late(:erin), 0, 'late: the grace is the org''s late_clock_in_min (45)');
select pg_temp.session(:erin, '2026-03-18 09:50:00-07', '2026-03-18 12:00:00-07');
select is((select grace_min from public.late_clock_ins where user_id = :erin), 45, 'late: 50 minutes is late with a 45 minute grace');

select pg_temp.reset_late();
update public.orgs set policy = '{"late_clock_in_min": 1}' where id = :org;
select pg_temp.session(:erin, '2026-03-17 09:04:00-07', '2026-03-17 12:00:00-07');
select is(pg_temp.late(:erin), 0, 'late: the grace is clamped to 5..60 (1 reads as 5)');

select pg_temp.reset_late();
select pg_temp.session(:erin, '2026-03-21 10:00:00-07', '2026-03-21 12:00:00-07');
select is(pg_temp.late(:erin), 0, 'late: no shift on a Saturday, nothing to be late for');
select pg_temp.session(:erin, '2026-03-17 17:30:00-07', '2026-03-17 18:00:00-07');
select is(pg_temp.late(:erin), 0, 'late: clocking in after the shift ended is not a late clock-in');

select pg_temp.reset_late();
select pg_temp.session(:lucas, '2026-03-17 23:00:00-05', '2026-03-18 05:00:00-05');
select results_eq(
  $$ select day::text, late_s from public.late_clock_ins where user_id = '00000000-0000-4000-8000-0000000000c2' $$,
  $$ values ('2026-03-17', 3600) $$,
  'late: a night shift belongs to the day it starts on');

select pg_temp.reset_late();
select pg_temp.session(:erin, '2026-03-17 09:20:00-07', '2026-03-17 12:00:00-07');
update public.shifts set start_time = '10:00' where user_id = :erin;
select is(pg_temp.late(:erin), 1, 'late: editing the shift afterwards does not rewrite the record');
update public.shifts set start_time = '09:00' where user_id = :erin;

-- Who reads them.
select pg_temp.act_as(:erin);
select is((select count(*)::int from public.late_clock_ins), 1, 'late rls: the employee reads her own');
select pg_temp.act_as(:max);
select is((select count(*)::int from public.late_clock_ins where user_id = :erin), 1, 'late rls: her manager reads it');
select pg_temp.act_as(:lucas);
select is((select count(*)::int from public.late_clock_ins), 0, 'late rls: a colleague does not');
select throws_ok($$ insert into public.late_clock_ins (org_id, user_id, clock_session_id, day, shift_start, clocked_in_at, late_s, grace_min)
  select org_id, user_id, clock_session_id, day, shift_start, clocked_in_at, late_s, grace_min from public.late_clock_ins $$,
  '42501', null, 'late rls: nobody writes them through the API');
select pg_temp.act_as_postgres();

delete from public.clock_sessions where user_id = :erin;
select is(pg_temp.late(:erin), 0, 'late: deleting the session (retention, data deletion) deletes the record');

-- Top apps (ACT-04) ---------------------------------------------------------------------------------

insert into public.activity_samples (id, org_id, user_id, device_id, minute, app_name, window_title, domain, seconds)
select gen_random_uuid(), :org, :erin, :dev_erin,
       date_trunc('minute', now() - interval '30 minutes') + make_interval(mins => n), app, title, domain, secs
from (values
  (0, 'VS Code', 'main.rs', null, 60),
  (1, 'VS Code', 'lib.rs', null, 45),
  (2, 'Chrome', 'Jira', 'jira.example.com', 30),
  (3, 'Chrome', 'Docs', 'docs.example.com', 20),
  (4, 'Slack', null, null, 50),
  (5, 'Zoom', null, null, 10)
) as v (n, app, title, domain, secs);

select pg_temp.act_as(:erin);
select is(
  (select jsonb_agg(jsonb_build_object('app', app_name, 'seconds', seconds))
   from public.top_apps(:erin, now() - interval '1 hour', now())),
  '[{"app": "VS Code", "seconds": 105}, {"app": "Chrome", "seconds": 50}, {"app": "Slack", "seconds": 50}, {"app": "Zoom", "seconds": 10}]'::jsonb,
  'top apps: seconds per app name (domains added together), most first, ties by name');
select is((select count(*)::int from public.top_apps(:erin, now() - interval '1 hour', now(), 2)), 2,
  'top apps: the top N');
select is((select count(*)::int from public.top_apps(:erin, now() - interval '1 hour', now(), 500)), 4,
  'top apps: N is capped (20), never more than there is');
select is((select count(*)::int from public.top_apps(:erin, now() - interval '3 hours', now() - interval '2 hours')), 0,
  'top apps: only the span asked for');
select throws_ok($$ select * from public.top_apps('00000000-0000-4000-8000-0000000000c1', now(), now() - interval '1 hour') $$,
  '22023', 'invalid_range', 'top apps: an empty span is refused');
select throws_ok($$ select * from public.top_apps('00000000-0000-4000-8000-0000000000c1', now() - interval '40 days', now()) $$,
  '22023', 'invalid_range', 'top apps: at most 31 days');

select pg_temp.act_as(:max);
select is((select count(*)::int from public.top_apps(:erin, now() - interval '1 hour', now())), 4,
  'top apps: her manager sees them');
select pg_temp.act_as(:lucas);
select is((select count(*)::int from public.top_apps(:erin, now() - interval '1 hour', now())), 0,
  'top apps: a colleague gets nothing');

select pg_temp.act_as_postgres();
update public.orgs set policy = '{"activity_sampling": false}' where id = :org;
select pg_temp.act_as(:max);
select is((select count(*)::int from public.top_apps(:erin, now() - interval '1 hour', now())), 0,
  'top apps: nothing while activity sampling is off');
select pg_temp.act_as(:erin);
select is((select count(*)::int from public.top_apps(:erin, now() - interval '1 hour', now())), 0,
  '(for her too)');
select pg_temp.act_as_postgres();
update public.orgs set policy = '{}' where id = :org;
delete from public.notice_acks where user_id = :erin;
select pg_temp.act_as(:max);
select is((select count(*)::int from public.top_apps(:erin, now() - interval '1 hour', now())), 0,
  'top apps: nothing before she acknowledged a notice (effective collection is off)');
select pg_temp.act_as_postgres();
insert into public.notice_acks (user_id, notice_id)
select :erin, n.id from public.notices n where n.org_id = :org and n.version = 1;

-- Daily digest (ALR-03) ------------------------------------------------------------------------------
-- About Tuesday 17 March 2026. Max (Chicago, -05) manages Erin (Los Angeles, -07) and
-- Lucas (Chicago); Ada (New York, -04) manages Max.

select ok(exists (select 1 from cron.job where jobname = 'digest' and schedule = '*/15 * * * *'),
  'cron: the digest job runs every 15 minutes');

delete from public.time_segments;
delete from public.checkin_events;
insert into public.time_segments (org_id, user_id, day, start_at, end_at, type, counted, flagged, excluded)
values
  (:org, :erin, '2026-03-17', '2026-03-17 09:20:00-07', '2026-03-17 12:20:00-07', 'verified', true, false, false),
  (:org, :erin, '2026-03-17', '2026-03-17 12:20:00-07', '2026-03-17 12:50:00-07', 'unverified', true, true, false),
  (:org, :erin, '2026-03-17', '2026-03-17 13:00:00-07', '2026-03-17 13:20:00-07', 'unverified', true, true, true),
  (:org, :erin, '2026-03-17', '2026-03-17 13:20:00-07', '2026-03-17 13:30:00-07', 'break', false, false, false),
  (:org, :erin, '2026-03-16', '2026-03-16 09:00:00-07', '2026-03-16 12:00:00-07', 'verified', true, false, false);
insert into public.checkin_events (id, org_id, user_id, device_id, scheduled_at, shown_at, outcome)
values
  -- 23:30 PDT on the 17th: Erin's 17th.
  (gen_random_uuid(), :org, :erin, :dev_erin, '2026-03-18 06:30:00+00', '2026-03-18 06:30:00+00', 'miss'),
  -- 23:30 PDT on the 16th: not the 17th.
  (gen_random_uuid(), :org, :erin, :dev_erin, '2026-03-17 06:30:00+00', '2026-03-17 06:30:00+00', 'miss'),
  (gen_random_uuid(), :org, :erin, :dev_erin, '2026-03-17 17:00:00+00', '2026-03-17 17:00:00+00', 'pass'),
  -- 23:30 CDT on the 17th: Lucas's 17th.
  (gen_random_uuid(), :org, :lucas, :dev_lucas, '2026-03-18 04:30:00+00', '2026-03-18 04:30:00+00', 'miss');
delete from public.clock_sessions;
select pg_temp.session(:erin, '2026-03-17 09:20:00-07', '2026-03-17 13:30:00-07');
-- The inserts above queue the days for a rebuild; these segments are the final ones.
delete from public.dirty_days;

create function pg_temp.reset_digest() returns void
language sql as $$
  delete from public.digests_sent;
  delete from public.email_outbox;
  delete from public.notification_prefs;
  delete from public.delegations;
  update public.users set active = true;
$$;

create function pg_temp.digests(addr text) returns int
language sql as $$
  select count(*)::int from public.email_outbox where to_email = addr and template = 'digest'
$$;

select pg_temp.reset_digest();
select is(internal.digest_eval('2026-03-18 13:59:00+00'), 0, 'digest: nothing before 09:00 in the manager''s zone (08:59 Chicago)');
select is(pg_temp.digests('manager@acme.test'), 0, '(no mail for Max)');
select is(
  (select (email_id is null)::text from public.digests_sent where recipient_id = :ada and day = '2026-03-17'),
  'true', 'digest: Ada (09:59 New York) had nothing to report about Max: no mail, the day is marked done');
select is(pg_temp.digests('admin@acme.test'), 0, '(no mail for Ada)');

select is(internal.digest_eval('2026-03-18 14:00:00+00'), 1, 'digest: at 09:00 in Chicago Max''s digest is queued');
select is(pg_temp.digests('manager@acme.test'), 1, 'digest: one email to Max');
select is(
  (select payload -> 'reports' from public.email_outbox where to_email = 'manager@acme.test'),
  jsonb_build_array(
    jsonb_build_object('user_id', :erin, 'full_name', 'Erin Employee', 'worked_s', 12600,
      'flagged_s', 1800, 'misses', 1, 'late_clock_ins', 1),
    jsonb_build_object('user_id', :lucas, 'full_name', 'Lucas Martin', 'worked_s', 0,
      'flagged_s', 0, 'misses', 1, 'late_clock_ins', 0)),
  'digest: per report, by name: raw seconds worked and flagged (excluded time in neither), misses and late clock-ins on each report''s own local day');
select is(
  (select payload ->> 'day' || ' ' || (payload ->> 'recipient_name') || ' ' || (payload ->> 'recipient_timezone')
   from public.email_outbox where to_email = 'manager@acme.test'),
  '2026-03-17 Max Manager America/Chicago', 'digest: the payload names the day and the recipient');
select is(
  (select (send_after = created_at and sent_at is null and batch_key = 'digest:' || :max || ':2026-03-17')::text
   from public.email_outbox where to_email = 'manager@acme.test'),
  'true', 'digest: due at once for the send_emails job');
select is(internal.digest_eval('2026-03-18 14:15:00+00'), 0, 'digest: the next run queues nothing');
select is(internal.digest_eval('2026-03-18 20:00:00+00'), 0, '(nor later that day)');
select is((select count(*)::int from public.digests_sent where recipient_id = :max), 1, 'digest: one a day');
select is(pg_temp.digests('erin@acme.test') + pg_temp.digests('lucas@acme.test'), 0,
  'digest: people without reports get none');

select is(internal.digest_eval('2026-03-19 14:00:00+00'), 0,
  'digest: the next day (Wednesday 18th) had nothing for anyone: no mail');

-- Opt-out.
select pg_temp.reset_digest();
select pg_temp.act_as(:max);
select is(public.set_daily_digest(false), false, 'opt-out: a manager turns the digest off');
select is((select daily_digest from public.notification_prefs), false, 'opt-out: and reads their own setting');
select pg_temp.act_as(:erin);
select is((select count(*)::int from public.notification_prefs), 0, 'opt-out: nobody reads someone else''s');
select throws_ok($$ update public.notification_prefs set daily_digest = true $$, '42501', null,
  'opt-out: written only through set_daily_digest');
select pg_temp.act_as_postgres();
select internal.digest_eval('2026-03-18 14:00:00+00');
select is(pg_temp.digests('manager@acme.test'), 0, 'opt-out: no digest while it is off');
select pg_temp.act_as(:max);
select public.set_daily_digest(true);
select pg_temp.act_as_postgres();
select internal.digest_eval('2026-03-18 14:15:00+00');
select is(pg_temp.digests('manager@acme.test'), 1, 'opt-out: on again, it comes');

-- Deactivated people.
select pg_temp.reset_digest();
update public.users set active = false where id = :max;
select internal.digest_eval('2026-03-18 14:00:00+00');
select is(pg_temp.digests('manager@acme.test'), 0, 'deactivated: a deactivated manager gets nothing');
update public.users set active = true where id = :max;
update public.users set active = false where id in (:lucas);
delete from public.checkin_events where user_id = :lucas;
select internal.digest_eval('2026-03-18 14:00:00+00');
select is(
  (select jsonb_agg(r ->> 'full_name') from public.email_outbox o, jsonb_array_elements(o.payload -> 'reports') r
   where o.to_email = 'manager@acme.test'),
  '["Erin Employee"]'::jsonb, 'deactivated: a deactivated report with nothing that day is left out');
insert into public.checkin_events (id, org_id, user_id, device_id, scheduled_at, shown_at, outcome)
values (gen_random_uuid(), :org, :lucas, :dev_lucas, '2026-03-18 04:30:00+00', '2026-03-18 04:30:00+00', 'miss');
delete from public.dirty_days;

-- Late in the day, and waiting for fresh numbers.
select pg_temp.reset_digest();
select internal.digest_eval('2026-03-18 23:00:00+00');
select is(pg_temp.digests('manager@acme.test'), 0, 'window: not sent at 18:00 or later (a job that was down skips the day)');
insert into public.dirty_days (user_id, day) values (:erin, '2026-03-17');
select internal.digest_eval('2026-03-18 14:00:00+00');
select is(pg_temp.digests('manager@acme.test'), 0, 'fresh: a report''s day still waiting for its rebuild holds the digest');
select internal.digest_eval('2026-03-18 15:45:00+00');
select is(pg_temp.digests('manager@acme.test'), 0, '(for up to two hours)');
select internal.digest_eval('2026-03-18 16:00:00+00');
select is(pg_temp.digests('manager@acme.test'), 1, 'fresh: then it goes with what is stored');
delete from public.dirty_days;

-- Delegates do not get it; a manager's own digest lists only their direct reports.
select pg_temp.reset_digest();
insert into public.delegations (org_id, manager_id, delegate_id, starts_on, ends_on)
values (:org, :max, :ada, '2026-03-10', '2026-03-31');
insert into public.time_segments (org_id, user_id, day, start_at, end_at, type, counted, flagged, excluded)
values (:org, :max, '2026-03-17', '2026-03-17 09:00:00-05', '2026-03-17 10:00:00-05', 'verified', true, false, false);
select internal.digest_eval('2026-03-18 14:00:00+00');
select is(
  (select jsonb_agg(r ->> 'full_name') from public.email_outbox o, jsonb_array_elements(o.payload -> 'reports') r
   where o.to_email = 'admin@acme.test'),
  '["Max Manager"]'::jsonb, 'delegation: Ada, Max''s delegate, gets only her own direct report (Max), not Max''s team');
select is(pg_temp.digests('admin@acme.test'), 1, '(one digest)');

-- A deleted person's numbers leave the digests that list them.
select lives_ok($$ delete from public.users where id = '00000000-0000-4000-8000-0000000000c2' $$,
  'deletion: the users row goes');
select is(
  (select jsonb_agg(r ->> 'full_name') from public.email_outbox o, jsonb_array_elements(o.payload -> 'reports') r
   where o.to_email = 'manager@acme.test'),
  null, 'deletion: the digest listing them is removed with them');
select is(pg_temp.digests('admin@acme.test'), 1, 'deletion: digests that do not list them stay');

select * from finish();
rollback;
