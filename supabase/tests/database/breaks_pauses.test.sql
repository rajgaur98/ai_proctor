begin;
create extension if not exists pgtap with schema extensions;

select plan(14);

\set erin '''00000000-0000-4000-8000-0000000000c1'''
\set max '''00000000-0000-4000-8000-0000000000b1'''
\set ada '''00000000-0000-4000-8000-0000000000a1'''
\set org '''00000000-0000-4000-8000-000000000001'''

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

create function pg_temp.ts(t timestamptz) returns text
language sql as $$ select to_char(t at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') $$;

create temp table seqs (n int);
insert into seqs values (0);
grant all on seqs to authenticated;

-- 09:00 in Erin's time zone (America/Los_Angeles), two local days ago: every event
-- below is in the past and inside the 7-day window the server accepts. Day one is
-- base..base+12h; day two is the next local day.
create temp table b as
select (((now() at time zone 'America/Los_Angeles')::date - 2) + time '09:00')
  at time zone 'America/Los_Angeles' as t;
grant select on b to authenticated;

-- Sends one event `mins` minutes after base and returns its rejection reason (null when accepted).
create function pg_temp.send(type text, payload jsonb, mins int)
returns text
language plpgsql as $$
declare
  n int;
begin
  update seqs set n = seqs.n + 1 returning seqs.n into n;
  return public.agent_events(
    (select device_id from dev),
    jsonb_build_array(jsonb_build_object('id', gen_random_uuid(), 'seq', n, 'type', type,
      'at', pg_temp.ts((select t from b) + make_interval(mins => mins)), 'mono_ms', n,
      'payload', payload))
  ) -> 'rejected' -> 0 ->> 'reason';
end;
$$;

-- A pause of `len` minutes starting `mins` after base, ended by a pause_end.
create function pg_temp.pause(mins int, len int, reason text default null)
returns void
language plpgsql as $$
begin
  perform pg_temp.send('pause_start',
    jsonb_strip_nulls(jsonb_build_object('planned_min', 15, 'reason', reason)), mins);
  perform pg_temp.send('pause_end', '{}', mins + len);
end;
$$;

select pg_temp.act_as(:erin);
create temp table dev as select device_id from public.register_device('macos', '26.0', '0.1.0', 'hash-erin-breaks');
grant select on dev to authenticated;

-- BRK-02: defaults.
select pg_temp.act_as_postgres();
select results_eq(
  $$ select breaks_paid, break_daily_max_min, pause_max_min, pause_daily_max_min
     from internal.break_pause_policy('00000000-0000-4000-8000-000000000001') $$,
  $$ values (false, null::int, 15, 60) $$,
  'breaks are unpaid with no daily max, pauses cap at 15 min and 60 min a day by default'
);
update public.orgs set policy = policy || '{"breaks_paid": true, "break_daily_max_min": 60}'
where id = :org;
select results_eq(
  $$ select breaks_paid, break_daily_max_min, pause_max_min, pause_daily_max_min
     from internal.break_pause_policy('00000000-0000-4000-8000-000000000001') $$,
  $$ values (true, 60, 15, 60) $$,
  'the org can make breaks paid and set a daily max'
);

-- Day one: two breaks (45 + 30 min against a 60 min max), then pauses.
select pg_temp.act_as(:erin);
select pg_temp.send('clock_in', '{"reason": "manual"}', 0);
select pg_temp.send('break_start', '{"planned_min": 60}', 10);
select pg_temp.send('break_end', '{}', 55);
select pg_temp.send('break_start', '{"planned_min": 30}', 60);
select pg_temp.send('break_end', '{}', 90);

-- 10 min (fine), 20 min (5 over the per-pause cap), a 15 min extension started
-- the moment the 20 min one ends (new pause), then 15, 15 and an open one that
-- clock-out closes after 10 min.
select pg_temp.pause(100, 10, 'Doctor call');
select pg_temp.pause(120, 20);
select pg_temp.pause(140, 15);
select pg_temp.pause(160, 15);
select pg_temp.pause(180, 15);
select pg_temp.send('pause_start', '{"planned_min": 15}', 200);
select pg_temp.send('clock_out', '{"reason": "manual"}', 210);

-- A second shift: a break that clock-out ends (20 min, 75 min of breaks already).
select pg_temp.send('clock_in', '{"reason": "manual"}', 220);
select pg_temp.send('break_start', '{"planned_min": null}', 230);
select pg_temp.send('clock_out', '{"reason": "manual"}', 250);

select pg_temp.act_as_postgres();
select results_eq(
  $$ select over_cap_s from public.breaks where user_id = '00000000-0000-4000-8000-0000000000c1'
     order by start_at $$,
  $$ values (0), (900), (1200) $$,
  'BRK-02: break excess over the daily max is flagged (45 min fine, 30 min is 15 over, 20 min is all over)'
);
select is((select count(*)::int from public.breaks where user_id = :erin and end_at is null), 0,
  'the break open at clock-out was closed');
select results_eq(
  $$ select over_cap_s from public.pauses where user_id = '00000000-0000-4000-8000-0000000000c1'
     order by start_at $$,
  $$ values (0), (300), (0), (0), (600), (600) $$,
  'BRK-06: 10 min fine; 20 min is 5 over the per-pause cap; 15, 15 fit; the 5th pushes the day 10 over; clock-out closes the last (10 over)'
);
select is((select count(*)::int from public.pauses where user_id = :erin and end_at is null), 0,
  'the pause open at clock-out was closed');
select ok(
  (select p3.start_at = p2.end_at and p3.id <> p2.id and p3.over_cap_s = 0
   from public.pauses p2 join public.pauses p3 on p3.start_at = p2.end_at
   where p2.user_id = :erin and p2.over_cap_s = 300),
  'BRK-05: an extension is a new pause, and the daily total includes the earlier pause'
);
select is((select end_at from public.pauses where user_id = :erin and over_cap_s = 600 and
  start_at = (select t from b) + interval '200 minutes'), (select t from b) + interval '210 minutes',
  'clock-out ends the open pause at the clock-out time');

-- The day total restarts on the next local day.
select pg_temp.act_as(:erin);
select pg_temp.send('clock_in', '{"reason": "manual"}', 24 * 60);
select pg_temp.pause(24 * 60 + 10, 15);
select isnt(pg_temp.send('pause_start',
  jsonb_build_object('planned_min', 5, 'reason', repeat('x', 201)), 24 * 60 + 30), null,
  'a reason over 200 characters is rejected');
select pg_temp.send('clock_out', '{"reason": "manual"}', 24 * 60 + 60);
select pg_temp.act_as_postgres();
select is((select over_cap_s from public.pauses where user_id = :erin
  and start_at = (select t from b) + interval '1 day 10 minutes'), 0,
  'the daily pause total is per local day');

-- BRK-03: the private reason.
select pg_temp.act_as(:erin);
select is((select private_reason from public.my_pauses where private_reason is not null), 'Doctor call',
  'the employee reads their own reason');
select pg_temp.act_as(:max);
select throws_ok($$ select private_reason from public.pauses $$, '42501', null,
  'the manager cannot select the reason column');
select pg_temp.act_as(:ada);
select throws_ok($$ select private_reason from public.pauses $$, '42501', null,
  'an admin cannot either');
select pg_temp.act_as(:max);
select ok((select count(*) from public.pauses where user_id = :erin and over_cap_s > 0) > 0
  and (select count(*) from public.my_pauses) = 0,
  'the manager still reads the other pause columns, and my_pauses only ever shows their own');

select * from finish();
rollback;
