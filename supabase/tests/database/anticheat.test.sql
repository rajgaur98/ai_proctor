begin;
create extension if not exists pgtap with schema extensions;

select plan(85);

\set erin '''00000000-0000-4000-8000-0000000000c1'''
\set lucas '''00000000-0000-4000-8000-0000000000c2'''
\set max '''00000000-0000-4000-8000-0000000000b1'''
\set ada '''00000000-0000-4000-8000-0000000000a1'''
\set org '''00000000-0000-4000-8000-000000000001'''
\set org2 '''00000000-0000-4000-8000-000000000002'''
\set olga '''00000000-0000-4000-8000-0000000000a9'''
\set oscar '''00000000-0000-4000-8000-0000000000c9'''
\set d1 '''00000000-0000-4000-8000-0000000000d1'''
\set d2 '''00000000-0000-4000-8000-0000000000d2'''

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

-- Clean slate between scenarios: no flags, no check-ins, default policy.
create function pg_temp.reset() returns void
language sql as $$
  delete from public.anticheat_flags;
  delete from public.checkin_events;
  update public.orgs set policy = '{}' where id = '00000000-0000-4000-8000-000000000001';
$$;

create function pg_temp.policy(p jsonb) returns void
language sql as $$
  update public.orgs set policy = p where id = '00000000-0000-4000-8000-000000000001'
$$;

-- A check-in for `who` scheduled at `at`.
create function pg_temp.ci(
  who uuid, at timestamptz, ms int, o public.checkin_outcome default 'pass', fl text[] default '{}'
) returns uuid
language sql as $$
  insert into public.checkin_events (
    id, org_id, user_id, device_id, scheduled_at, shown_at, responded_at, outcome, response_ms, flags
  )
  values (gen_random_uuid(), '00000000-0000-4000-8000-000000000001', who,
          (select d.id from public.devices d where d.user_id = who limit 1),
          at, at, case when ms is null then null else at + make_interval(secs => ms / 1000.0) end,
          o, ms, fl)
  returning id
$$;

-- Erin's passes on 2026-03-10 (a Tuesday, Pacific daylight time, UTC-7) at 11:00 local
-- plus a minute apiece, with the given response times.
create function pg_temp.erin_day(variadic ms int[]) returns void
language plpgsql as $$
declare
  i int;
begin
  for i in 1 .. array_length(ms, 1) loop
    perform pg_temp.ci('00000000-0000-4000-8000-0000000000c1',
      timestamptz '2026-03-10 18:00:00+00' + make_interval(mins => i), ms[i]);
  end loop;
end;
$$;

create function pg_temp.flags(k public.anticheat_kind default null, who uuid default '00000000-0000-4000-8000-0000000000c1')
returns int
language sql as $$
  select count(*)::int from public.anticheat_flags where user_id = who and (k is null or kind = k)
$$;

insert into public.devices (id, org_id, user_id, platform, os_version, agent_version, hardware_hash)
values (:d1, :org, :erin, 'windows', '11', '0.1.0', 'hash-erin-anticheat'),
       (:d2, :org, :lucas, 'windows', '11', '0.1.0', 'hash-lucas-anticheat');

insert into public.orgs (id, name) values (:org2, 'Other Co');
insert into auth.users (id, email) values (:olga, 'olga@other.test'), (:oscar, 'oscar@other.test');
insert into public.users (id, org_id, full_name, email, role, manager_id) values
  (:olga, :org2, 'Olga Owner', 'olga@other.test', 'owner', null),
  (:oscar, :org2, 'Oscar Employee', 'oscar@other.test', 'employee', :olga);

-- Policy helper ----------------------------------------------------------------------------

select is(internal.anticheat_policy_num('{}', 'anticheat_max_cv', 0.1, 0.01, 0.5), 0.1, 'a missing number is the default');
select is(internal.anticheat_policy_num('{"anticheat_max_cv": 3}', 'anticheat_max_cv', 0.1, 0.01, 0.5), 0.5, 'above the range is clamped');
select is(internal.anticheat_policy_num('{"anticheat_max_cv": 0}', 'anticheat_max_cv', 0.1, 0.01, 0.5), 0.01, 'below the range is clamped');
select is(internal.anticheat_policy_num('{"anticheat_max_cv": "low"}', 'anticheat_max_cv', 0.1, 0.01, 0.5), 0.1, 'a value that is not a number is the default');
select is(internal.anticheat_policy_num('{"anticheat_max_cv": 0.25}', 'anticheat_max_cv', 0.1, 0.01, 0.5), 0.25, 'a value in range is used');

