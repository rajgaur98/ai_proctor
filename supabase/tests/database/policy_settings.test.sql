begin;
create extension if not exists pgtap with schema extensions;

select plan(97);

\set ada '''00000000-0000-4000-8000-0000000000a1'''
\set max '''00000000-0000-4000-8000-0000000000b1'''
\set erin '''00000000-0000-4000-8000-0000000000c1'''
\set org '''00000000-0000-4000-8000-000000000001'''
\set eu_owner '''00000000-0000-4000-8000-0000000000e1'''
\set us_owner '''00000000-0000-4000-8000-0000000000e2'''
\set in_owner '''00000000-0000-4000-8000-0000000000e3'''
\set de_hire '''00000000-0000-4000-8000-0000000000e4'''

create function pg_temp.act_as(uid uuid, aal text default 'aal1') returns void
language sql as $$
  select set_config('role', 'postgres', true);
  select set_config('request.jwt.claims',
    ((internal.custom_access_token_hook(jsonb_build_object(
      'user_id', uid, 'claims', jsonb_build_object('sub', uid, 'role', 'authenticated')
    )) -> 'claims') || jsonb_build_object('aal', aal))::text, true);
  select set_config('role', 'authenticated', true);
$$;

create function pg_temp.act_as_postgres() returns void
language sql as $$
  select set_config('role', 'postgres', true);
  select set_config('request.jwt.claims', '', true);
$$;

-- The error message and the key it names (DETAIL) for a statement that must fail.
create function pg_temp.err(stmt text) returns text
language plpgsql as $$
declare
  m text;
  d text;
begin
  execute stmt;
  return 'no error';
exception when others then
  get stacked diagnostics m = message_text, d = pg_exception_detail;
  return m || ':' || coalesce(d, '');
end;
$$;

-- Saves one key as the current user; the error text, or 'ok'.
create function pg_temp.save(k text, v jsonb) returns text
language plpgsql as $$
declare
  m text;
  d text;
begin
  perform public.update_policy(jsonb_build_object(k, v));
  return 'ok';
exception when others then
  get stacked diagnostics m = message_text, d = pg_exception_detail;
  return m || ':' || coalesce(d, '');
end;
$$;

create function pg_temp.audits(p_org uuid, p_action text) returns int
language sql as $$
  select count(*)::int from public.audit_log where org_id = p_org and action = p_action
$$;

-- The three organisations: one per region preset, created through create_org.
select set_config('role', 'postgres', true);
insert into auth.users (id, email) values
  (:eu_owner, 'owner@eu-co.test'), (:us_owner, 'owner@us-co.test'), (:in_owner, 'owner@in-co.test');
select pg_temp.act_as(:eu_owner);
select public.create_org('EuCo', 'eu', 'Eva Owner', 'Europe/Berlin');
select pg_temp.act_as(:us_owner);
select public.create_org('UsCo', 'us', 'Uma Owner', 'America/New_York');
select pg_temp.act_as(:in_owner);
select public.create_org('InCo', 'india', 'Indra Owner', 'Asia/Kolkata');
select pg_temp.act_as_postgres();
create temp table orgs_by_region as
select o.region_preset as region, o.id, o.policy from public.orgs o
where o.name in ('EuCo', 'UsCo', 'InCo');

-- Presets (PRD 5.1) ---------------------------------------------------------------------------

select is(internal.region_preset('us') ->> 'screenshots', 'full', 'US preset: full screenshots');
select ok((internal.region_preset('us') ->> 'webcam')::boolean
  and (internal.region_preset('us') ->> 'window_titles')::boolean
  and (internal.region_preset('us') ->> 'checkin_min_interval_min')::int = 20
  and (internal.region_preset('us') ->> 'checkin_max_interval_min')::int = 90
  and (internal.region_preset('us') ->> 'image_retention_days')::int = 30,
  'US preset: webcam and window titles on, 20-90 min, images kept 30 days');
select ok(internal.region_preset('eu') ->> 'screenshots' = 'blurred'
  and not (internal.region_preset('eu') ->> 'webcam')::boolean
  and not (internal.region_preset('eu') ->> 'window_titles')::boolean
  and (internal.region_preset('eu') ->> 'checkin_min_interval_min')::int = 45
  and (internal.region_preset('eu') ->> 'checkin_max_interval_min')::int = 120
  and (internal.region_preset('eu') ->> 'image_retention_days')::int = 30,
  'EU preset: blurred, webcam and window titles off, 45-120 min, images kept 30 days');
