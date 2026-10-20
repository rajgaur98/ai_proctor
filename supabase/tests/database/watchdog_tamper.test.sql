begin;
create extension if not exists pgtap with schema extensions;

-- #58: watchdog and tamper (ANT-01, AGT-07, STS rule 2). The status rules themselves
-- are covered by status_vectors and status_engine; this is the Tamper inputs:
-- restart reports from the watchdog, capture permissions, and heartbeat gaps.

select plan(36);

\set erin '''00000000-0000-4000-8000-0000000000c1'''
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

-- An agent_restart: the previous run was last alive `alive_ago` ago, and this one
-- starts `ago` ago.
create function pg_temp.restart(reason text, alive_ago interval, ago interval)
returns text
language sql as $$
  select pg_temp.send('agent_restart',
    jsonb_build_object('last_alive_at', pg_temp.ts(alive_ago), 'reason', reason), ago)
$$;

create function pg_temp.perm(screen text, camera text, ago interval) returns text
language sql as $$
  select pg_temp.send('permission_change', jsonb_build_object('screen', screen, 'camera', camera), ago)
$$;

-- Lengths in seconds of Erin's Tamper periods, oldest first.
create function pg_temp.tamper_secs() returns int[]
language sql as $$
  select coalesce(array_agg(round(extract(epoch from end_at - start_at))::int order by start_at), '{}')
  from public.status_periods
  where user_id = '00000000-0000-4000-8000-0000000000c1' and status = 'tamper' and end_at is not null
$$;

create function pg_temp.heartbeat(locked boolean default false) returns void
language plpgsql as $$
begin
  perform public.agent_heartbeat((select device_id from dev), now(), 0, locked, false, '0.1.0', '{}');
end;
$$;

select pg_temp.act_as(:erin);
create temp table dev as select device_id from public.register_device('macos', '26.0', '0.1.0', 'hash-erin-watchdog');
grant select on dev to authenticated;

-- Restart reports (ANT-01) ----------------------------------------------------------------

select is(pg_temp.send('clock_in', '{"reason": "manual"}', '200 minutes'), 'active', 'clocked in');

select is(pg_temp.restart('killed', '190 minutes', '185 minutes'), 'active',
  'the agent came back after a kill: working again');
select is(pg_temp.tamper_secs(), array[300],
  'a kill during the shift is Tamper from when the agent was last alive until it was back');

select pg_temp.restart('exited', '182 minutes', '180 minutes');
select pg_temp.restart('rebooted', '178 minutes', '175 minutes');
select is(pg_temp.tamper_secs(), array[300],
  'a normal exit or a reboot is not Tamper');

select is(pg_temp.send('clock_out', '{"reason": "manual"}', '170 minutes'), 'off_shift', 'clocked out');
select is(pg_temp.restart('killed', '168 minutes', '165 minutes'), 'off_shift',
  'a restart report off shift is accepted and changes nothing');
select is(pg_temp.tamper_secs(), array[300], 'no Tamper off shift');

-- The gap never starts before the clock-in.
select is(pg_temp.send('clock_in', '{"reason": "manual"}', '160 minutes'), 'active', 'clocked in again');
select is(pg_temp.restart('killed', '5 hours', '150 minutes'), 'active', 'a kill reported with an old last-alive time');
select is(pg_temp.tamper_secs(), array[300, 600],
  'Tamper starts at the clock-in at the earliest, not hours earlier');

-- A last-alive time after the restart is nonsense: nothing recorded.
select pg_temp.restart('killed', '140 minutes', '145 minutes');
select is(pg_temp.tamper_secs(), array[300, 600], 'a last-alive time in the future adds nothing');

-- A reason the contract doesn't know is refused.
select is(
  (public.agent_events((select device_id from dev), jsonb_build_array(jsonb_build_object(
      'id', gen_random_uuid(), 'seq', 900, 'type', 'agent_restart', 'at', pg_temp.ts('1 minute'),
      'mono_ms', 1, 'payload', jsonb_build_object('last_alive_at', pg_temp.ts('2 minutes'), 'reason', 'crashed')))))
    -> 'rejected' -> 0 ->> 'reason',
  'invalid_event', 'a restart reason outside the contract is rejected'
);

-- Capture permissions (AGT-07) ---------------------------------------------------------------

select is(pg_temp.perm('denied', 'granted', '130 minutes'), 'tamper', 'Screen Recording revoked while working: Tamper');
select is(pg_temp.perm('granted', 'granted', '125 minutes'), 'active', 'restored: working again');
select is(pg_temp.perm('granted', 'denied', '120 minutes'), 'tamper', 'camera off with the webcam on: Tamper');
select is(pg_temp.perm('granted', 'unsupported', '115 minutes'), 'active',
  'a permission this platform does not have is nothing to fix');
select is(pg_temp.perm('restricted', 'granted', '110 minutes'), 'tamper', 'restricted by the device: Tamper');
select is(pg_temp.perm('not_determined', 'granted', '105 minutes'), 'tamper', 'never asked yet: Tamper');
select is(pg_temp.perm('granted', 'granted', '100 minutes'), 'active', 'granted again');

