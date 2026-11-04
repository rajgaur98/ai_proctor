-- #307 (API-07, API-08, AUD-01, ADM-06): the MCP server's database side: the org switch,
-- the notice text, assistant tokens in the access token hook, public.mcp_call and its tools.
begin;
create extension if not exists pgtap with schema extensions;

select plan(54);

\set org '''00000000-0000-4000-8000-000000000001'''
\set ada '''00000000-0000-4000-8000-0000000000a1'''
\set max '''00000000-0000-4000-8000-0000000000b1'''
\set erin '''00000000-0000-4000-8000-0000000000c1'''
\set lucas '''00000000-0000-4000-8000-0000000000c2'''
\set revamp '''00000000-0000-4000-8000-0000000000f1'''
\set client '''11111111-1111-4111-8111-111111111111'''

create function pg_temp.act_as(uid uuid) returns void
language sql as $$
  select set_config('role', 'postgres', true);
  select set_config('request.jwt.claims',
    (internal.custom_access_token_hook(jsonb_build_object(
      'user_id', uid, 'claims', jsonb_build_object('sub', uid, 'role', 'authenticated')
    )) -> 'claims')::text, true);
  select set_config('role', 'authenticated', true);
$$;

-- The mcp Edge Function's role.
create function pg_temp.as_service() returns void
language sql as $$
  select set_config('role', 'postgres', true);
  select set_config('request.jwt.claims', '{"role":"service_role"}', true);
  select set_config('role', 'service_role', true);
$$;

create function pg_temp.as_postgres() returns void
language sql as $$
  select set_config('role', 'postgres', true);
  select set_config('request.jwt.claims', '', true);
$$;

-- A tool call as the mcp function makes it (aal1 unless given).
create function pg_temp.call(uid uuid, tool text, args jsonb default '{}', aal text default 'aal1')
returns jsonb
language sql as $$
  select public.mcp_call(uid, '11111111-1111-4111-8111-111111111111', aal, tool, args);
$$;

-- The hook's answer for a token issued to an assistant.
create function pg_temp.assistant_hook(uid uuid) returns jsonb
language sql as $$
  select internal.custom_access_token_hook(jsonb_build_object('user_id', uid,
    'claims', jsonb_build_object('sub', uid, 'role', 'authenticated',
      'client_id', '11111111-1111-4111-8111-111111111111')));
$$;

create function pg_temp.latest_notice() returns public.notices
language sql as $$
  select * from public.notices where org_id = '00000000-0000-4000-8000-000000000001'
  order by version desc limit 1;
$$;

-- Yesterday in Los Angeles at a local time.
create function pg_temp.yesterday_at(t interval) returns timestamptz
language sql as $$
  select ((now() at time zone 'America/Los_Angeles')::date - 1 + t) at time zone 'America/Los_Angeles'
$$;

-- The switch --------------------------------------------------------------------------------

select is((select ai_assistant_access from public.orgs where id = :org), false,
  'AI assistant access is off by default');

-- While it is off: no assistant token, and every call is refused (and logged).
select is(pg_temp.assistant_hook(:max) -> 'error' ->> 'message', 'ai_assistant_access_off',
  'the hook issues no assistant token while access is off');
select is(pg_temp.assistant_hook('00000000-0000-4000-8000-00000000dead') -> 'error' ->> 'message',
  'not_a_member', 'nor to someone without a membership');
select is(internal.custom_access_token_hook(jsonb_build_object('user_id', :max,
    'claims', jsonb_build_object('sub', :max, 'role', 'authenticated'))) -> 'claims' ->> 'role',
  'authenticated', 'a dashboard token keeps its role');

select pg_temp.as_service();
select is(pg_temp.call(:max, 'list_people') -> 'error' ->> 'code', 'ai_assistant_access_off',
  'a tool call is refused while access is off');
select pg_temp.as_postgres();
select is((select metadata ->> 'error' from public.audit_log
  where action = 'mcp.tool_call' and actor_id = :max order by id desc limit 1),
  'ai_assistant_access_off', 'the refused call is audit-logged');

select pg_temp.act_as(:max);
select throws_ok($$ select public.set_ai_assistant_access(true) $$, '42501', 'admin_only',
  'a manager can''t turn it on');
