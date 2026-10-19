begin;
create extension if not exists pgtap with schema extensions;

select plan(22);

\set erin '''00000000-0000-4000-8000-0000000000c1'''

-- Acts as a user with the claims the access-token hook would mint (incl. org_id).
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

-- Sends one event `ago` before now and returns Erin's presence status afterwards.
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

select pg_temp.act_as(:erin);
create temp table dev as select device_id from public.register_device('macos', '26.0', '0.1.0', 'hash-erin-status');
grant select on dev to authenticated;

select is(pg_temp.send('clock_in', '{"reason": "manual"}', '60 minutes'), 'active', 'clocking in makes Erin Active');
select is(pg_temp.send('idle_start', jsonb_build_object('since', pg_temp.ts('55 minutes')), '55 minutes'), 'idle', 'idle');
select is(pg_temp.send('idle_end', '{}', '54 minutes'), 'active', 'input again: Active');
select is(pg_temp.send('call_start', '{"source": "camera"}', '50 minutes'), 'in_meeting', 'camera in use: In meeting');
select is(pg_temp.send('call_start', '{"source": "mic"}', '49 minutes'), 'in_meeting', 'mic too');
select is(pg_temp.send('call_end', '{"source": "camera"}', '45 minutes'), 'in_meeting', 'still on the mic');
select is(pg_temp.send('call_end', '{"source": "mic"}', '44 minutes'), 'active', 'call over: Active');
select is(pg_temp.send('lock', '{}', '40 minutes'), 'away_locked', 'locked: Away (Locked)');
select is(pg_temp.send('unlock', '{}', '35 minutes'), 'active', 'unlocked');
select is(pg_temp.send('checkin', jsonb_build_object('scheduled_at', pg_temp.ts('30 minutes'), 'outcome', 'miss',
  'wrong_clicks', 0, 'object_keys', '[]'::jsonb, 'flags', '[]'::jsonb), '30 minutes'), 'away', 'a missed check-in: Away');
select is(pg_temp.send('checkin', jsonb_build_object('scheduled_at', pg_temp.ts('25 minutes'), 'outcome', 'pass',
  'wrong_clicks', 0, 'object_keys', '[]'::jsonb, 'flags', '[]'::jsonb), '25 minutes'), 'active', 'a pass clears Away');
select is(pg_temp.send('break_start', '{"planned_min": 15}', '20 minutes'), 'on_break', 'On break');
select is(pg_temp.send('break_end', '{}', '15 minutes'), 'active', 'back from the break');
select is(pg_temp.send('permission_change', '{"screen": "denied", "camera": "granted"}', '12 minutes'), 'tamper',
  'Screen Recording revoked: Tamper');
select is(pg_temp.send('permission_change', '{"screen": "granted", "camera": "granted"}', '11 minutes'), 'active',
  'permission restored');

-- The timeline -----------------------------------------------------------------------

select pg_temp.act_as_postgres();
select is(
  (select array_agg(status::text order by start_at) from public.status_periods where user_id = :erin),
  array['active', 'idle', 'active', 'in_meeting', 'active', 'away_locked', 'active', 'away', 'active',
        'on_break', 'active', 'tamper', 'active'],
  'every change is recorded in status_periods, in order'
);
select is(
  (select count(*)::int from public.status_periods p1 join public.status_periods p2
     on p1.user_id = p2.user_id and p1.id <> p2.id
    and tstzrange(p1.start_at, coalesce(p1.end_at, 'infinity')) && tstzrange(p2.start_at, coalesce(p2.end_at, 'infinity'))
    where p1.user_id = :erin),
  0, 'status periods never overlap'
);

-- Offline sweep ------------------------------------------------------------------------

update public.presence set last_contact_at = now() - interval '5 minutes' where user_id = :erin;
select is(internal.offline_sweep(), 1, 'the sweep finds one silent user');
select is((select status::text from public.presence where user_id = :erin), 'offline', 'Erin is Offline');
select ok(exists (select 1 from cron.job where jobname = 'offline_sweep' and schedule = '* * * * *'),
  'offline_sweep runs every minute');

-- Heartbeat gap -----------------------------------------------------------------------

-- Agent silent for 10 minutes, no events from that time, not locked: killed.
update public.presence set last_contact_at = now() - interval '10 minutes' where user_id = :erin;
select pg_temp.act_as(:erin);
select is(
  (public.agent_heartbeat((select device_id from dev), now(), 0, false, false, '0.1.0', '{}')) ->> 'policy_version',
  '1', 'heartbeat after the gap is accepted'
);
select pg_temp.act_as_postgres();
select ok(
  exists (select 1 from public.status_periods where user_id = :erin and status = 'tamper'
          and end_at - start_at >= interval '9 minutes'),
  'the unexplained gap is recorded as Tamper; the status is live again afterwards'
);

select * from finish();
rollback;