select is(internal.region_preset('india'), internal.region_preset('us'), 'India preset: the same values as US');
select is((select bool_and((internal.region_preset(r) ->> 'reminders_enabled')::boolean)
           from unnest(enum_range(null::public.region_preset)) r), true, 'every preset has timesheet reminders on');
select is(
  (select count(*)::int from jsonb_object_keys(internal.region_preset('eu')) k
   where k not in (select key from internal.policy_spec())),
  0, 'every key in a preset can be set');
select is(
  (select count(*)::int from internal.policy_spec() s
   where not internal.region_preset('eu') ? s.key),
  0, 'every settable key is in the presets');
select is(internal.validate_policy(internal.region_preset('eu')), internal.region_preset('eu'),
  'a preset is a valid policy');
select is(internal.policy_defaults() - 'excluded_apps', internal.region_preset('us') - 'excluded_apps',
  'the defaults for missing keys are the US preset');

select is((select policy from orgs_by_region where region = 'eu'), internal.region_preset('eu'),
  'an EU org starts from the EU preset (#48 gap)');
select is((select policy from orgs_by_region where region = 'us'), internal.region_preset('us'),
  'a US org starts from the US preset');
select is((select policy from orgs_by_region where region = 'india'), internal.region_preset('india'),
  'an India org starts from the India preset');
select is(
  (select n.collection - 'excluded_apps' from public.notices n join orgs_by_region o on o.id = n.org_id
   where o.region = 'eu' and n.version = 1),
  '{"screenshots": "blurred", "webcam": false, "window_titles": false, "activity_sampling": true, "face_presence": false}'::jsonb,
  'the EU org''s first notice describes the preset: blurred, no webcam, no titles');

-- Who may use it ---------------------------------------------------------------------------

select pg_temp.act_as(:max);
select is(pg_temp.err($$ select public.update_policy('{"week_start": "sunday"}') $$), 'admin_only:',
  'a manager cannot change the policy');
select is(pg_temp.err($$ select public.policy_settings() $$), 'admin_only:', 'nor open the settings');
select pg_temp.act_as(:erin);
select is(pg_temp.err($$ select public.update_policy('{"week_start": "sunday"}') $$), 'admin_only:',
  'an employee cannot change the policy');

-- Settings ------------------------------------------------------------------------------------

select pg_temp.act_as(:ada);
select is(public.policy_settings() ->> 'region_preset', 'us', 'the settings name the org''s region');
select is(public.policy_settings() -> 'policy' ->> 'screenshots', 'full',
  'an org without stored keys shows the defaults in force');
select is(public.policy_settings() -> 'policy' -> 'excluded_apps', '[]'::jsonb,
  'no excluded apps are in force until the org sets them');
select is((public.policy_settings() -> 'presets') ->> 'eu' is not null
  and public.policy_settings() -> 'presets' -> 'eu' ->> 'screenshots' = 'blurred', true,
  'the presets come with the settings');
select is((public.policy_settings() ->> 'members')::int, 4, 'who it applies to: the active members');

-- A change: stored, version bumped, audit-logged with before and after ------------------------

select pg_temp.act_as_postgres();
create temp table v0 as select policy_version as v from public.orgs where id = :org;
grant select on v0 to authenticated;
select pg_temp.act_as(:ada);
select is(public.update_policy('{"checkin_min_interval_min": 30, "checkin_max_interval_min": 60}') ->> 'changed',
  '["checkin_max_interval_min", "checkin_min_interval_min"]', 'the reply lists what changed');
select pg_temp.act_as_postgres();
select is((select policy ->> 'checkin_min_interval_min' from public.orgs where id = :org), '30',
  'the interval is stored as a number');
select is((select policy_version from public.orgs where id = :org), (select v + 1 from v0),
  'policy_version moves by one, so agents refetch at their next sync');