select ok(
  exists (select 1 from cron.job where jobname = 'anticheat_daily' and schedule = '30 3 * * *'),
  'the daily job is scheduled at 03:30 UTC');

-- ANT-04: fast responses -----------------------------------------------------------------------

select pg_temp.reset();
select pg_temp.erin_day(250, 299, 4000);
select pg_temp.ci(:erin, timestamptz '2026-03-10 19:00:00+00', 100, 'failed');
select pg_temp.ci(:lucas, timestamptz '2026-03-10 19:00:00+00', 5000);
select is(internal.anticheat_eval('2026-03-10'), 1, 'one employee has fast passes');
select results_eq(
  $$ select user_id, day, kind, details ->> 'count', details ->> 'min_response_ms', details ->> 'threshold_ms',
            jsonb_array_length(details -> 'checkin_ids')
     from public.anticheat_flags $$,
  $$ values ('00000000-0000-4000-8000-0000000000c1'::uuid, date '2026-03-10', 'fast_response'::public.anticheat_kind,
             '2', '250', '300', 2) $$,
  'under 300 ms flags the day with the count and the fastest time (a failed check-in does not count)');
select results_eq(
  $$ select (select response_ms from public.checkin_events where id = (details -> 'checkin_ids' ->> 0)::uuid),
            (select response_ms from public.checkin_events where id = (details -> 'checkin_ids' ->> 1)::uuid)
     from public.anticheat_flags $$,
  $$ values (250, 299) $$,
  'the fast check-ins are listed, fastest first');
select is(pg_temp.flags(null, :lucas), 0, 'an employee answering in 5 s is not flagged');
select is((select org_id from public.anticheat_flags limit 1), :org::uuid, 'the flag carries the org');
select ok((select reviewed_at is null and reviewed_by is null and review_note is null from public.anticheat_flags),
  'a new flag is unreviewed');

select pg_temp.reset();
select pg_temp.erin_day(300, 301, 4000);
select pg_temp.ci(:erin, timestamptz '2026-03-10 19:00:00+00', null, 'miss');
select is(internal.anticheat_eval('2026-03-10'), 0, 'exactly 300 ms is not under 300 ms, and a miss has no response time');
select is(pg_temp.flags(), 0, 'nothing is stored');

-- Local days ---------------------------------------------------------------------------------

select pg_temp.reset();
select pg_temp.ci(:erin, timestamptz '2026-03-11 06:59:59+00', 200);
select is(internal.anticheat_eval('2026-03-10'), 1, '23:59:59 Pacific is still the 10th');
select pg_temp.reset();
select pg_temp.ci(:erin, timestamptz '2026-03-11 07:00:00+00', 200);
select is(internal.anticheat_eval('2026-03-10'), 0, 'midnight Pacific is the 11th, not the 10th');
select is(internal.anticheat_eval('2026-03-11'), 1, 'and the 11th has it');
select is((select day from public.anticheat_flags), date '2026-03-11', 'the flag is on the local day');

-- With no day given, each employee's previous local day: at 12:00 UTC on the 11th it is
-- the morning of the 11th in Pacific time, so the 10th.
select pg_temp.reset();
select pg_temp.ci(:erin, timestamptz '2026-03-10 18:00:00+00', 200);
select pg_temp.ci(:lucas, timestamptz '2026-03-10 18:00:00+00', 200);
select is(internal.anticheat_eval(null, timestamptz '2026-03-11 12:00:00+00'), 2, 'the previous local day is evaluated for everyone');
select is((select string_agg(distinct day::text, ',') from public.anticheat_flags), '2026-03-10', 'it is the 10th');
-- At 03:30 UTC on the 11th it is still the evening of the 10th in Texas: yesterday is the 9th.
select pg_temp.reset();
select pg_temp.ci(:erin, timestamptz '2026-03-10 18:00:00+00', 200);
select pg_temp.ci(:erin, timestamptz '2026-03-09 18:00:00+00', 200);
select is(internal.anticheat_eval(null, timestamptz '2026-03-11 03:30:00+00'), 1, 'the evening of the 10th is not over yet in the US');
select is((select string_agg(day::text, ',') from public.anticheat_flags), '2026-03-09', 'so the 9th is the one evaluated');

