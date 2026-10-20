begin;
create extension if not exists pgtap with schema extensions;

select plan(7);

\set org '''00000000-0000-4000-8000-000000000001'''
\set max '''00000000-0000-4000-8000-0000000000b1'''
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

-- Erin: three check-ins today (2 passed, 1 missed) and one yesterday.
insert into public.devices (id, org_id, user_id, platform, os_version, agent_version, hardware_hash)
values ('00000000-0000-4000-8000-0000000000d1', :org, :erin, 'macos', '26', '0.1.0', 'hash-erin-grid');
insert into public.checkin_events (id, org_id, user_id, device_id, scheduled_at, outcome)
select gen_random_uuid(), :org, :erin, '00000000-0000-4000-8000-0000000000d1', t, o::public.checkin_outcome
from (values
  (date_trunc('day', now() at time zone 'America/Los_Angeles') at time zone 'America/Los_Angeles' + interval '1 minute', 'pass'),
  (date_trunc('day', now() at time zone 'America/Los_Angeles') at time zone 'America/Los_Angeles' + interval '2 minutes', 'pass'),
  (date_trunc('day', now() at time zone 'America/Los_Angeles') at time zone 'America/Los_Angeles' + interval '3 minutes', 'miss'),
  (date_trunc('day', now() at time zone 'America/Los_Angeles') at time zone 'America/Los_Angeles' - interval '1 hour', 'pass')
) v(t, o);
-- Two deferrals today (held for a call): not shown, so not counted (CHK-03).
insert into public.checkin_events (id, org_id, user_id, device_id, scheduled_at, outcome, deferral_reason)
select gen_random_uuid(), :org, :erin, '00000000-0000-4000-8000-0000000000d1',
  date_trunc('day', now() at time zone 'America/Los_Angeles') at time zone 'America/Los_Angeles' + m * interval '1 minute',
  'deferred', 'call'
from (values (4), (5)) v(m);
update public.presence set status = 'active', since = now() where user_id = :erin;

select pg_temp.act_as(:max);
select is((select array_agg(full_name order by full_name) from public.team_live),
  array['Erin Employee', 'Lucas Martin', 'Max Manager'], 'a manager sees their team, not the whole org');
select is((select checkins_shown_today from public.team_live where user_id = :erin), 3,
  'today counts only check-ins since midnight in the employee''s time zone');
select is((select checkins_passed_today from public.team_live where user_id = :erin), 2, 'and how many passed');
select is((select checkins_shown_today from public.team_live where user_id = :erin), 3,
  'deferred check-ins are not counted as shown');
select is((select status::text from public.team_live where user_id = :erin), 'active', 'live status comes from presence');

select pg_temp.act_as(:erin);
select is((select count(*)::int from public.team_live), 1, 'an employee sees only their own row');

select set_config('role', 'anon', true);
select set_config('request.jwt.claims', '', true);
select is_empty('select 1 from public.team_live', 'anon sees nothing');

select set_config('role', 'postgres', true);
select * from finish();
rollback;