select is(
  (select metadata from public.audit_log where org_id = :org and action = 'policy.changed' order by id desc limit 1),
  '{"changed": {"checkin_min_interval_min": {"from": 20, "to": 30}, "checkin_max_interval_min": {"from": 90, "to": 60}}}'::jsonb,
  'the audit entry has the before and after of the changed keys (AUD-01)');
select is((select actor_id from public.audit_log where action = 'policy.changed' order by id desc limit 1),
  :ada::uuid, 'with the actor');
select is(pg_temp.audits(:org, 'notice.published'), 1, 'an interval change does not publish a notice (only the template)');

-- Saving the same values again changes nothing
select pg_temp.act_as(:ada);
select public.update_policy('{"checkin_min_interval_min": 30, "checkin_max_interval_min": 60}');
select pg_temp.act_as_postgres();
select is((select policy_version from public.orgs where id = :org), (select v + 1 from v0),
  'saving the same values does not bump the version');
select is(pg_temp.audits(:org, 'policy.changed'), 1, 'or write an audit entry');

-- Untouched keys stay; keys saved at their default are stored without a change entry
select pg_temp.act_as(:ada);
select is(public.update_policy('{"screenshots": "full"}') -> 'changed', '[]'::jsonb,
  'a key saved at the value in force is not a change');
select pg_temp.act_as_postgres();
select is((select policy ->> 'screenshots' from public.orgs where id = :org), 'full', 'but it is stored');
select is((select policy_version from public.orgs where id = :org), (select v + 1 from v0), 'with no version bump');
select is((select policy ->> 'checkin_min_interval_min' from public.orgs where id = :org), '30',
  'keys left out stay as they were');

-- Validation: out-of-range and wrong-type values name their key ------------------------------

select pg_temp.act_as(:ada);
select is(
  (select count(*)::int from (values
    ('checkin_min_interval_min', '9'), ('checkin_min_interval_min', '241'),
    ('checkin_max_interval_min', '9'), ('checkin_max_interval_min', '241'),
    ('checkin_response_s', '29'), ('checkin_response_s', '301'),
    ('idle_threshold_min', '2'), ('idle_threshold_min', '61'),
    ('forgotten_clock_out_min', '9'), ('forgotten_clock_out_min', '121'),
    ('break_daily_max_min', '0'), ('break_daily_max_min', '1441'),
    ('pause_max_min', '-1'), ('pause_max_min', '61'),
    ('pause_daily_max_min', '-1'), ('pause_daily_max_min', '241'),
    ('late_clock_in_min', '4'), ('late_clock_in_min', '61'),
    ('alert_consecutive_misses', '0'), ('alert_consecutive_misses', '11'),
    ('alert_offline_min', '4'), ('alert_offline_min', '241'),
    ('image_retention_days', '6'), ('image_retention_days', '91'),
    ('event_retention_months', '2'), ('event_retention_months', '37'),
    ('timesheet_retention_years', '2'), ('timesheet_retention_years', '11'),
    ('anticheat_min_passes', '2'), ('anticheat_min_passes', '51'),
    ('anticheat_max_cv', '0.009'), ('anticheat_max_cv', '0.51')
  ) v(k, bad) where pg_temp.save(v.k, v.bad::jsonb) = 'invalid_policy:' || v.k),
  32, 'every number key refuses a value outside its range (16 keys, both ends)');
select is(
  (select count(*)::int from (values
    ('checkin_min_interval_min', '10'), ('checkin_response_s', '30'), ('checkin_response_s', '300'),
    ('idle_threshold_min', '3'), ('idle_threshold_min', '60'),
    ('forgotten_clock_out_min', '10'), ('forgotten_clock_out_min', '120'),
    ('break_daily_max_min', '1'), ('break_daily_max_min', '1440'),
    ('pause_max_min', '0'), ('pause_max_min', '60'),
    ('pause_daily_max_min', '0'), ('pause_daily_max_min', '240'),
    ('late_clock_in_min', '5'), ('late_clock_in_min', '60'),
    ('alert_consecutive_misses', '1'), ('alert_consecutive_misses', '10'),
    ('alert_offline_min', '5'), ('alert_offline_min', '240'),
    ('image_retention_days', '7'), ('image_retention_days', '90'),
    ('event_retention_months', '3'), ('event_retention_months', '36'),
    ('timesheet_retention_years', '3'), ('timesheet_retention_years', '10'),
    ('anticheat_min_passes', '3'), ('anticheat_min_passes', '50'),
    ('anticheat_max_cv', '0.01'), ('anticheat_max_cv', '0.5')
  ) v(k, good) where pg_temp.save(v.k, v.good::jsonb) = 'ok'),
  29, 'and takes both ends of the range');
