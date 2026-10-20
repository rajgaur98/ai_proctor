begin;
create extension if not exists pgtap with schema extensions;

-- #160: why a status is Tamper (AGT-07, ANT-01, ANT-08, DSH-03). The status rules
-- stay one Tamper (status_vectors); this is the reason each path records on the
-- status period, on presence, on the live grid and in the alert.

select plan(19);

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

create function pg_temp.send(type text, payload jsonb default '{}', ago interval default '0')
returns void
language plpgsql as $$
declare
  n int;
begin
  update seqs set n = seqs.n + 1 returning seqs.n into n;
  perform public.agent_events(
    (select device_id from dev),
    jsonb_build_array(jsonb_build_object('id', gen_random_uuid(), 'seq', n, 'type', type,
      'at', pg_temp.ts(ago), 'mono_ms', n, 'payload', payload)));
end;
$$;

create function pg_temp.perm(screen text, ago interval) returns void
language sql as $$
  select pg_temp.send('permission_change', jsonb_build_object('screen', screen, 'camera', 'granted'), ago)
$$;

create function pg_temp.heartbeat() returns void
language plpgsql as $$
begin
  perform public.agent_heartbeat((select device_id from dev), now(), 0, false, false, '0.1.0', '{}');
end;
$$;

-- Erin's Tamper periods, oldest first: reason and length in seconds.
create function pg_temp.tampers() returns text[]
language sql as $$
  select coalesce(array_agg(coalesce(reason::text, 'none') || ':' || round(extract(epoch from end_at - start_at))::int
                            order by start_at), '{}')
  from public.status_periods
  where user_id = '00000000-0000-4000-8000-0000000000c1' and status = 'tamper' and end_at is not null
$$;

create function pg_temp.presence_reason() returns text
language sql as $$
  select coalesce(tamper_reason::text, 'none') from public.presence
  where user_id = '00000000-0000-4000-8000-0000000000c1'
$$;

select pg_temp.act_as(:erin);
create temp table dev as select device_id from public.register_device('macos', '26.0', '0.1.0', 'hash-erin-reason');
grant select on dev to authenticated;

select pg_temp.send('clock_in', '{"reason": "manual"}', '200 minutes');

-- A missing permission: capture blocked, live on presence and the grid ------------------------

select pg_temp.perm('denied', '190 minutes');
select is(pg_temp.presence_reason(), 'capture_blocked', 'a missing permission: presence says capture blocked');
select is((select tamper_reason::text from public.team_live where user_id = :erin), 'capture_blocked',
  'and so does the live grid row');
select is(
  (select reason::text from public.status_periods where user_id = :erin and end_at is null),
  'capture_blocked', 'the open Tamper period carries it');

select pg_temp.perm('granted', '185 minutes');
select is(pg_temp.presence_reason(), 'none', 'permission back: no reason on presence');
select is(pg_temp.tampers(), array['capture_blocked:300'], 'the closed period keeps capture_blocked');
select is(
  (select count(*)::int from public.status_periods
   where user_id = :erin and status <> 'tamper' and reason is not null),
  0, 'only Tamper periods carry a reason');

-- A kill: agent stopped ----------------------------------------------------------------------

select pg_temp.send('agent_restart',
  jsonb_build_object('last_alive_at', pg_temp.ts('180 minutes'), 'reason', 'killed'), '175 minutes');
select is(pg_temp.tampers(), array['capture_blocked:300', 'agent_stopped:300'],
  'a killed agent: Tamper with the reason agent_stopped');
select is(pg_temp.presence_reason(), 'none', 'the gap is over: nothing on presence');

select pg_temp.send('agent_restart',
  jsonb_build_object('last_alive_at', pg_temp.ts('172 minutes'), 'reason', 'exited'), '170 minutes');
select is(pg_temp.tampers(), array['capture_blocked:300', 'agent_stopped:300'], 'a normal exit adds none');

-- A kill while a permission is still missing: the gap, then capture blocked again.
select pg_temp.perm('denied', '165 minutes');
select pg_temp.send('agent_restart',
  jsonb_build_object('last_alive_at', pg_temp.ts('163 minutes'), 'reason', 'killed'), '160 minutes');
select is(pg_temp.presence_reason(), 'capture_blocked', 'still blocked after the restart: capture blocked again');
select is(
  (select array_agg(reason::text order by start_at) from public.status_periods
   where user_id = :erin and status = 'tamper' and start_at >= now() - interval '166 minutes'),
  array['capture_blocked', 'agent_stopped', 'capture_blocked'],
  'in order: blocked, the gap, blocked again');
select pg_temp.perm('granted', '150 minutes');

-- A heartbeat gap: no heartbeat ----------------------------------------------------------------

select pg_temp.act_as_postgres();
update public.presence set last_contact_at = now() - interval '5 minutes' where user_id = :erin;
select pg_temp.act_as(:erin);
select pg_temp.heartbeat();
select pg_temp.act_as_postgres();
select is((pg_temp.tampers())[array_length(pg_temp.tampers(), 1)], 'no_heartbeat:300',
  'an unexplained gap while clocked in: Tamper with the reason no_heartbeat');
select is(pg_temp.presence_reason(), 'none', 'the heartbeat is back: nothing on presence');
select is((select status::text from public.presence where user_id = :erin), 'active', 'and the status is live again');

-- A heartbeat gap with a permission still missing opens Tamper again, as capture blocked.
select pg_temp.act_as(:erin);
select pg_temp.perm('denied', '1 minute');
select pg_temp.act_as_postgres();
update public.presence set last_contact_at = now() - interval '5 minutes' where user_id = :erin;
select pg_temp.act_as(:erin);
select pg_temp.heartbeat();
select pg_temp.act_as_postgres();
select is(pg_temp.presence_reason(), 'capture_blocked', 'a gap with the permission still missing: capture blocked after it');
select is(
  (select count(*)::int from public.status_periods where user_id = :erin and end_at is null and reason = 'capture_blocked'),
  1, 'with an open period for it');

-- Alerts carry the reason ----------------------------------------------------------------------

select pg_temp.act_as_postgres();
delete from public.alerts;
insert into public.status_periods (org_id, user_id, status, reason, start_at, end_at)
values (:org, :erin, 'tamper', 'agent_stopped', now() - interval '40 minutes', now() - interval '35 minutes');
select internal.alert_eval();
select ok(
  exists (select 1 from public.alerts where kind = 'tamper' and user_id = :erin
          and details ->> 'reason' = 'capture_blocked'),
  'the open capture-blocked period raises an alert with its reason');
select ok(
  exists (select 1 from public.alerts where kind = 'tamper' and user_id = :erin
          and details ->> 'reason' = 'no_heartbeat'),
  'a heartbeat-gap period recorded within the hour raises one with no_heartbeat');
select ok(
  exists (select 1 from public.alerts where kind = 'tamper' and user_id = :erin
          and details ->> 'reason' = 'agent_stopped'),
  'and a killed-agent period with agent_stopped');

select * from finish();
rollback;