-- Idempotency and refresh ----------------------------------------------------------------------

select pg_temp.reset();
select pg_temp.erin_day(250);
select is(internal.anticheat_eval('2026-03-10'), 1, 'first run flags it');
select is(internal.anticheat_eval('2026-03-10'), 0, 'a second run adds nothing');
select is(pg_temp.flags(), 1, 'one row per employee, day and kind');
select pg_temp.erin_day(260);
select is(internal.anticheat_eval('2026-03-10'), 0, 'a late check-in refreshes the flag without making a new one');
select is((select (details ->> 'count')::int from public.anticheat_flags), 2, 'the refreshed count');
update public.anticheat_flags set reviewed_at = now(), reviewed_by = :max, review_note = 'fine';
select pg_temp.erin_day(270);
select internal.anticheat_eval('2026-03-10');
select results_eq(
  $$ select (details ->> 'count')::int, review_note from public.anticheat_flags $$,
  $$ values (2, 'fine') $$,
  'a reviewed flag is left as the manager saw it');

-- ANT-04: low variance --------------------------------------------------------------------------

select pg_temp.reset();
select pg_temp.erin_day(4000, 4100, 3900, 4050, 3950);
select is(internal.anticheat_eval('2026-03-10'), 1, 'five very even passes are flagged');
select results_eq(
  $$ select kind, details ->> 'passes', details ->> 'mean_ms', details ->> 'stddev_ms', details ->> 'cv',
            details ->> 'min_passes', details ->> 'max_cv'
     from public.anticheat_flags $$,
  $$ values ('low_variance'::public.anticheat_kind, '5', '4000', '79', '0.0198', '5', '0.1') $$,
  'with the numbers behind it (coefficient of variation 0.0198 against the 0.1 limit)');
select is(pg_temp.flags('fast_response'), 0, 'slow and even is not a fast response');

select pg_temp.reset();
select pg_temp.erin_day(4000, 4100, 3900, 4050);
select is(internal.anticheat_eval('2026-03-10'), 0, 'four passes are below the default of five');

select pg_temp.reset();
select pg_temp.erin_day(1000, 5000, 2000, 8000, 3000);
select is(internal.anticheat_eval('2026-03-10'), 0, 'varied responses are fine');

select pg_temp.reset();
select pg_temp.erin_day(4000, 4000, 4000, 4000, 4000);
select is(internal.anticheat_eval('2026-03-10'), 1, 'identical responses (no spread at all) are flagged');
select is((select details ->> 'cv' from public.anticheat_flags), '0.0000', 'with a coefficient of variation of zero');

select pg_temp.reset();
select pg_temp.erin_day(4000, 4100, 3900);
select pg_temp.policy('{"anticheat_min_passes": 3}');
select is(internal.anticheat_eval('2026-03-10'), 1, 'N is a policy key: three passes are enough when it is 3');
select pg_temp.reset();
select pg_temp.erin_day(4000, 4000);
select pg_temp.policy('{"anticheat_min_passes": 1}');
select is(internal.anticheat_eval('2026-03-10'), 0, 'N is clamped to at least 3: two passes say nothing');

select pg_temp.reset();
select pg_temp.erin_day(4000, 4100, 3900, 4050, 3950);
select pg_temp.policy('{"anticheat_max_cv": 0.01}');
select is(internal.anticheat_eval('2026-03-10'), 0, 'the limit is a policy key: 0.0198 is above 0.01');
select pg_temp.reset();
select pg_temp.erin_day(3000, 4000, 5000, 3500, 4500);
select is(internal.anticheat_eval('2026-03-10'), 0, 'a coefficient of variation of 0.2 is above the default limit');
select pg_temp.policy('{"anticheat_max_cv": 0.25}');
select is(internal.anticheat_eval('2026-03-10'), 1, 'and below a limit of 0.25');
select pg_temp.reset();
select pg_temp.erin_day(1000, 5000, 2000, 8000, 3000);
select pg_temp.policy('{"anticheat_max_cv": 9}');
select is(internal.anticheat_eval('2026-03-10'), 0, 'the limit is clamped to at most 0.5: a spread of 0.75 is never flagged');