select is(pg_temp.save('checkin_response_s', '90.5'), 'invalid_policy:checkin_response_s', 'a whole-number key refuses decimals');
select is(pg_temp.save('checkin_response_s', '"90"'), 'invalid_policy:checkin_response_s', 'and strings');
select is(pg_temp.save('checkin_response_s', 'true'), 'invalid_policy:checkin_response_s', 'and booleans');
select is(pg_temp.save('checkin_response_s', 'null'), 'invalid_policy:checkin_response_s', 'and null');
select is(pg_temp.save('screenshots', '"sharp"'), 'invalid_policy:screenshots', 'screenshots takes full, blurred or off');
select is(pg_temp.save('week_start', '"someday"'), 'invalid_policy:week_start', 'week_start takes a day name');
select is(pg_temp.save('week_start', '"Sunday"'), 'invalid_policy:week_start', 'in lower case');
select is(
  (select count(*)::int from (values
    ('webcam'), ('window_titles'), ('activity_sampling'), ('auto_clock_in'), ('breaks_paid'),
    ('alert_consecutive_misses_enabled'), ('alert_offline_enabled'), ('alert_tamper_enabled'),
    ('alert_late_clock_in_enabled'), ('alert_pause_over_cap_enabled'), ('reminders_enabled'),
    ('require_admin_mfa'), ('face_presence')
  ) v(k) where pg_temp.save(v.k, '"yes"') = 'invalid_policy:' || v.k and pg_temp.save(v.k, '1') = 'invalid_policy:' || v.k),
  13, 'every switch refuses anything but a boolean');
select is(pg_temp.save('reminders_enabled', 'false'), 'ok', 'timesheet reminders can be switched off (#177)');
select is(public.policy_settings() -> 'policy' ->> 'reminders_enabled', 'false', 'and the settings show it');
select is(pg_temp.save('reminders_enabled', 'true'), 'ok', 'and on again');
select is(pg_temp.save('pause_max_min', 'null'), 'invalid_policy:pause_max_min', 'only the daily break limit may be null');
select is(pg_temp.save('break_daily_max_min', 'null'), 'ok', 'which means no limit');
select pg_temp.act_as_postgres();
select is((select policy -> 'break_daily_max_min' from public.orgs where id = :org), 'null'::jsonb, 'and is stored as null');
select pg_temp.act_as(:ada);
select is(pg_temp.err($$ select public.update_policy('{"surprise": 1}') $$), 'unknown_policy_key:surprise',
  'an unknown key is refused, naming it');
select is(pg_temp.err($$ select public.update_policy('[1]') $$), 'invalid_policy:policy', 'the policy must be an object');
select is(pg_temp.err($$ select public.update_policy('{"week_start": "monday", "surprise": 1}') $$),
  'unknown_policy_key:surprise', 'one unknown key refuses the whole save');
select pg_temp.act_as_postgres();
select is((select policy ->> 'week_start' from public.orgs where id = :org), null, 'and nothing of it is stored');
select pg_temp.act_as(:ada);
select is(pg_temp.err($$ select public.update_policy('{"checkin_min_interval_min": 100, "checkin_max_interval_min": 90}') $$),
  'invalid_policy:checkin_max_interval_min', 'the shortest interval cannot be above the longest');
select is(pg_temp.save('checkin_min_interval_min', '120'), 'invalid_policy:checkin_max_interval_min',
  'also against the stored longest interval');

-- Excluded apps
select is(public.update_policy('{"excluded_apps": [" 1Password ", "1password", "Slack", "slack "]}') ->> 'changed',
  '["excluded_apps"]', 'excluded apps save');
select pg_temp.act_as_postgres();
select is((select policy -> 'excluded_apps' from public.orgs where id = :org), '["1Password", "Slack"]'::jsonb,
  'trimmed and without repeats, first spelling kept');
