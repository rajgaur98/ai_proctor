-- #256: import_apply applies an import all or nothing, as the importing admin, through the
-- one-at-a-time RPCs (their rules and audit events), and records import.applied.
begin;
create extension if not exists pgtap with schema extensions;

select plan(28);

\set ada '''00000000-0000-4000-8000-0000000000a1'''
\set max '''00000000-0000-4000-8000-0000000000b1'''
\set erin '''00000000-0000-4000-8000-0000000000c1'''
\set lucas '''00000000-0000-4000-8000-0000000000c2'''
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

-- The DETAIL of the error a statement raises (null when it doesn't raise).
create function pg_temp.detail_of(sql text) returns text
language plpgsql as $$
declare
  v text;
begin
  execute sql;
  return null;
exception when others then
  get stacked diagnostics v = pg_exception_detail;
  return v;
end;
$$;

-- Who may import ---------------------------------------------------------------------------

select pg_temp.act_as(:max);
select throws_ok(
  $$ select public.import_apply('{"kind":"clients","items":[{"rows":[2],"action":"create","name":"Globex","archived":false}]}') $$,
  '42501', 'admin_only', 'a manager can''t import');
select pg_temp.act_as(:erin);
select throws_ok(
  $$ select public.import_apply('{"kind":"clients","items":[{"rows":[2],"action":"create","name":"Globex","archived":false}]}') $$,
  '42501', 'admin_only', 'an employee can''t import');

select pg_temp.act_as(:ada);
select throws_ok($$ select public.import_apply('{"kind":"holidays","items":[]}') $$,
  '22023', 'invalid_import', 'an unknown kind is refused');

-- Clients and projects ----------------------------------------------------------------------

select is(
  public.import_apply('{"kind":"clients","items":[
    {"rows":[2],"action":"create","name":"Globex","archived":false},
    {"rows":[3],"action":"update","name":"northwind","archived":true}]}'),
  '{"kind":"clients","created":1,"updated":1}'::jsonb,
  'an admin imports clients and gets the counts');
select pg_temp.act_as_postgres();
select is((select array_agg(name || ':' || archived order by name) from public.clients where org_id = :org),
  array['Globex:false', 'Northwind:true'], 'new clients are created and existing ones matched by name, any case');

select pg_temp.act_as(:ada);
select lives_ok($$ select public.import_apply('{"kind":"projects","items":[
    {"rows":[2],"action":"create","name":"Apollo","client":"Globex","billable":false,"archived":false,"members":["erin@acme.test"]},
    {"rows":[3],"action":"update","name":"website REVAMP","client":"Northwind","billable":true,"archived":false,"members":["manager@acme.test"]}]}') $$,
  'an admin imports projects');
select pg_temp.act_as_postgres();
select is((select billable from public.projects where name = 'Apollo'), false, 'a new project gets its values');
select is(
  (select array_agg(u.email order by u.email) from public.project_members m
   join public.users u on u.id = m.user_id
   join public.projects p on p.id = m.project_id where p.name = 'Website revamp'),
  array['erin@acme.test', 'lucas@acme.test', 'manager@acme.test'],
  'listed members are added and nobody is removed');

-- All or nothing ----------------------------------------------------------------------------

select pg_temp.act_as(:ada);
select is(
  pg_temp.detail_of($$ select public.import_apply('{"kind":"projects","items":[
    {"rows":[2],"action":"create","name":"Hermes","client":null,"billable":true,"archived":false,"members":[]},
    {"rows":[3,4],"action":"create","name":"Zeus","client":"Nobody Inc","billable":true,"archived":false,"members":[]}]}') $$),
  'rows: 3,4', 'a failing item names its rows in DETAIL');
select throws_ok($$ select public.import_apply('{"kind":"projects","items":[
    {"rows":[2],"action":"create","name":"Hermes","client":null,"billable":true,"archived":false,"members":[]},
    {"rows":[3],"action":"create","name":"Zeus","client":"Nobody Inc","billable":true,"archived":false,"members":[]}]}') $$,
  '22023', 'client_not_found', 'and keeps its error');
select pg_temp.act_as_postgres();
select is((select count(*)::int from public.projects where name = 'Hermes'), 0,
  'nothing from a failed import is written');

-- Teams, and importing twice ------------------------------------------------------------------

select pg_temp.act_as(:ada);
select lives_ok($$ select public.import_apply('{"kind":"teams","items":[
    {"rows":[2],"action":"create","name":"Support","members":["erin@acme.test","LUCAS@acme.test"]}]}') $$,
  'an admin imports a team with members');
select lives_ok($$ select public.import_apply('{"kind":"teams","items":[
    {"rows":[2],"action":"update","name":"support","members":["erin@acme.test"]}]}') $$,
  'and imports it again');
select pg_temp.act_as_postgres();
select is((select count(*)::int from public.teams where org_id = :org), 1, 're-importing doesn''t duplicate the team');
select is(
  (select array_agg(u.email order by u.email) from public.users u join public.teams t on t.id = u.team_id),
  array['erin@acme.test', 'lucas@acme.test'], 'and only adds: Lucas stays in it');
select is((select count(*)::int from public.audit_log where action = 'member.team_changed'), 2,
  'each move is audited once, as set_team_members does');

-- Shifts -----------------------------------------------------------------------------------

