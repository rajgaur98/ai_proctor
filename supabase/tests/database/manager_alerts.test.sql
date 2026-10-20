begin;
create extension if not exists pgtap with schema extensions;

select plan(99);

\set erin '''00000000-0000-4000-8000-0000000000c1'''
\set lucas '''00000000-0000-4000-8000-0000000000c2'''
\set max '''00000000-0000-4000-8000-0000000000b1'''
\set ada '''00000000-0000-4000-8000-0000000000a1'''
\set org '''00000000-0000-4000-8000-000000000001'''
\set dev '''00000000-0000-4000-8000-0000000000d1'''

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

-- Clean slate between scenarios: no alerts, mail, shifts-in-progress or policy.
create function pg_temp.reset() returns void
language sql as $$
  delete from public.alerts;
  delete from public.email_outbox;
  delete from public.checkin_events;
  delete from public.pauses;
  delete from public.breaks;
  delete from public.clock_sessions;
  delete from public.status_periods;
  delete from public.delegations;
  update public.presence set status = 'off_shift', since = now();
  update public.orgs set policy = '{}' where id = '00000000-0000-4000-8000-000000000001';
$$;

-- Alerts of a kind (about Erin unless told otherwise), all recipients.
create function pg_temp.n(k public.alert_kind, who uuid default '00000000-0000-4000-8000-0000000000c1')
returns int
language sql as $$ select count(*)::int from public.alerts where kind = k and user_id = who $$;

create function pg_temp.policy(p jsonb) returns void
language sql as $$
  update public.orgs set policy = p where id = '00000000-0000-4000-8000-000000000001'
$$;

create function pg_temp.session(p_start timestamptz, p_end timestamptz default null)
returns uuid
language sql as $$
  insert into public.clock_sessions (org_id, user_id, device_id, start_at, end_at, start_event_id)
  values ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000c1',
          '00000000-0000-4000-8000-0000000000d1', p_start, p_end, gen_random_uuid())
  returning id
$$;

-- A check-in `mins` minutes ago.
create function pg_temp.checkin(mins int, outcome public.checkin_outcome) returns uuid
language sql as $$
  insert into public.checkin_events (id, org_id, user_id, device_id, scheduled_at, outcome)
  values (gen_random_uuid(), '00000000-0000-4000-8000-000000000001',
          '00000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-0000000000d1',
          now() - make_interval(mins => mins), outcome)
  returning id
$$;

create function pg_temp.set_offline(since timestamptz) returns void
language sql as $$
  update public.presence set status = 'offline', since = $1
  where user_id = '00000000-0000-4000-8000-0000000000c1'
$$;

insert into public.devices (id, org_id, user_id, platform, os_version, agent_version, hardware_hash)
values (:dev, :org, :erin, 'macos', '26.0', '0.1.0', 'hash-erin-alerts');
-- The seed's weekday shifts would make the late clock-in check depend on the time of day.
delete from public.shifts;

-- Policy helpers ----------------------------------------------------------------------------

select is(internal.alert_policy_int('{}', 'alert_offline_min', 15, 5, 240), 15, 'a missing threshold is the default');
select is(internal.alert_policy_int('{"alert_consecutive_misses": 50}', 'alert_consecutive_misses', 3, 1, 10), 10,
  'a threshold above its range is clamped (PRD section 6: 1 to 10)');
select is(internal.alert_policy_int('{"alert_consecutive_misses": "many"}', 'alert_consecutive_misses', 3, 1, 10), 3,
  'a threshold that is not a number is the default');
select ok(internal.alert_enabled('{}', 'tamper'), 'every kind is on by default');
select ok(not internal.alert_enabled('{"alert_tamper_enabled": false}', 'tamper'), 'a kind can be switched off');
select ok(internal.alert_enabled('{"alert_tamper_enabled": "no"}', 'tamper'), 'a flag that is not a boolean leaves the kind on');

-- Consecutive misses -------------------------------------------------------------------------

select pg_temp.reset();
select pg_temp.session(now() - interval '3 hours');
select pg_temp.checkin(40, 'miss');
select pg_temp.checkin(30, 'miss');
select internal.alert_eval();
select is(pg_temp.n('consecutive_misses'), 0, 'two misses are below the default of 3');