-- The camera only counts while the webcam collection is on for this person.
select pg_temp.act_as_postgres();
update public.orgs set policy = policy || '{"webcam": false}' where id = :org;
select pg_temp.act_as(:erin);
select is(pg_temp.perm('granted', 'denied', '95 minutes'), 'active', 'camera off with the webcam setting off: not Tamper');
select is(pg_temp.perm('denied', 'denied', '92 minutes'), 'tamper', 'but Screen Recording still is');
select is(pg_temp.perm('granted', 'granted', '90 minutes'), 'active', 'both back');

-- Not clocked in: no Tamper, and a permission already missing shows at clock-in.
select is(pg_temp.send('clock_out', '{"reason": "manual"}', '85 minutes'), 'off_shift', 'clocked out');
select is(pg_temp.perm('denied', 'granted', '80 minutes'), 'off_shift', 'a permission missing off shift is not Tamper');
select is(pg_temp.send('clock_in', '{"reason": "manual"}', '75 minutes'), 'tamper',
  'clocking in with it still missing: Tamper from the start');
select is(pg_temp.perm('granted', 'granted', '70 minutes'), 'active', 'fixed during the shift: working again');

-- Heartbeat gaps (ANT-01) ----------------------------------------------------------------------

select pg_temp.act_as_postgres();
select is(
  (select array_agg(status::text order by start_at) from public.status_periods
   where user_id = :erin and start_at >= now() - interval '131 minutes'),
  array['tamper', 'active', 'tamper', 'active', 'tamper', 'active', 'tamper', 'active', 'off_shift', 'tamper',
        'active'],
  'the permission changes are in the timeline in order'
);
select is(
  (select count(*)::int from public.status_periods p1 join public.status_periods p2
     on p1.user_id = p2.user_id and p1.id <> p2.id
    and tstzrange(p1.start_at, coalesce(p1.end_at, 'infinity')) && tstzrange(p2.start_at, coalesce(p2.end_at, 'infinity'))
    where p1.user_id = :erin),
  0, 'status periods never overlap'
);

-- Silent for 10 minutes, but its queued events from then arrive first: offline, not killed.
update public.presence set last_contact_at = now() - interval '10 minutes' where user_id = :erin;
select pg_temp.act_as(:erin);
select pg_temp.send('unlock', '{}', '8 minutes');
select pg_temp.heartbeat();
select pg_temp.act_as_postgres();
select is((select count(*)::int from public.status_periods where user_id = :erin and status = 'tamper'
           and start_at > now() - interval '70 minutes'), 0,
  'queued events from the gap arrived: not a kill, no Tamper');

-- Silent while the screen was locked: the machine slept, nothing was killed.
update public.presence set last_contact_at = now() - interval '10 minutes', locked = true where user_id = :erin;
select pg_temp.act_as(:erin);
select pg_temp.heartbeat(true);
select pg_temp.act_as_postgres();
select is((select count(*)::int from public.status_periods where user_id = :erin and status = 'tamper'
           and start_at > now() - interval '70 minutes'), 0, 'a gap while locked is not Tamper');

-- Silent with nothing to explain it: Tamper for the gap, working again after.
update public.presence set last_contact_at = now() - interval '5 minutes', locked = false where user_id = :erin;
select pg_temp.act_as(:erin);
select pg_temp.heartbeat();
select pg_temp.act_as_postgres();
select is(pg_temp.tamper_secs(), array[300, 600, 300, 300, 600, 120, 300, 300],
  'an unexplained gap while clocked in is Tamper for the gap (5 minutes)');
select is((select status::text from public.presence where user_id = :erin), 'active', 'and the status is live again');

-- A restart report already says what happened: the heartbeat after it adds nothing.
select pg_temp.act_as(:erin);
select is(pg_temp.restart('killed', '4 minutes', '2 minutes'), 'active', 'killed and restarted two minutes ago');
select pg_temp.heartbeat();
select pg_temp.act_as_postgres();
select is(pg_temp.tamper_secs(), array[300, 600, 300, 300, 600, 120, 300, 300, 120],
  'the gap is recorded once, not again by the heartbeat');

-- No gap Tamper off shift.
select pg_temp.act_as(:erin);
select pg_temp.send('clock_out', '{"reason": "manual"}', '1 minute');
select pg_temp.act_as_postgres();
update public.presence set last_contact_at = now() - interval '30 minutes' where user_id = :erin;
select pg_temp.act_as(:erin);
select pg_temp.heartbeat();
select pg_temp.act_as_postgres();
select is(pg_temp.tamper_secs(), array[300, 600, 300, 300, 600, 120, 300, 300, 120],
  'a heartbeat gap off shift is not Tamper');

select is((select count(*)::int from public.agent_event_rejections where device_id = (select device_id from dev)), 1,
  'only the invalid one was rejected');

select * from finish();
rollback;
