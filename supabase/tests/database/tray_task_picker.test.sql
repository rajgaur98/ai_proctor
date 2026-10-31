-- #268: the tray's task picker (PRJ-05). agent_config lists each project's active tasks,
-- a project_switch may carry a task_id (older agents leave it out), and segment_inputs
-- passes the task on only when it is a task of the switch's project in the person's org:
-- any other task_id is ignored, never rejected (the switch still counts for its project).
begin;
create extension if not exists pgtap with schema extensions;

select plan(17);

\set ada '''00000000-0000-4000-8000-0000000000a1'''
\set max '''00000000-0000-4000-8000-0000000000b1'''
\set erin '''00000000-0000-4000-8000-0000000000c1'''
\set revamp '''00000000-0000-4000-8000-0000000000f1'''
\set internal '''00000000-0000-4000-8000-0000000000f2'''
\set org2 '''00000000-0000-4000-8000-000000000002'''

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

create function pg_temp.task(p_name text) returns uuid
language sql security definer as $$ select id from public.project_tasks where name = p_name $$;
grant execute on function pg_temp.task(text) to authenticated;

create function pg_temp.user_v(uid uuid) returns int
language sql security definer as $$ select config_version from public.users where id = uid $$;

-- Tasks: two on the revamp (one archived later), one on Internal, one in another org.
select pg_temp.act_as(:max);
select public.save_task(null, :revamp, 'Design');
select public.save_task(null, :revamp, 'Build');
select public.save_task(null, :revamp, 'Old work');
select pg_temp.act_as(:ada);
select public.save_task(null, :internal, 'Hiring');

select pg_temp.act_as_postgres();
insert into public.orgs (id, name) values (:org2, 'Other Co');
insert into public.projects (id, org_id, name, billable)
values ('00000000-0000-4000-8000-0000000002f1', :org2, 'Their project', true);
insert into public.project_tasks (org_id, project_id, name, billable)
values (:org2, '00000000-0000-4000-8000-0000000002f1', 'Their task', true);

-- A config change: saving a task refetches the project's members --------------------------------

create temp table v0 as select pg_temp.user_v(:erin) as v;
select pg_temp.act_as(:max);
select public.save_task(pg_temp.task('Old work'), :revamp, 'Old work', null, true);
select pg_temp.act_as_postgres();
select ok(pg_temp.user_v(:erin) > (select v from v0), 'archiving a task moves the members'' config_version');
create temp table v1 as select pg_temp.user_v(:erin) as v;
update public.project_tasks set name = name where name = 'Design';
select is(pg_temp.user_v(:erin), (select v from v1), 'a save that changes nothing does not');
update public.project_tasks set sort_order = 99 where name = 'Their task';
select is(pg_temp.user_v(:erin), (select v from v1), 'another project''s task does not move hers');

-- What the agent gets ------------------------------------------------------------------------

select pg_temp.act_as(:erin);
create temp table dev as select device_id from public.register_device('macos', '26.0', '0.1.0', 'hash-erin-tasks');
grant select on dev to authenticated;
create temp table cfg as select public.agent_config((select device_id from dev)) -> 'projects' as projects;
grant select on cfg to authenticated;

select is(
  (select p -> 'tasks' from cfg, jsonb_array_elements(cfg.projects) p where p ->> 'id' = :revamp),
  jsonb_build_array(
    jsonb_build_object('id', pg_temp.task('Design'), 'name', 'Design', 'sort_order', 0),
    jsonb_build_object('id', pg_temp.task('Build'), 'name', 'Build', 'sort_order', 1)),
  'agent_config: a project''s active tasks, in order, without the archived one');
select is(
  (select jsonb_agg(t ->> 'name') from cfg, jsonb_array_elements(cfg.projects) p,
     jsonb_array_elements(p -> 'tasks') t where p ->> 'id' = :internal),
  '["Hiring"]'::jsonb, 'agent_config: each project has its own');
select ok(
  (select bool_and(p ? 'tasks' and jsonb_typeof(p -> 'tasks') = 'array')
   from cfg, jsonb_array_elements(cfg.projects) p),
  'agent_config: every project has a tasks list (empty when none)');

-- Events: task_id is optional and checked by segment_inputs, not refused -------------------------

select is(pg_temp.send((select device_id from dev), 'clock_in',
  jsonb_build_object('reason', 'manual', 'project_id', :revamp), '50 minutes'), null, 'clock in on the revamp');
select is(pg_temp.send((select device_id from dev), 'project_switch',
  jsonb_build_object('project_id', :revamp, 'task_id', pg_temp.task('Design')), '45 minutes'), null,
  'a task change on the same project validates and is accepted');
select is(pg_temp.send((select device_id from dev), 'project_switch',
  jsonb_build_object('project_id', :internal), '40 minutes'), null,
  'a switch without task_id (an older agent) still validates');
select is(pg_temp.send((select device_id from dev), 'project_switch',
  jsonb_build_object('project_id', :internal, 'task_id', null), '38 minutes'), null,
  'a null task_id validates');
select is(pg_temp.send((select device_id from dev), 'project_switch',
  jsonb_build_object('project_id', :internal, 'task_id', 'Design'), '37 minutes'), 'invalid_event',
  'a task_id that is not a uuid is refused by the contract');
select is(pg_temp.send((select device_id from dev), 'project_switch',
  jsonb_build_object('project_id', :internal, 'task_id', pg_temp.task('Their task')), '35 minutes'), null,
  'another org''s task is accepted for the project (the task is ignored)');
select is(pg_temp.send((select device_id from dev), 'project_switch',
  jsonb_build_object('project_id', :internal, 'task_id', pg_temp.task('Build')), '30 minutes'), null,
  'another project''s task is accepted for the project (the task is ignored)');
select is((select project_id from public.presence where user_id = :erin), :internal::uuid,
  'the project still switched');
select is(pg_temp.send((select device_id from dev), 'project_switch',
  jsonb_build_object('project_id', :internal, 'task_id', pg_temp.task('Hiring')), '25 minutes'), null,
  'a task of the project');
select pg_temp.send((select device_id from dev), 'clock_out', '{"reason": "manual"}', '20 minutes');

-- What buildSegments gets ----------------------------------------------------------------------

select pg_temp.act_as_postgres();
-- The days of the first and the last switch (the same day unless the test runs near midnight).
create temp table switches as
select distinct s from (values (interval '50 minutes'), (interval '0 minutes')) d(ago),
  jsonb_array_elements(
    public.segment_inputs(:erin, ((now() - d.ago) at time zone
      (select timezone from public.users where id = :erin))::date) -> 'input' -> 'projectSwitches') s;
select is(
  (select jsonb_agg(jsonb_build_array(s ->> 'projectId', s ->> 'taskId') order by (s ->> 'at')::bigint)
   from switches),
  (select jsonb_agg(x order by n) from (values
     (1, jsonb_build_array(:revamp::text, pg_temp.task('Design')::text)),
     (2, jsonb_build_array(:internal::text, null::text)),
     (3, jsonb_build_array(:internal::text, null::text)),
     (4, jsonb_build_array(:internal::text, null::text)),
     (5, jsonb_build_array(:internal::text, null::text)),
     (6, jsonb_build_array(:internal::text, pg_temp.task('Hiring')::text))) v(n, x)),
  'segment_inputs: the switch''s task when it is the project''s, null for none or a foreign one');
select ok((select count(*) from switches) = 6, 'segment_inputs: every accepted switch, none lost');

select * from finish();
rollback;