select pg_temp.checkin(20, 'miss');
select is(internal.alert_eval(), 1, 'the third miss in a row raises an alert (one recipient: the manager)');
select results_eq(
  $$ select recipient_id, details ->> 'misses', details ->> 'threshold' from public.alerts where kind = 'consecutive_misses' $$,
  $$ values ('00000000-0000-4000-8000-0000000000b1'::uuid, '3', '3') $$,
  'it goes to Erin''s direct manager with the streak in its details');
select internal.alert_eval();
select pg_temp.checkin(10, 'miss');
select internal.alert_eval();
select is(pg_temp.n('consecutive_misses'), 1, 'the same streak, fourth miss and every later minute, does not raise it again');

select pg_temp.checkin(5, 'pass');
select pg_temp.checkin(4, 'miss');
select pg_temp.checkin(3, 'miss');
select internal.alert_eval();
select is(pg_temp.n('consecutive_misses'), 1, 'a pass ends the streak: two more misses are not a new alert');
select pg_temp.checkin(2, 'miss');
select internal.alert_eval();
select is(pg_temp.n('consecutive_misses'), 2, 'three misses after a pass are a new episode');

select pg_temp.reset();
select pg_temp.session(now() - interval '3 hours');
select pg_temp.checkin(40, 'miss');
select pg_temp.checkin(30, 'failed');
select pg_temp.checkin(20, 'miss');
select pg_temp.checkin(10, 'miss');
select internal.alert_eval();
select is(pg_temp.n('consecutive_misses'), 0, 'a failed challenge is not a miss and ends the streak');

select pg_temp.reset();
select pg_temp.session(now() - interval '3 hours');
select pg_temp.checkin(40, 'miss');
select pg_temp.checkin(30, 'miss');
select pg_temp.checkin(20, 'miss');
select pg_temp.policy('{"alert_consecutive_misses": 4}');
select internal.alert_eval();
select is(pg_temp.n('consecutive_misses'), 0, 'N is configurable: three misses are fine when N is 4');
select pg_temp.checkin(10, 'miss');
select internal.alert_eval();
select is(pg_temp.n('consecutive_misses'), 1, '... and the fourth raises it');

select pg_temp.reset();
select pg_temp.session(now() - interval '3 hours');
select pg_temp.checkin(40, 'miss');
select pg_temp.checkin(30, 'miss');
select pg_temp.checkin(20, 'miss');
select pg_temp.policy('{"alert_consecutive_misses_enabled": false}');
select internal.alert_eval();
select is(pg_temp.n('consecutive_misses'), 0, 'switched off: no alert');

select pg_temp.reset();
select pg_temp.session(now() - interval '5 hours', now() - interval '4 hours');
select pg_temp.session(now() - interval '3 hours');
select pg_temp.checkin(300 - 10, 'miss');
select pg_temp.checkin(300 - 20, 'miss');
select pg_temp.checkin(300 - 30, 'miss');
select internal.alert_eval();
select is(pg_temp.n('consecutive_misses'), 0, 'misses from an earlier clock session do not count toward this one');

select pg_temp.reset();
select pg_temp.session(now() - interval '30 hours');
select pg_temp.checkin(1700, 'miss');
select pg_temp.checkin(1690, 'miss');
select pg_temp.checkin(1680, 'miss');
update public.checkin_events set created_at = now() - interval '2 hours';
select internal.alert_eval();
select is(pg_temp.n('consecutive_misses'), 0, 'a streak first seen more than an hour ago is not replayed');

-- Offline during a shift --------------------------------------------------------------------

select pg_temp.reset();
select pg_temp.session(now() - interval '3 hours');
select pg_temp.set_offline(now() - interval '10 minutes');
select internal.alert_eval();
select is(pg_temp.n('offline'), 0, 'Offline for 10 minutes is under the 15 minute default');
select pg_temp.set_offline(now() - interval '16 minutes');
select is(internal.alert_eval(), 1, 'Offline for 16 minutes while clocked in raises an alert');
select internal.alert_eval();
select is(pg_temp.n('offline'), 1, 'the same offline period raises it once, not every minute');
select pg_temp.set_offline(now() - interval '5 minutes');
select pg_temp.set_offline(now() - interval '40 minutes');
select internal.alert_eval();
select is(pg_temp.n('offline'), 2, 'a different offline period is a new episode');