update public.orgs set ai_assistant_access = true where id = :org;
select pg_temp.as_postgres();
select is((select ai_assistant_access from public.orgs where id = :org), false,
  'nor write the column (no update policy)');

create temp table v (version int, policy_version int) on commit drop;
insert into v select (pg_temp.latest_notice()).version, (select policy_version from public.orgs where id = :org);
grant all on v to authenticated, service_role;

select pg_temp.act_as(:ada);
select throws_ok($$ select public.set_ai_assistant_access(null) $$, '22023', 'invalid_value',
  'on or off, not null');
select is(public.set_ai_assistant_access(true),
  jsonb_build_object('enabled', true, 'notice_version', (select version + 1 from v), 'notice_edited', false),
  'the owner turns it on; the template notice gets a new version');
select pg_temp.as_postgres();
select is((select ai_assistant_access from public.orgs where id = :org), true, 'it is on');
select ok((pg_temp.latest_notice()).body ->> 'who' like '%Acme Remote has turned on AI assistant access%',
  'the notice says AI assistant access is on (ADM-06)');
select ok((pg_temp.latest_notice()).body ->> 'who' like '%never gets your screenshots, webcam frames, window titles or websites%',
  'and what an assistant never gets');
select is((select policy_version from public.orgs where id = :org), (select policy_version + 1 from v),
  'agents learn about the new notice');
select is((select metadata from public.audit_log where action = 'ai_assistant_access.changed'
  and actor_id = :ada order by id desc limit 1), '{"enabled": true}'::jsonb, 'the change is audit-logged');
select is((select metadata ->> 'source' from public.audit_log where action = 'notice.published'
  order by id desc limit 1), 'ai_assistant_access', 'and so is the notice it published');

select pg_temp.act_as(:ada);
select is(public.set_ai_assistant_access(true) ->> 'notice_version', null,
  'turning it on again changes nothing');

-- An admin's own notice text is left alone.
select lives_ok($$ select public.publish_notice((pg_temp.latest_notice()).body
  || jsonb_build_object('intro', 'Our own words.')) $$, 'an admin publishes their own text');
select pg_temp.as_postgres();
delete from v;
insert into v select (pg_temp.latest_notice()).version, 0;
select pg_temp.act_as(:ada);
select is(public.set_ai_assistant_access(false),
  '{"enabled": false, "notice_version": null, "notice_edited": true}'::jsonb,
  'turning it off leaves an edited notice and says so');
select pg_temp.as_postgres();
select is((pg_temp.latest_notice()).version, (select version from v), 'no new version');
select pg_temp.act_as(:ada);
select is(public.set_ai_assistant_access(true) ->> 'notice_edited', 'true', 'on again: still edited');

-- Assistant tokens ---------------------------------------------------------------------------

select pg_temp.as_postgres();
select is(pg_temp.assistant_hook(:max) -> 'claims' ->> 'role', 'ai_assistant',
  'an assistant''s token carries the role ai_assistant');
select is(pg_temp.assistant_hook(:max) -> 'claims' ->> 'org_id', :org, 'and the org');
select ok(exists (select 1 from pg_roles where rolname = 'ai_assistant'), 'the role exists');
select ok(not pg_has_role('authenticator', 'ai_assistant', 'member'),
  'PostgREST, Storage and Realtime can''t switch to it');
select ok(not has_function_privilege('authenticated', 'public.mcp_call(uuid, text, text, text, jsonb)', 'execute'),
  'a signed-in person can''t call mcp_call');
select ok(has_function_privilege('service_role', 'public.mcp_call(uuid, text, text, text, jsonb)', 'execute'),
  'the mcp function can');

-- Seed a day for Erin --------------------------------------------------------------------------

insert into public.devices (id, org_id, user_id, platform, os_version, agent_version, hardware_hash)
values ('22222222-2222-4222-8222-222222222222', :org, :erin, 'macos', '15', 'test', 'mcp-test');
insert into public.time_segments (org_id, user_id, day, start_at, end_at, type, project_id, counted, flagged, source)
values
  (:org, :erin, (now() at time zone 'America/Los_Angeles')::date - 1,
   pg_temp.yesterday_at('13:00'), pg_temp.yesterday_at('15:00'), 'verified', :revamp, true, false, 'manual'),
  (:org, :lucas, (now() at time zone 'America/Los_Angeles')::date - 1,
   pg_temp.yesterday_at('13:00'), pg_temp.yesterday_at('14:00'), 'verified', null, true, false, 'manual');