select pg_temp.act_as(:ada);
select is(pg_temp.save('excluded_apps', '["ok", ""]'), 'invalid_policy:excluded_apps', 'an empty name is refused');
select is(pg_temp.save('excluded_apps', '["ok", 3]'), 'invalid_policy:excluded_apps', 'so is a non-text one');
select is(pg_temp.save('excluded_apps', (select jsonb_agg('app' || i) from generate_series(1, 101) i)::jsonb),
  'invalid_policy:excluded_apps', 'and more than 100');
select is(pg_temp.save('excluded_apps', to_jsonb(array[repeat('x', 101)])), 'invalid_policy:excluded_apps', 'and a name over 100 characters');
select is(pg_temp.save('excluded_apps', '"1Password"'), 'invalid_policy:excluded_apps', 'the list must be a list');

-- Notice republish (#48) --------------------------------------------------------------------------

select pg_temp.act_as_postgres();
update public.orgs set policy = policy - 'screenshots' where id = :org;
create temp table v1 as select policy_version as v,
  (select max(version) from public.notices where org_id = :org) as n from public.orgs where id = :org;
grant select on v1 to authenticated;
select pg_temp.act_as(:ada);
select is(public.update_policy('{"week_start": "sunday"}') -> 'notice_version', 'null'::jsonb,
  'a change outside collection publishes no notice');
select pg_temp.act_as_postgres();
select is((select max(version) from public.notices where org_id = :org), (select n from v1), 'none was published');
select pg_temp.act_as(:ada);
select is((public.update_policy('{"screenshots": "blurred"}') ->> 'notice_version')::int, (select n + 1 from v1),
  'a collection change (screenshots) returns the new notice version');
select pg_temp.act_as_postgres();
select is((select collection ->> 'screenshots' from public.notices where org_id = :org and version = (select n + 1 from v1)),
  'blurred', 'the republished notice describes it');
select is((select policy_version from public.orgs where id = :org), (select v + 2 from v1),
  'the version moved once per saved change, not again for the notice');
select is((select metadata ->> 'source' from public.audit_log where org_id = :org and action = 'notice.published' order by id desc limit 1),
  'policy_change', 'and the notice is audit-logged as published by a policy change');

-- Retention caps (PRD 5.1) ----------------------------------------------------------------------

select pg_temp.act_as(:us_owner);
select is(pg_temp.save('image_retention_days', '90'), 'ok', 'a US org keeps images up to 90 days');
select pg_temp.act_as(:eu_owner);
select is(pg_temp.save('image_retention_days', '31'), 'eu_image_retention_max:image_retention_days',
  'an EU org cannot keep images beyond 30 days');
select is(pg_temp.save('image_retention_days', '14'), 'ok', 'but can keep them shorter');
select is(pg_temp.err($$ select public.update_policy('{"image_retention_days": 30, "webcam": false}') $$), 'no error',
  '30 days is allowed');

-- DPIA and works council (CAP-05) -------------------------------------------------------------

select is(pg_temp.save('webcam', 'true'), 'dpia_required:webcam', 'webcam on in an EU org needs the DPIA confirmed');
select pg_temp.act_as_postgres();
select is((select policy ->> 'webcam' from public.orgs where name = 'EuCo'), 'false', 'and nothing was saved');
select is(pg_temp.audits((select id from orgs_by_region where region = 'eu'), 'policy.dpia_confirmed'), 0, 'or logged');
select pg_temp.act_as(:eu_owner);
select is(pg_temp.err($$ select public.update_policy('{"webcam": true}', false, true) $$), 'dpia_required:webcam',
  'the works council alone is not enough');
select is(pg_temp.err($$ select public.update_policy('{"webcam": true}', true) $$), 'no error',
  'with the DPIA confirmed, webcam turns on');
select pg_temp.act_as_postgres();
select is(
  (select metadata from public.audit_log where action = 'policy.dpia_confirmed'
     and org_id = (select id from orgs_by_region where region = 'eu')),
  '{"feature": "webcam", "region": "eu", "works_council_confirmed": false}'::jsonb,
  'the DPIA confirmation is audit-logged (AUD-01)');
select is(
  (select metadata -> 'changed' -> 'webcam' from public.audit_log where action = 'policy.changed'
     and org_id = (select id from orgs_by_region where region = 'eu') order by id desc limit 1),
  '{"from": false, "to": true}'::jsonb, 'next to the change itself');
select pg_temp.act_as(:eu_owner);
select is(pg_temp.save('checkin_response_s', '60'), 'ok', 'once webcam is on, other saves need no confirmation');
select is(pg_temp.save('webcam', 'false'), 'ok', 'turning it off needs none');
select is(pg_temp.save('webcam', 'true'), 'dpia_required:webcam', 'turning it on again does');

-- Where a works council applies: someone working in Germany
select pg_temp.act_as_postgres();
insert into auth.users (id, email) values (:de_hire, 'hire@eu-co.test');
insert into public.users (id, org_id, full_name, email, role, manager_id, work_country, timezone)
select :de_hire, o.id, 'Dieter Hire', 'hire@eu-co.test', 'employee', :eu_owner, 'DE', 'Europe/Berlin'
from orgs_by_region o where o.region = 'eu';
select pg_temp.act_as(:eu_owner);
select is((public.policy_settings() ->> 'works_council_members')::int, 1, 'the settings count people in works council countries');
select is(pg_temp.err($$ select public.update_policy('{"webcam": true}', true, false) $$), 'works_council_required:webcam',
  'with someone in Germany the works council consultation is needed too');
select is(pg_temp.err($$ select public.update_policy('{"webcam": true}', true, true) $$), 'no error', 'confirmed, it saves');
select pg_temp.act_as_postgres();
select is(
  (select metadata ->> 'works_council_confirmed' from public.audit_log where action = 'policy.dpia_confirmed'
     and org_id = (select id from orgs_by_region where region = 'eu') order by id desc limit 1),
  'true', 'and the works council confirmation is logged with it');

-- No gate outside the EU
select pg_temp.act_as(:us_owner);
select is(pg_temp.save('webcam', 'false'), 'ok', 'a US org turns webcam off');
select is(pg_temp.save('webcam', 'true'), 'ok', 'and on again with no confirmation');
select pg_temp.act_as_postgres();
select is(pg_temp.audits((select id from orgs_by_region where region = 'us'), 'policy.dpia_confirmed'), 0, 'and no DPIA entry');

-- Admin MFA ----------------------------------------------------------------------------------

select pg_temp.act_as(:ada, 'aal2');
select public.update_policy('{"require_admin_mfa": true}');
select pg_temp.act_as(:ada, 'aal1');
select is(pg_temp.save('week_start', '"monday"'), 'mfa_required:', 'an org that requires MFA changes its policy with a verified session only');
select pg_temp.act_as(:ada, 'aal2');
select is(pg_temp.save('week_start', '"monday"'), 'ok', 'which works');

-- Approval (TS-16) -------------------------------------------------------------------------------

select pg_temp.act_as(:max);
select is(pg_temp.err($$ select public.set_approval_required('00000000-0000-4000-8000-0000000000c1', false) $$), 'admin_only:',
  'a manager cannot turn approval off');
select pg_temp.act_as(:ada, 'aal2');
select public.set_approval_required(:erin, false);
select pg_temp.act_as_postgres();
select is((select approval_required from public.users where id = :erin), false, 'an admin turns approval off for a person');
select is(
  (select metadata from public.audit_log where action = 'member.approval_changed' and target_user_id = :erin),
  '{"from": true, "to": false}'::jsonb, 'audit-logged with before and after');
select pg_temp.act_as(:ada, 'aal2');
select public.set_approval_required(:erin, false);
select pg_temp.act_as_postgres();
select is((select count(*)::int from public.audit_log where action = 'member.approval_changed'), 1,
  'setting the same value again logs nothing');
select pg_temp.act_as(:ada, 'aal2');
select public.set_approval_required(:erin, true);
select pg_temp.act_as_postgres();
select is((select approval_required from public.users where id = :erin), true, 'and back on');
select pg_temp.act_as(:eu_owner);
select is(pg_temp.err($$ select public.set_approval_required('00000000-0000-4000-8000-0000000000c1', false) $$), 'admin_only:',
  'an admin of another org cannot change someone here');

select * from finish();
rollback;