select pg_temp.reset();
select pg_temp.session(now() - interval '3 hours');
select pg_temp.set_offline(now() - interval '16 minutes');
select pg_temp.policy('{"alert_offline_min": 30}');
select internal.alert_eval();
select is(pg_temp.n('offline'), 0, 'the offline threshold is configurable (30 min)');
select pg_temp.policy('{"alert_offline_min": 30, "alert_offline_enabled": false}');
select pg_temp.set_offline(now() - interval '90 minutes');
select internal.alert_eval();
select is(pg_temp.n('offline'), 0, 'switched off: no alert');

select pg_temp.reset();
select pg_temp.set_offline(now() - interval '60 minutes');
select internal.alert_eval();
select is(pg_temp.n('offline'), 0, 'not clocked in: no offline alert');

-- Tamper -----------------------------------------------------------------------------------------

select pg_temp.reset();
select pg_temp.session(now() - interval '3 hours');
insert into public.status_periods (org_id, user_id, status, start_at)
values (:org, :erin, 'tamper', now() - interval '1 minute');
select is(internal.alert_eval(), 1, 'a Tamper period raises an alert at once');
select internal.alert_eval();
select is(pg_temp.n('tamper'), 1, 'one alert per Tamper period');

select pg_temp.reset();
select pg_temp.session(now() - interval '3 hours');
insert into public.status_periods (org_id, user_id, status, start_at, end_at)
values (:org, :erin, 'tamper', now() - interval '3 hours', now() - interval '2 hours');
select internal.alert_eval();
select is(pg_temp.n('tamper'), 0, 'a Tamper period that ended hours ago is not replayed');
insert into public.status_periods (org_id, user_id, status, start_at, end_at)
values (:org, :erin, 'tamper', now() - interval '50 minutes', now() - interval '30 minutes');
select internal.alert_eval();
select is(pg_temp.n('tamper'), 1, 'a heartbeat-gap Tamper period recorded after the fact raises one too');

select pg_temp.reset();
select pg_temp.policy('{"alert_tamper_enabled": false}');
insert into public.status_periods (org_id, user_id, status, start_at)
values (:org, :erin, 'tamper', now() - interval '1 minute');
select internal.alert_eval();
select is(pg_temp.n('tamper'), 0, 'switched off: no alert');

-- Late clock-in --------------------------------------------------------------------------------

-- One shift every day in UTC: it started 30 minutes ago and runs 3 hours more (past
-- midnight when it has to be).
create function pg_temp.shift(started_ago interval, ends_in interval) returns void
language sql as $$
  delete from public.shifts where user_id = '00000000-0000-4000-8000-0000000000c1';
  insert into public.shifts (org_id, user_id, days, start_time, end_time, timezone)
  values ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000c1',
          '{1,2,3,4,5,6,7}', ((now() - started_ago) at time zone 'UTC')::time,
          ((now() + ends_in) at time zone 'UTC')::time, 'UTC')
$$;

select pg_temp.reset();
select pg_temp.shift(interval '10 minutes', interval '3 hours');
select internal.alert_eval();
select is(pg_temp.n('late_clock_in'), 0, 'ten minutes into the shift is inside the 15 minute grace');

select pg_temp.shift(interval '30 minutes', interval '3 hours');
select is(internal.alert_eval(), 1, 'not clocked in 30 minutes after the shift started raises an alert');
select results_eq(
  $$ select details ->> 'grace_min' from public.alerts where kind = 'late_clock_in' $$,
  $$ values ('15') $$, 'with the grace in its details');
select internal.alert_eval();
select is(pg_temp.n('late_clock_in'), 1, 'one alert per shift, not one per minute');

select pg_temp.reset();
select pg_temp.shift(interval '30 minutes', interval '3 hours');
select pg_temp.session(now() - interval '25 minutes');
select internal.alert_eval();
select is(pg_temp.n('late_clock_in'), 0, 'clocked in within the grace (5 minutes after the start): on time');

select pg_temp.reset();
select pg_temp.shift(interval '30 minutes', interval '3 hours');
select pg_temp.session(now() - interval '10 minutes');
select internal.alert_eval();
select is(pg_temp.n('late_clock_in'), 1, 'clocked in 20 minutes after the start: late');