select pg_temp.reset();
select pg_temp.erin_day(100, 100, 100, 100, 100);
select is(internal.anticheat_eval('2026-03-10'), 2, 'five passes of 100 ms are both fast and even');
select results_eq(
  $$ select kind from public.anticheat_flags order by kind $$,
  $$ values ('fast_response'::public.anticheat_kind), ('low_variance'::public.anticheat_kind) $$,
  'each kind has its own row');

select pg_temp.reset();
select pg_temp.erin_day(4000, 4100, 3900, 4050, 3950);
select pg_temp.ci(:erin, timestamptz '2026-03-10 20:00:00+00', 9000, 'failed');
select pg_temp.ci(:erin, timestamptz '2026-03-10 21:00:00+00', null, 'miss');
select is(internal.anticheat_eval('2026-03-10'), 1, 'failed and missed check-ins are not part of the variance');
select is((select details ->> 'passes' from public.anticheat_flags), '5', 'only the five passes');

-- ANT-02: injected clicks reported by the agent ---------------------------------------------------

select pg_temp.reset();
create temp table c1 as select pg_temp.ci(:erin, timestamptz '2026-03-10 18:00:00+00', 4000, 'pass', '{injected_click:3}') as id;
select results_eq(
  $$ select user_id, day, kind, (details ->> 'clicks')::int, jsonb_array_length(details -> 'checkin_ids') from public.anticheat_flags $$,
  $$ values ('00000000-0000-4000-8000-0000000000c1'::uuid, date '2026-03-10', 'injected_click'::public.anticheat_kind, 3, 1) $$,
  'an injected_click flag on a check-in becomes a flag on the day');
select is((select details -> 'checkin_ids' ->> 0 from public.anticheat_flags), (select id::text from c1), 'listing the check-in');
select pg_temp.ci(:erin, timestamptz '2026-03-10 19:00:00+00', 5000, 'pass', '{injected_click}');
select results_eq(
  $$ select (details ->> 'clicks')::int, jsonb_array_length(details -> 'checkin_ids') from public.anticheat_flags $$,
  $$ values (4, 2) $$,
  'a bare flag is one click; the day adds up (one row per day)');
select pg_temp.ci(:erin, timestamptz '2026-03-10 20:00:00+00', null, 'miss', '{injected_click:2}');
select is((select (details ->> 'clicks')::int from public.anticheat_flags), 6, 'a missed check-in carries the flag too');
select pg_temp.ci(:erin, timestamptz '2026-03-11 18:00:00+00', 5000, 'pass', '{injected_click:1}');
select is(pg_temp.flags('injected_click'), 2, 'another day is another row');
select pg_temp.ci(:lucas, timestamptz '2026-03-10 18:00:00+00', 5000, 'pass', '{injected_click:abc}');
select pg_temp.ci(:lucas, timestamptz '2026-03-10 19:00:00+00', 5000, 'pass', '{injected_click:99999999}');
select pg_temp.ci(:lucas, timestamptz '2026-03-10 20:00:00+00', 5000, 'pass', '{something_else,injected_click_x}');
select pg_temp.ci(:lucas, timestamptz '2026-03-10 21:00:00+00', 5000, 'pass', '{}');
select is(pg_temp.flags(null, :lucas), 0, 'malformed or unrelated flags create nothing (and never fail the event)');
select is(internal.anticheat_eval('2026-03-10'), 0, 'the daily job does not touch injected_click rows');
select is((select (details ->> 'clicks')::int from public.anticheat_flags where kind = 'injected_click' and day = '2026-03-10'), 6, 'they are as they were');

