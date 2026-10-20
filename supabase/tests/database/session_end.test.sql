begin;
create extension if not exists pgtap with schema extensions;

-- #159: a logout, restart or shutdown is not a kill (ANT-01, ANT-08). The agent clocks
-- the person out with reason 'session_end', and a restart report that says the last run
-- ended with the session is on record but is never Tamper. A real kill still is.

select plan(10);

\set erin '''00000000-0000-4000-8000-0000000000c1'''

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

create function pg_temp.ts(ago interval) returns text
language sql as $$ select to_char((now() - ago) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') $$;

create temp table seqs (n int);
insert into seqs values (0);
grant all on seqs to authenticated;

-- Sends one event `ago` before now and returns the status afterwards.
create function pg_temp.send(type text, payload jsonb default '{}', ago interval default '0')
returns text
language plpgsql as $$
declare
  n int;
begin
  update seqs set n = seqs.n + 1 returning seqs.n into n;
  perform public.agent_events(
    (select device_id from dev),
    jsonb_build_array(jsonb_build_object('id', gen_random_uuid(), 'seq', n, 'type', type,
      'at', pg_temp.ts(ago), 'mono_ms', n, 'payload', payload)));
  return (select status::text from public.presence where user_id = '00000000-0000-4000-8000-0000000000c1');
end;
$$;

create function pg_temp.restart(reason text, alive_ago interval, ago interval)
returns text
language sql as $$
  select pg_temp.send('agent_restart',
    jsonb_build_object('last_alive_at', pg_temp.ts(alive_ago), 'reason', reason), ago)
$$;

-- Lengths in seconds of Erin's Tamper periods, oldest first.
create function pg_temp.tamper_secs() returns int[]
language sql as $$
  select coalesce(array_agg(round(extract(epoch from end_at - start_at))::int order by start_at), '{}')
  from public.status_periods
  where user_id = '00000000-0000-4000-8000-0000000000c1' and status = 'tamper' and end_at is not null
$$;

select pg_temp.act_as(:erin);
create temp table dev as select device_id from public.register_device('macos', '26.0', '0.1.0', 'hash-erin-session-end');
grant select on dev to authenticated;

-- The clock-out at the session end ----------------------------------------------------------

select is(pg_temp.send('clock_in', '{"reason": "manual"}', '300 minutes'), 'active', 'clocked in');
select is(pg_temp.send('clock_out', '{"reason": "session_end"}', '240 minutes'), 'off_shift',
  'a clock-out for the session end is accepted');

select pg_temp.act_as_postgres();
select is(
  (select end_reason from public.clock_sessions where user_id = :erin order by start_at desc limit 1),
  'session_end', 'and the shift keeps why it ended');
select is(pg_temp.tamper_secs(), '{}'::int[], 'a session end is not Tamper');

-- A clock-out reason the contract doesn't know is refused.
select pg_temp.act_as(:erin);
select is(
  (public.agent_events((select device_id from dev), jsonb_build_array(jsonb_build_object(
      'id', gen_random_uuid(), 'seq', 900, 'type', 'clock_out', 'at', pg_temp.ts('1 minute'),
      'mono_ms', 1, 'payload', jsonb_build_object('reason', 'logout')))))
    -> 'rejected' -> 0 ->> 'reason',
  'invalid_event', 'a clock-out reason outside the contract is rejected'
);

-- A restart report after a session end (the clock-out was not recorded) -----------------------

select is(pg_temp.send('clock_in', '{"reason": "manual"}', '200 minutes'), 'active', 'clocked in again');
select is(pg_temp.restart('session_end', '190 minutes', '30 minutes'), 'active',
  'the agent came back after a logout that left the shift open: working, not Tamper');
select is(pg_temp.tamper_secs(), '{}'::int[], 'a gap that ended with the session is never Tamper');

-- A kill still is: the control for the above.
select is(pg_temp.restart('killed', '20 minutes', '15 minutes'), 'active', 'killed and back');
select is(pg_temp.tamper_secs(), array[300], 'a kill is Tamper for the time it was down');

select * from finish();
rollback;