select pg_temp.reset();
select pg_temp.shift(interval '30 minutes', interval '3 hours');
select pg_temp.session(now() - interval '2 hours');
select internal.alert_eval();
select is(pg_temp.n('late_clock_in'), 0, 'already clocked in before the shift started: on time');

select pg_temp.reset();
select pg_temp.shift(interval '30 minutes', interval '3 hours');
select pg_temp.policy('{"late_clock_in_min": 45}');
select internal.alert_eval();
select is(pg_temp.n('late_clock_in'), 0, 'the grace is configurable (45 min)');
select pg_temp.policy('{"alert_late_clock_in_enabled": false}');
select internal.alert_eval();
select is(pg_temp.n('late_clock_in'), 0, 'switched off: no alert');

select pg_temp.reset();
select pg_temp.shift(interval '4 hours', interval '-1 hour');
select internal.alert_eval();
select is(pg_temp.n('late_clock_in'), 0, 'a shift that has already ended is not alerted');

select pg_temp.reset();
select pg_temp.shift(interval '30 minutes', interval '3 hours');
update public.devices set revoked_at = now() where id = :dev;
select internal.alert_eval();
select is(pg_temp.n('late_clock_in'), 0, 'someone without an active device can''t clock in: no alert');
update public.devices set revoked_at = null where id = :dev;

-- Pause over the daily cap -------------------------------------------------------------------

-- Erin's local noon today is the "now" for these: pauses stay inside one local day.
create function pg_temp.noon() returns timestamptz
language sql as $$
  select (((now() at time zone 'America/Los_Angeles')::date + time '12:00') at time zone 'America/Los_Angeles')
$$;

-- A pause of `len` minutes that started `ago` minutes before local noon (open: no length).
create function pg_temp.pause(sess uuid, ago int, len int) returns void
language sql as $$
  insert into public.pauses (org_id, user_id, clock_session_id, start_at, end_at, planned_min)
  values ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000c1', sess,
          pg_temp.noon() - make_interval(mins => ago),
          case when len is null then null else pg_temp.noon() - make_interval(mins => ago - len) end, 15)
$$;

select pg_temp.reset();
create temp table s as select pg_temp.session(pg_temp.noon() - interval '4 hours') as id;
select pg_temp.pause((select id from s), 200, 15);
select pg_temp.pause((select id from s), 160, 15);
select pg_temp.pause((select id from s), 120, 15);
select pg_temp.pause((select id from s), 50, 15);
select internal.alert_eval(pg_temp.noon());
select is(pg_temp.n('pause_over_cap'), 0, 'exactly 60 minutes of pauses is at the cap, not over it');

select pg_temp.pause((select id from s), 25, 5);
select is(internal.alert_eval(pg_temp.noon()), 1, 'a fifth pause that pushes the day past 60 minutes raises an alert');
select results_eq(
  $$ select (details ->> 'total_s')::int, (details ->> 'cap_min')::int from public.alerts where kind = 'pause_over_cap' $$,
  $$ values (3900, 60) $$, 'with the total and the cap');
select internal.alert_eval(pg_temp.noon());
select pg_temp.pause((select id from s), 10, 5);
select internal.alert_eval(pg_temp.noon());
select is(pg_temp.n('pause_over_cap'), 1, 'one alert per local day, however many pauses follow');

select pg_temp.reset();
drop table s;
create temp table s as select pg_temp.session(pg_temp.noon() - interval '4 hours') as id;
select pg_temp.pause((select id from s), 120, 15);
select pg_temp.pause((select id from s), 100, 15);
select pg_temp.pause((select id from s), 80, 15);
select pg_temp.pause((select id from s), 15, null);
select internal.alert_eval(pg_temp.noon());
select is(pg_temp.n('pause_over_cap'), 0, 'an open pause counts up to now: 60 minutes so far is not over');
select internal.alert_eval(pg_temp.noon() + interval '1 minute');
select is(pg_temp.n('pause_over_cap'), 1, '... and a minute later the open pause tips the day over');