-- The same through the agent RPC: a check-in event with the flag.
select pg_temp.reset();
select pg_temp.act_as(:erin);
create temp table dev as select device_id from public.register_device('windows', '11', '0.1.0', 'hash-erin-anticheat-rpc');
create temp table ids (c uuid);
insert into ids values (gen_random_uuid());
grant select on dev, ids to authenticated;
create function pg_temp.ts(ago interval) returns text
language sql as $$ select to_char((now() - ago) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') $$;
select public.agent_events((select device_id from dev), jsonb_build_array(
  jsonb_build_object('id', gen_random_uuid(), 'seq', 1, 'type', 'clock_in', 'at', pg_temp.ts('1 hour'),
    'mono_ms', 1, 'payload', '{"reason": "manual"}'::jsonb),
  jsonb_build_object('id', (select c from ids), 'seq', 2, 'type', 'checkin', 'at', pg_temp.ts('20 minutes'),
    'mono_ms', 2, 'payload', jsonb_build_object('scheduled_at', pg_temp.ts('20 minutes'), 'outcome', 'pass',
      'response_ms', 3000, 'wrong_clicks', 0, 'object_keys', '[]'::jsonb, 'flags', '["injected_click:2"]'::jsonb))
));
select pg_temp.act_as_postgres();
select results_eq(
  $$ select kind, (details ->> 'clicks')::int, day from public.anticheat_flags $$,
  $$ select 'injected_click'::public.anticheat_kind, 2,
            ((now() - interval '20 minutes') at time zone 'America/Los_Angeles')::date $$,
  'a check-in event from the agent with the flag raises it on Erin''s local day');
select is((select outcome::text from public.checkin_events where id = (select c from ids)), 'pass',
  'and the check-in is still a pass');
delete from public.anticheat_flags;
delete from public.checkin_events;

-- ANT-08: flags are not penalties ---------------------------------------------------------------------

select is(
  (select count(*)::int
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('public', 'internal') and p.prosrc ilike '%anticheat_flags%'
     -- delete_user_data (#54) only deletes a person's flags along with the rest of their data;
     -- report_rows (#63, DSH-08) only counts them for the report's "needs review" column.
     and p.proname not in ('anticheat_from_checkin', 'anticheat_eval', 'anticheat_mark_reviewed',
                           'delete_user_data', 'report_rows')),
  0, 'no other function (status, segments, timesheets) reads the flags');

create function pg_temp.fingerprint() returns text
language sql as $$
  select md5(
    coalesce((select string_agg(p::text, '|' order by p.user_id) from public.presence p), '') ||
    coalesce((select string_agg(s::text, '|' order by s.id) from public.status_periods s), '') ||
    coalesce((select string_agg(c::text, '|' order by c.id) from public.clock_sessions c), ''))
$$;

select pg_temp.reset();
select pg_temp.act_as_postgres();
insert into public.clock_sessions (org_id, user_id, device_id, start_at, end_at, start_event_id)
values (:org, :erin, :d1, timestamptz '2026-03-10 17:00:00+00', timestamptz '2026-03-10 23:00:00+00', gen_random_uuid());
create temp table before_flags as select pg_temp.fingerprint() as fp;
select pg_temp.erin_day(100, 100, 100, 100, 100);
select pg_temp.ci(:erin, timestamptz '2026-03-10 19:00:00+00', 100, 'pass', '{injected_click:5}');
create temp table before_checkins as
  select string_agg(format('%s %s %s %s', id, outcome, response_ms, wrong_clicks), '|' order by id) as fp from public.checkin_events;
select internal.anticheat_eval('2026-03-10');
select is(pg_temp.flags(), 3, 'all three kinds are raised');
select is(pg_temp.fingerprint(), (select fp from before_flags),
  'presence, status periods and clock sessions (what segments are built from) are exactly as before');
select is(
  (select string_agg(format('%s %s %s %s', id, outcome, response_ms, wrong_clicks), '|' order by id) from public.checkin_events),
  (select fp from before_checkins),
  'check-in outcomes and response times are untouched');

-- RLS ----------------------------------------------------------------------------------------------------

select pg_temp.act_as(:erin);
select is((select count(*)::int from public.anticheat_flags), 3, 'Erin sees the flags about herself');
select pg_temp.act_as(:max);
select is((select count(*)::int from public.anticheat_flags), 3, 'her manager sees them');
select pg_temp.act_as(:ada);
select is((select count(*)::int from public.anticheat_flags), 3, 'and so does the org owner');
select pg_temp.act_as(:lucas);
select is((select count(*)::int from public.anticheat_flags), 0, 'a peer sees nothing');
select pg_temp.act_as(:olga);
select is((select count(*)::int from public.anticheat_flags), 0, 'another org sees nothing');
select pg_temp.act_as(:oscar);
select is((select count(*)::int from public.anticheat_flags), 0, 'not even its own employees');

select pg_temp.act_as(:max);
select throws_ok($$ update public.anticheat_flags set reviewed_at = now() $$, '42501', null,
  'a manager cannot edit flags directly');
select throws_ok($$ delete from public.anticheat_flags $$, '42501', null, 'or delete them');
select throws_ok($$ insert into public.anticheat_flags (org_id, user_id, day, kind)
  values ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000c1', current_date, 'fast_response') $$,
  '42501', null, 'or write them');
select pg_temp.act_as(:erin);
select throws_ok($$ update public.anticheat_flags set reviewed_at = now() $$, '42501', null, 'Erin cannot clear her own flags');

set local role anon;
select throws_ok($$ select count(*) from public.anticheat_flags $$, '42501', null, 'anon has no access');
select throws_ok($$ select public.anticheat_mark_reviewed(gen_random_uuid()) $$, '42501', null, 'anon cannot review');
select pg_temp.act_as_postgres();

-- Reviewing ------------------------------------------------------------------------------------------------

create temp table f as
  select (select id from public.anticheat_flags where kind = 'fast_response') as fast,
         (select id from public.anticheat_flags where kind = 'low_variance') as low,
         (select id from public.anticheat_flags where kind = 'injected_click') as inj;
grant select on f to authenticated;

select pg_temp.act_as(:erin);
select throws_ok($$ select public.anticheat_mark_reviewed((select fast from f)) $$, '42501', 'flag_not_found',
  'the employee cannot review their own flag');
select pg_temp.act_as(:lucas);
select throws_ok($$ select public.anticheat_mark_reviewed((select fast from f)) $$, '42501', 'flag_not_found',
  'a peer cannot review it');
select pg_temp.act_as(:oscar);
select throws_ok($$ select public.anticheat_mark_reviewed((select fast from f)) $$, '42501', 'flag_not_found',
  'nor can another org');
select pg_temp.act_as(:max);
select throws_ok($$ select public.anticheat_mark_reviewed(gen_random_uuid()) $$, '42501', 'flag_not_found',
  'an unknown flag is not found');
select throws_ok($$ select public.anticheat_mark_reviewed((select fast from f), repeat('x', 501)) $$, '22023', 'note_too_long',
  'the note is at most 500 characters');
select lives_ok($$ select public.anticheat_mark_reviewed((select fast from f), '  Spoke to Erin, trackpad is very light  ') $$,
  'her manager marks it reviewed with a note');
select results_eq(
  $$ select reviewed_by, reviewed_at is not null, review_note from public.anticheat_flags where kind = 'fast_response' $$,
  $$ values ('00000000-0000-4000-8000-0000000000b1'::uuid, true, 'Spoke to Erin, trackpad is very light') $$,
  'who, when and the trimmed note are kept');
select throws_ok($$ select public.anticheat_mark_reviewed((select fast from f)) $$, '22023', 'already_reviewed',
  'a flag is reviewed once');
select lives_ok($$ select public.anticheat_mark_reviewed((select low from f)) $$, 'a note is optional');
select is((select review_note from public.anticheat_flags where kind = 'low_variance'), null, 'and stays empty');
select pg_temp.act_as(:ada);
select lives_ok($$ select public.anticheat_mark_reviewed((select inj from f), 'Known remote tool') $$,
  'the org owner can review too');

select pg_temp.act_as_postgres();
select results_eq(
  $$ select actor_id, target_user_id, metadata ->> 'kind', metadata ->> 'day', metadata ->> 'note', metadata ->> 'flag_id'
     from public.audit_log where action = 'anticheat.reviewed' and (metadata ->> 'kind') = 'fast_response' $$,
  $$ select '00000000-0000-4000-8000-0000000000b1'::uuid, '00000000-0000-4000-8000-0000000000c1'::uuid,
            'fast_response', '2026-03-10', 'Spoke to Erin, trackpad is very light', fast::text from f $$,
  'the review is in the audit log with the flag, day and note');
select is((select count(*)::int from public.audit_log where action = 'anticheat.reviewed'), 3, 'one audit row per review');

select pg_temp.act_as(:erin);
select results_eq(
  $$ select kind, reviewed_at is not null from public.anticheat_flags order by kind $$,
  $$ values ('injected_click'::public.anticheat_kind, true), ('fast_response', true), ('low_variance', true) $$,
  'Erin sees that her flags were reviewed');

select * from finish();
rollback;
