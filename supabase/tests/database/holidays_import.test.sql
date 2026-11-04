-- #319: import_apply's holidays kind (LV-02). Each item goes through save_holiday as the
-- importing admin: matched on date and place, added or renamed, audited and applied to
-- the affected people like a holiday entered by hand; one bad item undoes the whole import.
begin;
create extension if not exists pgtap with schema extensions;

select plan(19);

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

-- One holidays payload: items as a JSON array.
create function pg_temp.payload(items text) returns jsonb
language sql as $$ select jsonb_build_object('kind', 'holidays', 'items', items::jsonb) $$;

create function pg_temp.config_version(uid uuid) returns int
language sql security definer as $$ select config_version from public.users where id = uid $$;

-- Fixtures: two holidays that are already in the calendar.
insert into public.holidays (org_id, day, name, country, state)
values (:org, '2031-12-25', 'Christmas', null, null),
       (:org, '2031-07-04', 'Independence Day', 'US', null);

-- Who may import -----------------------------------------------------------------------------

select pg_temp.act_as(:max);
select throws_ok(format('select public.import_apply(%L)', pg_temp.payload('[{"rows":[2],"action":"create",
    "day":"2031-05-05","name":"Nope","country":null,"state":null}]')),
  '42501', 'admin_only', 'a manager can''t import holidays');
select pg_temp.act_as(:erin);
select throws_ok(format('select public.import_apply(%L)', pg_temp.payload('[{"rows":[2],"action":"create",
    "day":"2031-05-05","name":"Nope","country":null,"state":null}]')),
  '42501', 'admin_only', 'an employee can''t import holidays');
select pg_temp.act_as_postgres();
select is((select count(*)::int from public.holidays), 2, 'nothing was added');

-- An admin imports: one added, one renamed, one unchanged ---------------------------------------

select pg_temp.act_as(:ada);
select is(
  public.import_apply(pg_temp.payload('[
    {"rows":[2],"action":"create","day":"2031-03-31","name":" Cesar Chavez Day ","country":"us","state":"ca"},
    {"rows":[3],"action":"update","day":"2031-12-25","name":"Christmas Day","country":null,"state":null},
    {"rows":[4],"action":"update","day":"2031-07-04","name":"Independence Day","country":"US","state":null}]')),
  '{"kind":"holidays","created":1,"updated":2}'::jsonb,
  'an admin imports holidays and gets the counts');

select pg_temp.act_as_postgres();
select is((select count(*)::int from public.holidays), 3, 'the new holiday is added, the others stay as they were');
select is(
  (select (name, country, state, created_by)::text from public.holidays where day = '2031-03-31'),
  '("Cesar Chavez Day",US,CA,00000000-0000-4000-8000-0000000000a1)',
  'a new holiday is trimmed, in upper case, created by the admin');
select is(
  (select (name, country, state)::text from public.holidays where day = '2031-12-25'),
  '("Christmas Day",,)', 'a holiday for everyone is renamed by date and place');
select is(
  (select name from public.holidays where day = '2031-07-04'), 'Independence Day',
  'a holiday with the same name stays');
select is((select count(*)::int from public.holidays where day = '2031-12-25'), 1,
  'a rename is not a second holiday');

select is(
  (select (actor_id, target_user_id, metadata ->> 'name', metadata ->> 'country', metadata ->> 'state')::text
   from public.audit_log where action = 'holiday.added'),
  '(00000000-0000-4000-8000-0000000000a1,,"Cesar Chavez Day",US,CA)',
  'the new holiday is audited as an added holiday, by the admin');
select is((select count(*)::int from public.audit_log where action = 'holiday.added'), 1,
  'only the new one is');
select is(
  (select (actor_id, metadata ->> 'name', metadata -> 'from' ->> 'name')::text
   from public.audit_log where action = 'holiday.changed'),
  '(00000000-0000-4000-8000-0000000000a1,"Christmas Day",Christmas)',
  'the rename is audited with what it was');
select is((select count(*)::int from public.audit_log where action = 'holiday.changed'), 1,
  'a holiday with the same name changes and audits nothing');
select is(
  (select metadata from public.audit_log where action = 'import.applied'),
  '{"kind":"holidays","created":1,"updated":2,"rows":3}'::jsonb,
  'the import is audited with its counts');

select is(
  (select (pg_temp.config_version(:erin), pg_temp.config_version(:lucas))::text),
  '(2,1)',
  'the people each holiday applies to get a new config (Erin: California and everyone; Lucas: everyone)');

-- One bad item undoes the import --------------------------------------------------------------

select pg_temp.act_as(:ada);
select is(
  pg_temp.detail_of(format('select public.import_apply(%L)', pg_temp.payload('[
    {"rows":[2],"action":"create","day":"2031-09-01","name":"Fine","country":"US","state":null},
    {"rows":[3,4],"action":"create","day":"2031-09-02","name":"Bad state","country":"DE","state":"BY"}]'))),
  'rows: 3,4', 'a state outside the US is refused with the file''s rows');
select throws_ok(format('select public.import_apply(%L)', pg_temp.payload('[
    {"rows":[2],"action":"create","day":"2031-09-01","name":"Fine","country":"US","state":null},
    {"rows":[3],"action":"create","day":"2031-09-02","name":"Bad state","country":"DE","state":"BY"}]')),
  '22023', 'invalid_holiday', 'with save_holiday''s own error');
select pg_temp.act_as_postgres();
select is((select count(*)::int from public.holidays), 3, 'and the holiday before it is not kept');
select is((select count(*)::int from public.audit_log where action = 'import.applied'), 1,
  'nor is the failed import audited');

select * from finish();
rollback;