select pg_temp.reset();
drop table s;
create temp table s as select pg_temp.session(pg_temp.noon() - interval '4 hours') as id;
select pg_temp.policy('{"pause_daily_max_min": 120}');
select pg_temp.pause((select id from s), 100, 15);
select pg_temp.pause((select id from s), 80, 15);
select pg_temp.pause((select id from s), 60, 15);
select pg_temp.pause((select id from s), 40, 15);
select pg_temp.pause((select id from s), 20, 15);
select internal.alert_eval(pg_temp.noon());
select is(pg_temp.n('pause_over_cap'), 0, 'the cap is the org''s daily pause cap (BRK-06): 75 minutes is fine under a 120 minute cap');
select pg_temp.policy('{"pause_daily_max_min": 60, "alert_pause_over_cap_enabled": false}');
select internal.alert_eval(pg_temp.noon());
select is(pg_temp.n('pause_over_cap'), 0, 'switched off: no alert');

select pg_temp.reset();
create temp table old_day as select pg_temp.session(pg_temp.noon() - interval '2 days 4 hours') as id;
insert into public.pauses (org_id, user_id, clock_session_id, start_at, end_at, planned_min)
select :org, :erin, (select id from old_day), pg_temp.noon() - interval '2 days' + make_interval(mins => n * 30),
       pg_temp.noon() - interval '2 days' + make_interval(mins => n * 30 + 20), 15
from generate_series(1, 5) n;
select internal.alert_eval(pg_temp.noon());
select is(pg_temp.n('pause_over_cap'), 0, 'a day that was over the cap long ago is not replayed');

-- Recipients --------------------------------------------------------------------------------------

select pg_temp.reset();
select internal.raise_alert(:erin, 'tamper', 'ep-1', '{}');
select is((select count(*)::int from public.alerts), 1, 'the direct manager is the only recipient without a delegation');

select pg_temp.reset();
insert into public.delegations (org_id, manager_id, delegate_id, starts_on, ends_on)
values (:org, :max, :lucas, current_date - 1, current_date + 5);
select internal.raise_alert(:erin, 'tamper', 'ep-1', '{}');
select results_eq(
  $$ select recipient_id from public.alerts order by recipient_id $$,
  $$ values ('00000000-0000-4000-8000-0000000000b1'::uuid), ('00000000-0000-4000-8000-0000000000c2'::uuid) $$,
  'an active delegate of the manager gets it too');
select internal.raise_alert(:erin, 'tamper', 'ep-1', '{}');
select is((select count(*)::int from public.alerts), 2, 'the same episode again is ignored for every recipient');

select pg_temp.reset();
insert into public.delegations (org_id, manager_id, delegate_id, starts_on, ends_on)
values (:org, :max, :lucas, current_date - 10, current_date - 3);
select internal.raise_alert(:erin, 'tamper', 'ep-1', '{}');
select is((select count(*)::int from public.alerts), 1, 'a delegation that has ended gets nothing');

select pg_temp.reset();
select internal.raise_alert(:ada, 'tamper', 'ep-1', '{}');
select is((select count(*)::int from public.alerts), 0, 'the owner has no manager, so nobody is alerted about them');

select pg_temp.reset();
update public.users set active = false where id = :max;
select internal.raise_alert(:erin, 'tamper', 'ep-1', '{}');
select is((select count(*)::int from public.alerts), 0, 'a deactivated manager gets nothing');
update public.users set active = true where id = :max;

-- Access and marking read -----------------------------------------------------------------

select pg_temp.reset();
select internal.raise_alert(:erin, 'tamper', 'ep-1', '{}');
select internal.raise_alert(:erin, 'tamper', 'ep-2', '{}');
select internal.raise_alert(:lucas, 'tamper', 'ep-1', '{}');

select pg_temp.act_as(:max);
select is((select count(*)::int from public.alerts), 3, 'the manager reads their alerts');
select pg_temp.act_as(:ada);
select is((select count(*)::int from public.alerts), 3, 'an owner, who can view both employees, reads them too');
select pg_temp.act_as(:erin);
select is((select count(*)::int from public.alerts), 0, 'the employee does not read alerts about themselves');
select pg_temp.act_as(:lucas);
select is((select count(*)::int from public.alerts), 0, 'another employee reads none');

select pg_temp.act_as(:erin);
select throws_ok(
  $$ update public.alerts set read_at = now() $$, '42501', null, 'nobody updates alerts through the API');
