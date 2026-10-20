begin;
create extension if not exists pgtap with schema extensions;

select plan(15);

\set ada '''00000000-0000-4000-8000-0000000000a1'''
\set max '''00000000-0000-4000-8000-0000000000b1'''
\set erin '''00000000-0000-4000-8000-0000000000c1'''
\set lucas '''00000000-0000-4000-8000-0000000000c2'''
\set revamp '''00000000-0000-4000-8000-0000000000f1'''
\set internal '''00000000-0000-4000-8000-0000000000f2'''

create function pg_temp.act_as(uid uuid) returns void
language sql as $$
  select set_config('role', 'postgres', true);
  select set_config('request.jwt.claims',
    (internal.custom_access_token_hook(jsonb_build_object(
      'user_id', uid, 'claims', jsonb_build_object('sub', uid, 'role', 'authenticated')
    )) -> 'claims')::text, true);
  select set_config('role', 'authenticated', true);
$$;

create function pg_temp.ts(ago interval) returns text
language sql as $$ select to_char((now() - ago) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') $$;

create temp table seqs (n int);
insert into seqs values (0);
grant all on seqs to authenticated;

-- Sends one event as the caller's agent; returns the rejection reason or null.
create function pg_temp.send(dev uuid, type text, payload jsonb, ago interval)
returns text
language plpgsql as $$
declare
  n int;
begin
  update seqs set n = seqs.n + 1 returning seqs.n into n;
  return public.agent_events(dev, jsonb_build_array(jsonb_build_object('id', gen_random_uuid(),
    'seq', n, 'type', type, 'at', pg_temp.ts(ago), 'mono_ms', n, 'payload', payload)))
    -> 'rejected' -> 0 ->> 'reason';
end;
$$;

-- Managing the list ---------------------------------------------------------------------

select pg_temp.act_as(:erin);
select throws_ok($$ select public.save_project(null, 'Side gig') $$, '42501', 'manager_or_admin_only',
  'an employee cannot create projects');
select is((select count(*)::int from public.projects), 2, 'but reads the org''s projects');

select pg_temp.act_as(:max);
create temp table made as select public.save_project(null, 'Mobile app',
  '00000000-0000-4000-8000-0000000000e1', true) as id;
grant select on made to authenticated;
select ok((select id from made) is not null, 'a manager creates a project for a client');
select throws_ok($$ select public.save_project(null, 'mobile APP', '00000000-0000-4000-8000-0000000000e1') $$,
  '23505', 'name_taken', 'names are unique per client, ignoring case');
select lives_ok($$ select public.set_project_members((select id from made),
  array['00000000-0000-4000-8000-0000000000c1'::uuid]) $$, 'he assigns his report');
select throws_ok($$ select public.set_project_members((select id from made),
  array['00000000-0000-4000-8000-0000000000a1'::uuid]) $$,
  '42501', 'user_not_visible', 'but not people outside his team');

-- What the agent gets and may use --------------------------------------------------------

select pg_temp.act_as(:erin);
create temp table dev as select device_id from public.register_device('macos', '26.0', '0.1.0', 'hash-erin-projects');
grant select on dev to authenticated;
select is(
  (select jsonb_agg(p ->> 'name' order by p ->> 'name')
   from jsonb_array_elements(public.agent_config((select device_id from dev)) -> 'projects') p),
  '["Internal", "Mobile app", "Website revamp"]'::jsonb,
  'agent_config lists the projects she can log to'
);

select is(pg_temp.send((select device_id from dev), 'clock_in',
  jsonb_build_object('reason', 'manual', 'project_id', :revamp), '30 minutes'), null, 'clock in on a project');
select is((select project_id from public.clock_sessions where user_id = :erin and end_at is null),
  :revamp::uuid, 'the shift carries the project');
select is(pg_temp.send((select device_id from dev), 'project_switch',
  jsonb_build_object('project_id', :internal), '20 minutes'), null, 'switch to another of hers');
select is((select project_id from public.presence where user_id = :erin), :internal::uuid,
  'presence shows the current project');
select is(pg_temp.send((select device_id from dev), 'project_switch',
  jsonb_build_object('project_id', gen_random_uuid()), '10 minutes'), 'project_not_allowed',
  'a project she isn''t on is refused');
select is(pg_temp.send((select device_id from dev), 'project_switch',
  jsonb_build_object('project_id', null), '9 minutes'), null, 'back to Unassigned');
select pg_temp.send((select device_id from dev), 'clock_out', '{"reason": "manual"}', '8 minutes');

-- PRJ-03: a project she may not use doesn't lose the clock-in; it's Unassigned.
select is(pg_temp.send((select device_id from dev), 'clock_in',
  jsonb_build_object('reason', 'manual', 'project_id', gen_random_uuid()), '5 minutes'), null,
  'clock-in with a foreign project is accepted');
select is((select project_id from public.clock_sessions where user_id = :erin and end_at is null),
  null, 'and recorded as Unassigned');

select * from finish();
rollback;