select pg_temp.act_as(:ada);
select lives_ok($$ select public.import_apply('{"kind":"shifts","items":[
    {"rows":[2,3],"action":"update","email":"Lucas@acme.test","shifts":[
      {"days":[1,2,3],"start":"08:00","end":"16:00","timezone":"America/Chicago"},
      {"days":[6],"start":"22:00","end":"02:00","timezone":"America/Chicago"}]}]}') $$,
  'an admin imports shifts');
select pg_temp.act_as_postgres();
select is((select count(*)::int from public.shifts where user_id = :lucas), 2, 'a person''s shifts become the file''s');

-- People -----------------------------------------------------------------------------------

select pg_temp.act_as(:ada);
select throws_ok($$ select public.import_apply('{"kind":"people","items":[
    {"rows":[2],"action":"create","email":"nora@acme.test","full_name":"Nora New","role":"employee",
     "manager_email":"manager@acme.test","team":null,"work_country":"US","work_state":"NY","timezone":"America/New_York"}]}') $$,
  '22023', 'invite_required', 'a new person needs an Auth user from the import-people function');

-- An Auth user the function would have made (invited, never signed in), and one who has.
select pg_temp.act_as_postgres();
insert into auth.users (instance_id, id, aud, role, email, invited_at)
values ('00000000-0000-0000-0000-000000000000', '00000000-0000-4000-8000-0000000000d7',
        'authenticated', 'authenticated', 'nora@acme.test', now()),
       ('00000000-0000-0000-0000-000000000000', '00000000-0000-4000-8000-0000000000d8',
        'authenticated', 'authenticated', 'someone@else.test', now());
update auth.users set email_confirmed_at = now(), last_sign_in_at = now()
where id = '00000000-0000-4000-8000-0000000000d8';

select pg_temp.act_as(:ada);
select throws_ok($$ select public.import_apply('{"kind":"people","items":[
    {"rows":[2],"action":"create","email":"nora@acme.test","full_name":"Nora New","role":"employee",
     "manager_email":"manager@acme.test","team":null,"work_country":"US","work_state":"NY","timezone":"America/New_York"}]}',
    '{"nora@acme.test":"00000000-0000-4000-8000-0000000000d8"}') $$,
  '42501', 'invalid_new_user', 'someone else''s account can''t be attached');

select is(
  public.import_apply('{"kind":"people","items":[
    {"rows":[2],"action":"create","email":"nora@acme.test","full_name":"Nora New","role":"manager",
     "manager_email":"admin@acme.test","team":"Support","work_country":"US","work_state":"NY","timezone":"America/New_York"},
    {"rows":[3],"action":"update","email":"lucas@acme.test","full_name":"Lucas Martin","role":"employee",
     "manager_email":"nora@acme.test","team":"support","work_country":"IN","work_state":null,"timezone":"Asia/Kolkata"}]}',
    '{"nora@acme.test":"00000000-0000-4000-8000-0000000000d7"}'),
  '{"kind":"people","created":1,"updated":1}'::jsonb,
  'an admin invites a new manager and moves someone under them in one import');
select pg_temp.act_as_postgres();
select is((select role::text || ':' || coalesce(t.name, '-') from public.users u left join public.teams t on t.id = u.team_id
           where u.email = 'nora@acme.test'), 'manager:Support', 'the new person has their role and team');
select is((select (select email from public.users m where m.id = u.manager_id) || ':' || u.work_country
           from public.users u where u.id = :lucas), 'nora@acme.test:IN', 'the update is applied');
select is(
  (select array_agg(action order by id) from public.audit_log
   where action in ('member.invited', 'member.manager_changed', 'member.location_changed')),
  array['member.invited', 'member.manager_changed', 'member.location_changed'],
  'the per-person audit events are the usual ones');

-- Max made an employee in the same file that moves Erin away: applied after the move.
select pg_temp.act_as(:ada);
select lives_ok($$ select public.import_apply('{"kind":"people","items":[
    {"rows":[2],"action":"update","email":"manager@acme.test","full_name":"Max Manager","role":"employee",
     "manager_email":"admin@acme.test","team":null,"work_country":"US","work_state":"IL","timezone":"America/Chicago"},
    {"rows":[3],"action":"update","email":"erin@acme.test","full_name":"Erin Employee","role":"employee",
     "manager_email":"admin@acme.test","team":"Support","work_country":"US","work_state":"CA","timezone":"America/Los_Angeles"}]}') $$,
  'demoting a manager waits for their reports to move');

select pg_temp.act_as_postgres();
select is(
  (select array_agg(metadata - 'rows' order by id) from public.audit_log where action = 'import.applied'),
  array[
    '{"kind":"clients","created":1,"updated":1}', '{"kind":"projects","created":1,"updated":1}',
    '{"kind":"teams","created":1,"updated":0}', '{"kind":"teams","created":0,"updated":1}',
    '{"kind":"shifts","created":0,"updated":1}', '{"kind":"people","created":1,"updated":1}',
    '{"kind":"people","created":0,"updated":2}']::jsonb[],
  'every applied import is audited with its counts, failed ones not at all');
select is((select metadata ->> 'rows' from public.audit_log where action = 'import.applied'
           and metadata ->> 'kind' = 'shifts'), '2', 'with the number of file rows');
select is((select count(*)::int from public.audit_log where action = 'import.applied' and actor_id = :ada), 7,
  'by the admin who imported');

select * from finish();
rollback;