select throws_ok(
  $$ insert into public.alerts (org_id, user_id, recipient_id, kind, episode)
     values ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000c1',
             '00000000-0000-4000-8000-0000000000c1', 'tamper', 'x') $$,
  '42501', null, 'nor insert them');
select is(public.mark_alerts_read(), 0, 'someone who is not a recipient marks nothing');

select pg_temp.act_as(:max);
select is(public.mark_alerts_read(array[(select id from public.alerts where episode = 'ep-1' and user_id = :erin)]), 1,
  'a recipient marks one alert read');
select is((select count(*)::int from public.alerts where read_at is null), 2, 'the others stay unread');
select is(public.mark_alerts_read(), 2, 'with no ids, all of theirs');
select pg_temp.act_as_postgres();

-- Email batching (ALR-02) -----------------------------------------------------------------

select pg_temp.reset();
select internal.raise_alert(:erin, 'tamper', 'ep-1', '{"n": 1}');
select internal.queue_alert_emails();
select results_eq(
  $$ select to_email, template, batch_key, jsonb_array_length(payload -> 'alerts') from public.email_outbox $$,
  $$ values ('manager@acme.test', 'alert',
             '00000000-0000-4000-8000-0000000000b1:00000000-0000-4000-8000-0000000000c1:tamper', 1) $$,
  'the first alert is emailed at once to the manager');
select is((select count(*)::int from public.alerts where email_id is not null), 1, 'and the alert points at its email');

select internal.raise_alert(:erin, 'tamper', 'ep-2', '{"n": 2}');
select internal.raise_alert(:erin, 'tamper', 'ep-3', '{"n": 3}');
select internal.queue_alert_emails();
select is((select count(*)::int from public.email_outbox), 1, 'more of the same kind for the same employee within the hour send nothing');
select is((select count(*)::int from public.alerts where email_id is null), 2, 'they are held');

select internal.queue_alert_emails(now() + interval '59 minutes');
select is((select count(*)::int from public.email_outbox), 1, 'still held at 59 minutes');
select internal.queue_alert_emails(now() + interval '61 minutes');
select is((select count(*)::int from public.email_outbox), 2, 'once the hour is over they go out together');
select is((select jsonb_array_length(payload -> 'alerts') from public.email_outbox order by created_at desc limit 1), 2,
  'in one email carrying both held alerts');
select is((select count(*)::int from public.alerts where email_id is null), 0, 'nothing is left held');

select pg_temp.reset();
select internal.raise_alert(:erin, 'tamper', 'ep-1', '{}');
select internal.raise_alert(:erin, 'offline', 'ep-1', '{}');
select internal.raise_alert(:lucas, 'tamper', 'ep-1', '{}');
select internal.queue_alert_emails();
select is((select count(*)::int from public.email_outbox), 3,
  'the limit is per employee and per kind: other kinds and other employees are not held back');

select pg_temp.reset();
select internal.raise_alert(:erin, 'tamper', 'ep-1', '{}');
select pg_temp.act_as(:max);
select public.mark_alerts_read();
select pg_temp.act_as_postgres();
select internal.queue_alert_emails();
select is((select count(*)::int from public.email_outbox), 0, 'an alert already read in the app needs no email');

select pg_temp.reset();
insert into public.delegations (org_id, manager_id, delegate_id, starts_on, ends_on)
values (:org, :max, :lucas, current_date, current_date + 5);
select internal.raise_alert(:erin, 'tamper', 'ep-1', '{}');
select internal.queue_alert_emails();
select results_eq(
  $$ select to_email from public.email_outbox order by to_email $$,
  $$ values ('lucas@acme.test'), ('manager@acme.test') $$,
  'the delegate is emailed as well, separately');

-- The whole path: conditions to mail, nothing raised twice.
select pg_temp.reset();
select pg_temp.session(now() - interval '3 hours');
select pg_temp.checkin(30, 'miss');
select pg_temp.checkin(20, 'miss');
select pg_temp.checkin(10, 'miss');
select internal.alert_eval();
select internal.alert_eval();
select is((select count(*)::int from public.email_outbox), 1, 'alert_eval alone queues the email, once, across repeated runs');