insert into public.checkin_events (id, org_id, user_id, device_id, scheduled_at, shown_at, outcome,
  object_keys, flags, missed_reason_kind, missed_reason)
values
  (gen_random_uuid(), :org, :erin, '22222222-2222-4222-8222-222222222222',
   pg_temp.yesterday_at('13:59'), pg_temp.yesterday_at('14:00'), 'miss', '{}', '{}', 'meeting',
   'my private remark'),
  (gen_random_uuid(), :org, :erin, '22222222-2222-4222-8222-222222222222',
   pg_temp.yesterday_at('14:29'), pg_temp.yesterday_at('14:30'), 'pass',
   array['org/erin/secret-capture.webp'], '{}', null, null);
insert into public.alerts (org_id, user_id, recipient_id, kind, episode, details, triggered_at)
values (:org, :erin, :max, 'consecutive_misses', 'mcp-test', '{"misses": 3}', pg_temp.yesterday_at('14:31'));

-- Tools, by role -------------------------------------------------------------------------------

select pg_temp.as_service();
select is(jsonb_array_length(pg_temp.call(:ada, 'list_people') -> 'result' -> 'people'), 4,
  'the owner sees everyone');
select is((select array_agg(p ->> 'name' order by p ->> 'name')
  from jsonb_array_elements(pg_temp.call(:max, 'list_people') -> 'result' -> 'people') p),
  array['Erin Employee', 'Lucas Martin', 'Max Manager'], 'a manager sees their reports and themselves');
select is((select array_agg(p ->> 'name')
  from jsonb_array_elements(pg_temp.call(:erin, 'list_people') -> 'result' -> 'people') p),
  array['Erin Employee'], 'an employee sees only themselves');

-- The token's aal: with the org's admin-MFA rule an owner's aal1 token sees like an aal1
-- dashboard session (themselves and their direct reports).
select pg_temp.as_postgres();
update public.orgs set policy = policy || '{"require_admin_mfa": true}' where id = :org;
select pg_temp.as_service();
select is((select array_agg(p ->> 'name' order by p ->> 'name')
  from jsonb_array_elements(pg_temp.call(:ada, 'list_people') -> 'result' -> 'people') p),
  array['Ada Admin', 'Max Manager'], 'an aal1 token under the admin-MFA rule sees no org-wide view');
select is(jsonb_array_length(pg_temp.call(:ada, 'list_people', '{}', 'aal2') -> 'result' -> 'people'), 4,
  'an aal2 token does');
select pg_temp.as_postgres();
update public.orgs set policy = policy - 'require_admin_mfa' where id = :org;
select pg_temp.as_service();

select is(pg_temp.call(:erin, 'get_person_day', jsonb_build_object('user_id', :lucas)) -> 'error' ->> 'code',
  'not_found', 'an employee can''t see a peer''s day');
select is(pg_temp.call(:max, 'get_person_day', jsonb_build_object('user_id', :ada)) -> 'error' ->> 'code',
  'not_found', 'nor a manager their own manager''s');
select is(pg_temp.call(:max, 'get_person_day', '{"date": "soon"}') -> 'error',
  '{"code": "invalid_param", "message": "date: expected a date (YYYY-MM-DD)"}'::jsonb,
  'argument errors name the argument');
select is(pg_temp.call(:max, 'list_people', '{"nickname": "x"}') -> 'error' ->> 'message',
  'nickname: unknown parameter', 'unknown arguments are refused');
select is(pg_temp.call(:max, 'drop_everything') -> 'error' ->> 'code', 'unknown_tool', 'unknown tools too');

create temp table day_result as
select pg_temp.call(:max, 'get_person_day', jsonb_build_object('user_id', :erin,
  'date', (now() at time zone 'America/Los_Angeles')::date - 1)) -> 'result' as r;
select is((select (r -> 'totals' ->> 'worked_s')::numeric from day_result), 7200::numeric,
  'a manager reads a report''s day: worked seconds');
select is((select jsonb_agg(c ->> 'outcome') from day_result, jsonb_array_elements(r -> 'checkins') c),
  '["miss", "pass"]'::jsonb, 'the check-ins in order');
