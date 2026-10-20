begin;
create extension if not exists pgtap with schema extensions;

select plan(14);

-- A screen share or a presentation is a call source like the camera and the mic
-- (STS rule 8): In meeting while any source is on, and one Meeting period however
-- the sources overlap.

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

-- Sends one event `ago` before now; returns Erin's presence status afterwards.
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
create temp table dev as select device_id from public.register_device('macos', '26.0', '0.1.0', 'hash-erin-share');
grant select on dev to authenticated;

select is(pg_temp.send('clock_in', '{"reason": "manual"}', '90 minutes'), 'active', 'clocked in: Active');

-- A share alone.
select is(pg_temp.send('call_start', '{"source": "screen_share"}', '80 minutes'), 'in_meeting', 'sharing the screen: In meeting');
select is(pg_temp.send('call_end', '{"source": "screen_share"}', '70 minutes'), 'active', 'share over: Active');

-- A presentation alone.
select is(pg_temp.send('call_start', '{"source": "presenting"}', '65 minutes'), 'in_meeting', 'presenting: In meeting');
select is(pg_temp.send('call_end', '{"source": "presenting"}', '60 minutes'), 'active', 'presentation over: Active');

-- A call and a share overlapping: In meeting until both have ended.
select is(pg_temp.send('call_start', '{"source": "mic"}', '55 minutes'), 'in_meeting', 'a call starts');
select is(pg_temp.send('call_start', '{"source": "screen_share"}', '50 minutes'), 'in_meeting', 'a share starts during the call');
select is(pg_temp.send('call_end', '{"source": "mic"}', '40 minutes'), 'in_meeting', 'the call ends, the share keeps the meeting going');
select is(pg_temp.send('call_end', '{"source": "screen_share"}', '35 minutes'), 'active', 'both over: Active');

-- Sharing switches to presenting: the new source starts before the old one ends.
select is(pg_temp.send('call_start', '{"source": "screen_share"}', '30 minutes'), 'in_meeting', 'sharing again');
select is(pg_temp.send('call_start', '{"source": "presenting"}', '25 minutes'), 'in_meeting', 'a presentation opens');
select is(pg_temp.send('call_end', '{"source": "screen_share"}', '25 minutes'), 'in_meeting', 'the share closes in the same moment, still In meeting');
select is(pg_temp.send('call_end', '{"source": "presenting"}', '20 minutes'), 'active', 'presentation over: Active');

select pg_temp.act_as_postgres();
select is(
  (select array_agg(status::text order by start_at) from public.status_periods where user_id = :erin),
  array['active', 'in_meeting', 'active', 'in_meeting', 'active', 'in_meeting', 'active', 'in_meeting', 'active'],
  'one In meeting period per run of overlapping sources, no gaps or zero-length periods between them'
);

select * from finish();
rollback;
