begin;
create extension if not exists pgtap with schema extensions;

select plan(14);

select has_table('public', t, t || ' exists')
from unnest(array[
  'orgs', 'users', 'devices', 'shifts', 'agent_events_raw', 'checkin_events', 'presence', 'last_seen'
]) as t;

-- Every public table and partition has row-level security on.
select is_empty(
  $$ select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname in ('public', 'partitions') and c.relkind in ('r', 'p') and not c.relrowsecurity $$,
  'row-level security is enabled on every table and partition'
);

-- The current week has a partition, so the first agent event can be stored.
select isnt_empty(
  $$ select 1 from pg_inherits i
     join pg_class c on c.oid = i.inhrelid
     join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'partitions' and i.inhparent = 'public.agent_events_raw'::regclass
       and c.relname = 'agent_events_raw_p'
         || to_char(date_trunc('week', now() at time zone 'UTC'), 'YYYYMMDD') $$,
  'agent_events_raw has a partition for the current week'
);

select is(
  internal.ensure_weekly_partitions('public.agent_events_raw', now(), now()),
  0,
  'ensure_weekly_partitions is idempotent'
);

-- (id, at) is the key: a resend of the same event is rejected.
insert into public.devices (id, org_id, user_id, platform, os_version, agent_version, hardware_hash)
values ('00000000-0000-4000-8000-0000000000d1', '00000000-0000-4000-8000-000000000001',
        '00000000-0000-4000-8000-0000000000c1', 'macos', '26.0', '0.0.0', 'test');

insert into public.agent_events_raw (id, org_id, device_id, user_id, seq, type, at)
values ('00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-000000000001',
        '00000000-0000-4000-8000-0000000000d1', '00000000-0000-4000-8000-0000000000c1',
        1, 'clock_in', '2026-10-19T09:00:00Z'::timestamptz);

select throws_ok(
  $$ insert into public.agent_events_raw (id, org_id, device_id, user_id, seq, type, at)
     values ('00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-000000000001',
             '00000000-0000-4000-8000-0000000000d1', '00000000-0000-4000-8000-0000000000c1',
             1, 'clock_in', '2026-10-19T09:00:00Z'::timestamptz) $$,
  '23505',
  null,
  'duplicate (id, at) is rejected'
);

-- Misses never capture anything.
select throws_ok(
  $$ insert into public.checkin_events (id, org_id, user_id, device_id, scheduled_at, outcome, object_keys)
     values (gen_random_uuid(), '00000000-0000-4000-8000-000000000001',
             '00000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-0000000000d1',
             now(), 'miss', '{screen-1.webp}') $$,
  '23514',
  null,
  'a missed check-in cannot have captures'
);

-- Anonymous API callers see nothing.
set local role anon;
select is_empty('select * from public.users', 'anon cannot read users');
reset role;

select * from finish();
rollback;