select is((select r -> 'checkins' -> 0 ->> 'miss_reason' from day_result), 'meeting',
  'a miss with the reason picked');
select is((select array_agg(k order by k) from day_result, jsonb_object_keys(r -> 'checkins' -> 0) k),
  array['miss_reason', 'outcome', 'responded_at', 'response_ms', 'shown_at'],
  'check-ins are metadata only: never when one was scheduled');
select ok((select r::text from day_result) not like '%secret-capture%'
  and (select r::text from day_result) not like '%private remark%',
  'never a capture or the remark');

select is(pg_temp.call(:max, 'who_is_on_shift') -> 'result' -> 'people', '[]'::jsonb,
  'nobody is on shift');
select is(jsonb_array_length(pg_temp.call(:max, 'who_is_on_shift', '{"include_off_shift": true}')
  -> 'result' -> 'people'), 3, 'off shift too, on request');

select is((select jsonb_agg(t -> 'person' ->> 'name' order by t -> 'person' ->> 'name')
  from jsonb_array_elements(pg_temp.call(:max, 'list_timesheets') -> 'result' -> 'timesheets') t),
  '["Erin Employee", "Lucas Martin", "Max Manager"]'::jsonb,
  'this week''s timesheets list everyone the manager sees');

select is((select jsonb_agg(jsonb_build_array(r -> 'person' ->> 'name', (r ->> 'worked_s')::numeric))
  from jsonb_array_elements(pg_temp.call(:max, 'hours_report', jsonb_build_object(
    'from', (now() at time zone 'America/Los_Angeles')::date - 1,
    'to', (now() at time zone 'America/Los_Angeles')::date - 1)) -> 'result' -> 'rows') r),
  '[["Erin Employee", 7200], ["Lucas Martin", 3600]]'::jsonb, 'hours by person');
select is(pg_temp.call(:max, 'hours_report', '{"from": "2026-01-01"}') -> 'error' ->> 'message',
  'to: required', 'a report needs both days');
select is(pg_temp.call(:max, 'hours_report', '{"from": "2024-01-01", "to": "2026-01-01"}') -> 'error' ->> 'message',
  'to: a range covers at most 366 days', 'and at most 366 of them');

select is(jsonb_array_length(pg_temp.call(:max, 'list_alerts', '{"kind": "consecutive_misses"}')
  -> 'result' -> 'alerts'), 1, 'the manager reads the alert sent to them');
select is(pg_temp.call(:erin, 'list_alerts') -> 'result' -> 'alerts', '[]'::jsonb,
  'never alerts about oneself');

-- Audit and rate limit -------------------------------------------------------------------------

select pg_temp.as_postgres();
select is((select jsonb_build_object('target', target_user_id, 'tool', metadata ->> 'tool',
    'rows', metadata -> 'row_count', 'client', metadata ->> 'client_id', 'filters', metadata -> 'filters')
  from public.audit_log where action = 'mcp.tool_call' and actor_id = :max
    and metadata ->> 'tool' = 'get_person_day' and target_user_id = :erin and metadata ->> 'error' is null
  order by id desc limit 1),
  jsonb_build_object('target', :erin, 'tool', 'get_person_day', 'rows', 3, 'client', :client,
    'filters', jsonb_build_object('user_id', :erin, 'date', (now() at time zone 'America/Los_Angeles')::date - 1)),
  'a tool call is audit-logged: who it was about, the tool, its arguments, the rows (1 segment, 2 check-ins)');

insert into internal.mcp_rate (user_id, window_start, calls)
values (:lucas, date_trunc('minute', now()), internal.mcp_rate_limit())
on conflict (user_id) do update set calls = excluded.calls, window_start = excluded.window_start;
create temp table before_rl as select count(*) as n from public.audit_log where actor_id = :lucas;
select pg_temp.as_service();
select is(pg_temp.call(:lucas, 'list_people') -> 'error' ->> 'code', 'rate_limited',
  'calls over the limit are refused');
select pg_temp.as_postgres();
select is((select count(*) from public.audit_log where actor_id = :lucas), (select n from before_rl),
  'and not logged');

update public.users set active = false where id = :lucas;
select pg_temp.as_service();
select is(pg_temp.call(:lucas, 'list_people') -> 'error' ->> 'code', 'not_a_member',
  'a deactivated person''s assistant gets nothing');

select * from finish();
rollback;
