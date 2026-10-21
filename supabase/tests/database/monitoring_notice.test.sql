begin;
create extension if not exists pgtap with schema extensions;

select plan(61);

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

create function pg_temp.ts(ago interval) returns text
language sql as $$ select to_char((now() - ago) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') $$;

create function pg_temp.latest() returns uuid
language sql as $$
  select id from public.notices where org_id = '00000000-0000-4000-8000-000000000001' order by version desc limit 1
$$;

create function pg_temp.latest_version() returns int
language sql as $$
  select max(version) from public.notices where org_id = '00000000-0000-4000-8000-000000000001'
$$;

-- Template text ---------------------------------------------------------------------------

select pg_temp.act_as_postgres();
create temp table tpl as
select r.region,
  internal.default_notice_body('00000000-0000-4000-8000-000000000001', r.region, '{}') as body
from unnest(enum_range(null::public.region_preset)) as r(region);

select is((select count(*)::int from tpl where internal.valid_notice_body(body)), 3,
  'there is a valid template for every region preset');
select ok((select body ->> 'intro' from tpl where region = 'us') like '%New York, Connecticut and Delaware%',
  'US: state notice laws');
select ok((select body ->> 'intro' from tpl where region = 'eu') like '%GDPR Art. 6(1)(f)%'
  and (select body ->> 'rights' from tpl where region = 'eu') like '%supervisory authority%',
  'EU: controller, legal basis and GDPR rights');
select ok((select body ->> 'intro' from tpl where region = 'india') like '%Digital Personal Data Protection Act%'
  and (select body ? 'grievance' from tpl where region = 'india'),
  'India: DPDP wording and a grievance contact');
select ok(not (select body ? 'grievance' from tpl where region = 'us'), 'only the India template has a grievance contact');
select ok((select body ->> 'collected' from tpl where region = 'us') like '%one still webcam frame%'
  and (select body ->> 'collected' from tpl where region = 'us') like '%its window title%'
  and (select body ->> 'retention' from tpl where region = 'us') like '%after 30 days%',
  'filled from the default policy: webcam, window titles, 30 days');
select ok(internal.default_notice_body(:org, 'us', '{"webcam": false, "screenshots": "blurred", "window_titles": false, "image_retention_days": 14, "excluded_apps": ["1Password"]}')::text
  ~ 'a blurred screenshot of each screen \(blurred on your computer before it is sent\)\.'
  and internal.default_notice_body(:org, 'us', '{"webcam": false, "screenshots": "blurred", "window_titles": false, "image_retention_days": 14, "excluded_apps": ["1Password"]}')::text
  !~ 'one still webcam frame|its window title'
  and internal.default_notice_body(:org, 'us', '{"webcam": false, "screenshots": "blurred", "window_titles": false, "image_retention_days": 14, "excluded_apps": ["1Password"]}') ->> 'retention' like '%after 14 days%'
  and internal.default_notice_body(:org, 'us', '{"excluded_apps": ["1Password"]}') ->> 'collected' like '%1password%',
  'the text follows the policy: blurred, no webcam or titles, 14 days, excluded apps');
select is(internal.default_notice_body(:org, 'eu', '{"image_retention_days": 90}') ->> 'retention',
  (select body ->> 'retention' from tpl where region = 'eu'), 'EU retention is capped at 30 days');
select ok(internal.default_notice_body(:org, 'us', '{"screenshots": "off", "webcam": false}') ->> 'retention' like 'No images are collected.%',
  'no images, no image retention sentence');

select throws_ok($$ insert into public.notices (org_id, version, region, body, collection)
  values ('00000000-0000-4000-8000-000000000001', 99, 'us', '{"collected": "x"}', '{}') $$,
  '23514', null, 'a notice needs every section');
select throws_ok($$ insert into public.notices (org_id, version, region, body, collection)
  values ('00000000-0000-4000-8000-000000000001', 99, 'us',
    '{"collected": "a", "when": "b", "who": "c", "retention": "d", "rights": "e", "extra": "f"}', '{}') $$,
  '23514', null, 'and nothing else');

-- New orgs start from the template -----------------------------------------------------------

insert into public.orgs (id, name, region_preset)
values ('00000000-0000-4000-8000-0000000000d1', 'Euro Co', 'eu');
select results_eq(
  $$ select version, region::text, body = internal.default_notice_body(org_id, 'eu', '{}') from public.notices
     where org_id = '00000000-0000-4000-8000-0000000000d1' $$,
  $$ values (1, 'eu', true) $$,
  'a new org gets version 1 from its region template');
select results_eq(
  $$ select version, region::text, published_by is null from public.notices where org_id = '00000000-0000-4000-8000-000000000001' $$,
  $$ values (1, 'us', true) $$,
  'the seed org has version 1');

-- Reading ------------------------------------------------------------------------------------

select pg_temp.act_as(:erin);
select is((select count(*)::int from public.notices), 1, 'an employee reads their own org''s notices, not another org''s');
select throws_ok($$ insert into public.notices (org_id, version, region, body, collection)
  values ('00000000-0000-4000-8000-000000000001', 5, 'us',
    '{"collected": "a", "when": "b", "who": "c", "retention": "d", "rights": "e"}', '{}') $$,
  '42501', null, 'but cannot write one');
select throws_ok($$ select public.publish_notice(public.notice_template()) $$, '42501', 'admin_only',
  'only admins publish');
select throws_ok($$ select public.notice_template() $$, '42501', 'admin_only', 'or read the editing template');

-- Seed acknowledgements ------------------------------------------------------------------------

select is((select count(*)::int from public.notice_acks), 1, 'Erin sees her own acknowledgement only (not a peer''s)');
select pg_temp.act_as(:max);
select is((select count(*)::int from public.notice_acks), 3, 'her manager sees his own, Erin''s and Lucas''s');
select pg_temp.act_as(:ada);
select is((select count(*)::int from public.notice_acks), 4, 'an admin sees everyone''s');

-- Publishing -----------------------------------------------------------------------------------

select throws_ok($$ select public.publish_notice('{"collected": "only this"}') $$, '22023', 'invalid_notice',
  'an incomplete notice is refused');
create temp table pub as
select public.publish_notice(public.notice_template() || '{"intro": "Custom words from the admin."}') as v;
grant select on pub to authenticated;
select is((select v from pub), 2, 'an admin publishes version 2 with their wording');
select pg_temp.act_as_postgres();
select results_eq(
  $$ select version, body ->> 'intro', published_by, region::text from public.notices where org_id = '00000000-0000-4000-8000-000000000001' order by version $$,
  $$ values (1, (select body ->> 'intro' from tpl where region = 'us'), null::uuid, 'us'),
            (2, 'Custom words from the admin.', '00000000-0000-4000-8000-0000000000a1'::uuid, 'us') $$,
  'both versions are kept, with who published');
select is((select collection from public.notices where org_id = :org and version = 2),
  internal.collection_snapshot('{}'), 'the collection snapshot is taken at publish time');
select throws_ok($$ update public.notices set body = body where org_id = '00000000-0000-4000-8000-000000000001' $$, '42501',
  'notice_history_is_append_only', 'a published version is never edited');
select results_eq(
  $$ select action, actor_id, metadata ->> 'version', metadata ->> 'source' from public.audit_log
     where org_id = '00000000-0000-4000-8000-000000000001' and action = 'notice.published' order by id $$,
  $$ values ('notice.published', null::uuid, '1', 'template'),
            ('notice.published', '00000000-0000-4000-8000-0000000000a1'::uuid, '2', 'admin') $$,
  'publishing is audit-logged');

-- Acknowledging ----------------------------------------------------------------------------------

select pg_temp.act_as(:erin);
create temp table v1 as select id from public.notices where org_id = :org and version = 1;
grant select on v1 to authenticated;
select throws_ok($$ select public.acknowledge_notice((select id from v1)) $$, '22023', 'not_current_notice',
  'only the latest version can be acknowledged');
select throws_ok($$ select public.acknowledge_notice((select id from public.notices where org_id <> '00000000-0000-4000-8000-000000000001' limit 1)) $$,
  '42501', 'notice_not_found', 'another org''s notice does not exist for her');
select throws_ok($$ select public.acknowledge_notice(gen_random_uuid()) $$, '42501', 'notice_not_found',
  'neither does an unknown one');

select pg_temp.act_as_postgres();
create temp table pv as select policy_version,
  (select config_version from public.users where id = :erin) as config_version
from public.orgs where id = :org;
grant select on pv to authenticated;
select pg_temp.act_as(:erin);
select lives_ok($$ select public.acknowledge_notice(pg_temp.latest()) $$, 'Erin acknowledges version 2');
select lives_ok($$ select public.acknowledge_notice(pg_temp.latest()) $$, 'doing it again is harmless');
select results_eq(
  $$ select n.version from public.notice_acks a join public.notices n on n.id = a.notice_id
     where a.user_id = '00000000-0000-4000-8000-0000000000c1' order by n.version $$,
  $$ values (1), (2) $$, 'acknowledgements are stored per version');
select ok((select acknowledged_at from public.notice_acks where user_id = :erin and notice_id = pg_temp.latest())
  > now() - interval '1 minute', 'with a timestamp');
select pg_temp.act_as_postgres();
select is((select policy_version - (select policy_version from pv) from public.orgs where id = :org), 0,
  'the org''s policy version did not move');
select is((select config_version - (select config_version from pv) from public.users where id = :erin), 1,
  'her config version moved once, so her agents refetch');
select results_eq(
  $$ select action, actor_id, target_user_id, metadata ->> 'version' from public.audit_log
     where org_id = '00000000-0000-4000-8000-000000000001' and action = 'notice.acknowledged' $$,
  $$ values ('notice.acknowledged', '00000000-0000-4000-8000-0000000000c1'::uuid,
             '00000000-0000-4000-8000-0000000000c1'::uuid, '2') $$,
  'one audit row, not two');

-- AGT-05: policy changes ------------------------------------------------------------------------------

-- Not a collection key: no new version.
update public.orgs set policy = policy || '{"idle_threshold_min": 12}' where id = :org;
select is(pg_temp.latest_version(), 2, 'a setting that does not affect collection does not publish a notice');
-- Setting a key to what it already effectively is: nothing changes either.
update public.orgs set policy = policy || '{"webcam": true}' where id = :org;
select is(pg_temp.latest_version(), 2, 'nor does spelling out a default');

-- Webcam off: version 3. Version 2 has the admin's wording, so the text is kept as it is.
update public.orgs set policy = policy || '{"webcam": false}' where id = :org;
select is(pg_temp.latest_version(), 3, 'turning the webcam off publishes version 3');
select results_eq(
  $$ select body = (select body from public.notices where org_id = '00000000-0000-4000-8000-000000000001' and version = 2),
            collection ->> 'webcam' from public.notices
     where org_id = '00000000-0000-4000-8000-000000000001' and version = 3 $$,
  $$ values (true, 'false') $$,
  'the admin''s own wording is kept, and the snapshot has the webcam off');
select results_eq(
  $$ select metadata ->> 'version', metadata ->> 'source', metadata -> 'changed' from public.audit_log
     where org_id = '00000000-0000-4000-8000-000000000001' and action = 'notice.published' and metadata ->> 'source' = 'policy_change' $$,
  $$ values ('3', 'policy_change', '["webcam"]'::jsonb) $$,
  'an automatic version is audit-logged with the keys that changed');

-- Back to the unedited template for the rest: publish version 4 from it, then change policy.
select pg_temp.act_as(:ada);
select is(public.publish_notice(public.notice_template()), 4, 'the admin resets to the template (version 4)');
select pg_temp.act_as_postgres();
update public.orgs set policy = policy || '{"window_titles": false}' where id = :org;
select results_eq(
  $$ select version, body ->> 'collected' !~ 'window title' from public.notices where org_id = '00000000-0000-4000-8000-000000000001' and version = 5 $$,
  $$ values (5, true) $$,
  'an unedited template is re-rendered for the new policy');
update public.orgs set policy = policy || '{"webcam": true, "screenshots": "blurred", "excluded_apps": ["Slack", "slack", "Notes"]}' where id = :org;
select is((select collection from public.notices where org_id = :org and version = 6),
  '{"webcam": true, "screenshots": "blurred", "window_titles": false, "excluded_apps": ["notes", "slack"], "activity_sampling": true, "face_presence": false}'::jsonb,
  'the snapshot normalises excluded apps and fills defaults');

-- Effective collection ----------------------------------------------------------------------------------

-- Erin acknowledged version 2 (full screenshots, webcam and titles on, no exclusions). Since then the policy
-- has turned titles off, blurred screenshots and excluded apps (all stricter) and has the webcam on again.
select is(internal.effective_collection(:erin),
  '{"webcam": true, "screenshots": "blurred", "window_titles": false, "excluded_apps": ["notes", "slack"], "activity_sampling": true, "face_presence": false}'::jsonb,
  'collecting less applies at once, even before she acknowledges the new version');

-- Lucas has never acknowledged anything (the seed's acknowledgement removed).
delete from public.notice_acks where user_id = :lucas;
select is(internal.effective_collection(:lucas),
  '{"webcam": false, "screenshots": "off", "window_titles": false, "excluded_apps": [], "activity_sampling": false, "face_presence": false}'::jsonb,
  'before the first acknowledgement nothing is collected');

select pg_temp.act_as(:lucas);
create temp table dev as select device_id from public.register_device('macos', '26.0', '0.1.0', 'hash-lucas-notice');
grant select on dev to authenticated;
create function pg_temp.config() returns jsonb language sql as $$ select public.agent_config((select device_id from dev)) $$;
grant execute on function pg_temp.config() to authenticated;

select results_eq(
  $$ select pg_temp.config() -> 'policy' ->> 'webcam', pg_temp.config() -> 'policy' ->> 'screenshots',
            pg_temp.config() -> 'policy' ->> 'activity_sampling', pg_temp.config() -> 'policy' ->> 'idle_threshold_min',
            pg_temp.config() -> 'notice' ->> 'acknowledged', pg_temp.config() -> 'notice' ->> 'acknowledged_version',
            (pg_temp.config() -> 'notice' ->> 'version')::int $$,
  $$ values ('false', 'off', 'false', '12', 'false', null, 6) $$,
  'the agent config has collection off, the other settings, and the unacknowledged notice');
select ok(pg_temp.config() -> 'notice' -> 'body' ->> 'collected' is not null
  and (pg_temp.config() -> 'notice' ->> 'id')::uuid = pg_temp.latest(),
  'with the current notice''s id and text');

create function pg_temp.clock_in() returns text
language sql as $$
  select public.agent_events((select device_id from dev), jsonb_build_array(jsonb_build_object(
    'id', gen_random_uuid(), 'seq', 1 + (select count(*) from public.agent_events_raw where device_id = (select device_id from dev))::int,
    'type', 'clock_in', 'at', pg_temp.ts('5 minutes'), 'mono_ms', 1, 'payload', '{"reason": "manual"}'::jsonb
  ))) -> 'rejected' -> 0 ->> 'reason'
$$;
grant execute on function pg_temp.clock_in() to authenticated;

select is(pg_temp.clock_in(), 'notice_not_acknowledged', 'the server refuses a clock-in before the first acknowledgement');
select pg_temp.act_as_postgres();
select is((select count(*)::int from public.clock_sessions where user_id = :lucas), 0, 'and no shift is opened');

select pg_temp.act_as(:lucas);
select lives_ok($$ select public.acknowledge_notice(pg_temp.latest()) $$, 'Lucas acknowledges version 6');
select is(pg_temp.clock_in(), null, 'now he can clock in');
select results_eq(
  $$ select pg_temp.config() -> 'policy' ->> 'webcam', pg_temp.config() -> 'policy' ->> 'window_titles',
            pg_temp.config() -> 'notice' ->> 'acknowledged', pg_temp.config() -> 'notice' ->> 'acknowledged_version' $$,
  $$ values ('true', 'false', 'true', '6') $$,
  'and his config follows the snapshot he acknowledged');

-- A policy change that collects more reaches him only after he acknowledges it.
select pg_temp.act_as_postgres();
update public.orgs set policy = policy || '{"webcam": false}' where id = :org;
select pg_temp.act_as(:lucas);
select lives_ok($$ select public.acknowledge_notice(pg_temp.latest()) $$, 'he acknowledges version 7 (webcam off)');
select pg_temp.act_as_postgres();
update public.orgs set policy = policy || '{"webcam": true}' where id = :org;
select is(pg_temp.latest_version(), 8, 'enabling the webcam publishes version 8');
select pg_temp.act_as(:lucas);
select results_eq(
  $$ select pg_temp.config() -> 'policy' ->> 'webcam', pg_temp.config() -> 'notice' ->> 'acknowledged',
            pg_temp.config() -> 'notice' ->> 'acknowledged_version', (pg_temp.config() -> 'notice' ->> 'version')::int $$,
  $$ values ('false', 'false', '7', 8) $$,
  'until he acknowledges it, the webcam stays off for him (and he keeps working)');
select pg_temp.act_as_postgres();
select ok(not (internal.effective_collection(:lucas) ->> 'webcam')::boolean, 'the server uses the same settings');
select pg_temp.act_as(:lucas);
select public.acknowledge_notice(pg_temp.latest());
select is(pg_temp.config() -> 'policy' ->> 'webcam', 'true', 'after acknowledging version 8 the webcam applies to him');

-- Titles and sampling are decided per person on the server too.
select pg_temp.act_as_postgres();
update public.orgs set policy = policy || '{"window_titles": true}' where id = :org;
select is(internal.effective_collection(:lucas) ->> 'window_titles', 'false',
  'turning titles on does not reach him before he acknowledges (his version has them off)');

select pg_temp.act_as(:lucas);
select is(
  public.agent_events((select device_id from dev), jsonb_build_array(jsonb_build_object(
    'id', gen_random_uuid(), 'seq', 1000, 'type', 'app_session', 'at', pg_temp.ts('3 minutes'), 'mono_ms', 1000,
    'payload', jsonb_build_object('app', 'Mail', 'title', 'Re: salary review',
      'start', pg_temp.ts(now() - date_trunc('minute', now() - interval '3 minutes') - interval '5 seconds'),
      'end', pg_temp.ts(now() - date_trunc('minute', now() - interval '3 minutes') - interval '25 seconds'))
  ))) -> 'rejected' -> 0 ->> 'reason',
  null, 'an activity minute is accepted');
select pg_temp.act_as_postgres();
select results_eq(
  $$ select count(*)::int, count(window_title)::int from public.activity_samples
     where user_id = '00000000-0000-4000-8000-0000000000c2' and app_name = 'Mail' $$,
  $$ values (1, 0) $$, 'but its window title is dropped: his acknowledged version has titles off');

select * from finish();
rollback;