-- Sending (the function's RPCs) -------------------------------------------------------------

select pg_temp.reset();
select internal.raise_alert(:erin, 'tamper', 'ep-1', '{}');
select internal.queue_alert_emails();
select is((select count(*)::int from public.email_claim(10)), 1, 'a due email is claimed');
select is((select attempts from public.email_outbox), 1, 'the claim counts the attempt');
select is((select count(*)::int from public.email_claim(10)), 0, 'and it is not handed out again during the backoff');
select public.email_mark_failed((select id from public.email_outbox), 'resend said 429');
update public.email_outbox set send_after = now() - interval '1 second';
select is((select count(*)::int from public.email_claim(10)), 1, 'after the backoff a failed email is retried');
select is((select last_error from public.email_outbox), 'resend said 429', 'the last error is kept');
select public.email_mark_sent((select id from public.email_outbox));
update public.email_outbox set send_after = now() - interval '1 second';
select is((select count(*)::int from public.email_claim(10)), 0, 'a sent email is never claimed');
select ok((select sent_at is not null and last_error is null from public.email_outbox), 'sent clears the error');

select pg_temp.reset();
select internal.raise_alert(:erin, 'tamper', 'ep-1', '{}');
select internal.queue_alert_emails();
update public.email_outbox set attempts = 4, send_after = now() - interval '1 second';
select is((select count(*)::int from public.email_claim(10)), 1, 'the fifth attempt is still made');
update public.email_outbox set send_after = now() - interval '1 second';
select is((select count(*)::int from public.email_claim(10)), 0, 'then the email is given up on');

-- Cron and grants -------------------------------------------------------------------------------

select results_eq(
  $$ select jobname, schedule from cron.job where jobname in ('alert_eval', 'send_emails') order by jobname $$,
  $$ values ('alert_eval', '* * * * *'), ('send_emails', '* * * * *') $$,
  'alert_eval and send_emails run every minute');

select pg_temp.reset();
delete from vault.secrets where name in ('project_url', 'service_role_key');
select is(internal.send_emails_kick(), null, 'with no mail waiting the kick does nothing, secrets or not');
select internal.raise_alert(:erin, 'tamper', 'ep-1', '{}');
select internal.queue_alert_emails();
select throws_ok($$ select internal.send_emails_kick() $$, 'P0001',
  'vault secrets project_url and service_role_key are not set',
  'with mail waiting and no Vault secrets it fails loudly');
select vault.create_secret('http://kong:8000', 'project_url');
select vault.create_secret('test-service-role-key', 'service_role_key');
select ok(internal.send_emails_kick() is not null, 'with the secrets it calls the function through pg_net');
select is((select count(*)::int from net.http_request_queue where url = 'http://kong:8000/functions/v1/send-emails'), 1,
  'at the send-emails endpoint');

select table_privs_are('public', 'alerts', 'authenticated', array['SELECT'], 'signed-in users can only read alerts');
select table_privs_are('public', 'alerts', 'anon', array[]::text[], 'anonymous users have no access to alerts');
select table_privs_are('public', 'email_outbox', 'authenticated', array[]::text[], 'the outbox is not reachable by signed-in users');
select table_privs_are('public', 'email_outbox', 'anon', array[]::text[], 'nor by anonymous ones');
select ok(
  not has_function_privilege('authenticated', 'public.email_claim(int)', 'execute')
  and not has_function_privilege('anon', 'public.email_claim(int)', 'execute')
  and has_function_privilege('service_role', 'public.email_claim(int)', 'execute')
  and has_function_privilege('service_role', 'public.email_mark_sent(uuid)', 'execute')
  and has_function_privilege('service_role', 'public.email_mark_failed(uuid, text)', 'execute'),
  'the outbox RPCs are for the service role only');
select ok(
  has_function_privilege('authenticated', 'public.mark_alerts_read(uuid[])', 'execute')
  and not has_function_privilege('anon', 'public.mark_alerts_read(uuid[])', 'execute'),
  'mark_alerts_read is for signed-in users');
select ok(
  not has_function_privilege('authenticated', 'internal.alert_eval(timestamptz)', 'execute')
  and not has_function_privilege('authenticated', 'internal.raise_alert(uuid, public.alert_kind, text, jsonb, timestamptz)', 'execute')
  and not has_function_privilege('authenticated', 'internal.send_emails_kick()', 'execute'),
  'the evaluation and the kick are not callable through the API');

select * from finish();
rollback;
