-- #65: overtime thresholds (TS-19) and the export format (TS-20 XLSX).
begin;
create extension if not exists pgtap with schema extensions;

select plan(27);

\set ada '''00000000-0000-4000-8000-0000000000a1'''
\set max '''00000000-0000-4000-8000-0000000000b1'''
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

-- Saves a (partial) policy as the current user; the error and its key, or 'ok'.
create function pg_temp.save(p jsonb) returns text
language plpgsql as $$
declare
  m text;
  d text;
begin
  perform public.update_policy(p);
  return 'ok';
exception when others then
  get stacked diagnostics m = message_text, d = pg_exception_detail;
  return m || ':' || coalesce(d, '');
end;
$$;

-- Presets and validation --------------------------------------------------------------------

select is(
  (select count(*)::int from unnest(enum_range(null::public.region_preset)) r
   where internal.region_preset(r) -> 'overtime_daily_hours' = 'null'::jsonb
     and internal.region_preset(r) -> 'overtime_weekly_hours' = 'null'::jsonb),
  3, 'every preset has both overtime thresholds off');
select is(
  (select array_agg(s.kind || ' ' || s.lo || '..' || s.hi order by s.key) from internal.policy_spec() s
   where s.key in ('overtime_daily_hours', 'overtime_weekly_hours')),
  array['num 1..24', 'num 1..168'], 'daily 1..24 h and weekly 1..168 h, decimals allowed');
select is(
  internal.validate_policy('{"overtime_daily_hours": null, "overtime_weekly_hours": null}'),
  '{"overtime_daily_hours": null, "overtime_weekly_hours": null}'::jsonb,
  'null switches a threshold off');
select is(
  internal.validate_policy('{"overtime_daily_hours": 7.5, "overtime_weekly_hours": 37.5}'),
  '{"overtime_daily_hours": 7.5, "overtime_weekly_hours": 37.5}'::jsonb,
  'decimal hours are kept');
select is(
  internal.validate_policy('{"overtime_daily_hours": 8, "overtime_weekly_hours": 40}'),
  '{"overtime_daily_hours": 8, "overtime_weekly_hours": 40}'::jsonb, 'and whole ones');
select throws_ok($$ select internal.validate_policy('{"overtime_daily_hours": 0}') $$,
  '22023', 'invalid_policy', '0 is not a threshold (null is off)');
select throws_ok($$ select internal.validate_policy('{"overtime_daily_hours": 24.5}') $$,
  '22023', 'invalid_policy', 'a day has at most 24 h');
select throws_ok($$ select internal.validate_policy('{"overtime_weekly_hours": 169}') $$,
  '22023', 'invalid_policy', 'a week at most 168 h');
select throws_ok($$ select internal.validate_policy('{"overtime_weekly_hours": "40"}') $$,
  '22023', 'invalid_policy', 'a number, not text');
select throws_ok($$ select internal.validate_policy('{"pause_max_min": null}') $$,
  '22023', 'invalid_policy', 'other keys still need a value');

-- Settings ------------------------------------------------------------------------------------

select pg_temp.act_as(:ada);
select is(public.policy_settings() -> 'policy' -> 'overtime_daily_hours', 'null'::jsonb,
  'an org that has not set a threshold has it off');
select ok(public.policy_settings() -> 'policy' ? 'overtime_weekly_hours', 'the settings list both keys');
select is(pg_temp.save('{"overtime_daily_hours": 8, "overtime_weekly_hours": 40}'), 'ok',
  'an admin sets both');
select is(pg_temp.save('{"overtime_daily_hours": 30}'), 'invalid_policy:overtime_daily_hours',
  'and is told which key is out of range');
select pg_temp.act_as_postgres();
select is((select policy -> 'overtime_daily_hours' from public.orgs where id = :org), '8'::jsonb,
  'stored as a number');
select is(
  (select metadata -> 'changed' -> 'overtime_weekly_hours' from public.audit_log
   where org_id = :org and action = 'policy.changed' order by id desc limit 1),
  '{"from": null, "to": 40}'::jsonb, 'the change is audit-logged with before and after');
select pg_temp.act_as(:max);
select is(pg_temp.save('{"overtime_daily_hours": 9}'), 'admin_only:', 'a manager cannot change it');
select pg_temp.act_as(:ada);
select is(pg_temp.save('{"overtime_daily_hours": null}'), 'ok', 'and the admin can switch it off again');
select is(public.policy_settings() -> 'policy' -> 'overtime_daily_hours', 'null'::jsonb, 'off');

-- Export: format and thresholds -------------------------------------------------------------

select pg_temp.act_as(:max);
select is(
  public.timesheet_export_rows('2026-03-16', '2026-03-22', 'daily', p_format => 'xlsx') -> 'overtime',
  '{"daily_hours": null, "weekly_hours": 40}'::jsonb,
  'the export carries the org''s thresholds');
select is(
  public.timesheet_export_rows('2026-03-16', '2026-03-22', 'daily') ->> 'week_start', 'monday',
  'and its week start');
select pg_temp.act_as_postgres();
select is(
  (select metadata ->> 'format' from public.audit_log
   where action = 'timesheet.exported' and actor_id = :max order by id desc limit 1),
  'csv', 'the format defaults to CSV in the audit row');
select is(
  (select metadata ->> 'format' from public.audit_log
   where action = 'timesheet.exported' and actor_id = :max order by id desc offset 1 limit 1),
  'xlsx', 'and an XLSX export says so');
select pg_temp.act_as(:max);
select throws_ok(
  $$ select public.timesheet_export_rows('2026-03-16', '2026-03-22', 'daily', p_format => 'pdf') $$,
  '22023', 'invalid_format', 'an unknown format is refused');
select throws_ok(
  $$ select public.timesheet_export_rows('2026-03-16', '2026-03-22', 'daily', p_format => null) $$,
  '22023', 'invalid_format', 'and so is none');
select pg_temp.act_as(:erin);
select is(
  public.timesheet_export_rows('2026-03-16', '2026-03-22', 'segments', array[:erin]::uuid[],
    p_format => 'xlsx') -> 'overtime' ->> 'weekly_hours',
  '40', 'an employee exporting her own time gets the same thresholds');

select set_config('role', 'anon', true);
select throws_ok($$ select public.timesheet_export_rows('2026-03-16', '2026-03-22', 'daily', p_format => 'xlsx') $$,
  '42501', null, 'anon cannot call it');

select * from finish();
rollback;
