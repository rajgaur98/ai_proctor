-- #253: an employee removes parts of their own check-ins (EMP-06, CAP-09, AUD-01).
begin;
create extension if not exists pgtap with schema extensions;

select plan(41);

\set org '''00000000-0000-4000-8000-000000000001'''
\set ada '''00000000-0000-4000-8000-0000000000a1'''
\set max '''00000000-0000-4000-8000-0000000000b1'''
\set erin '''00000000-0000-4000-8000-0000000000c1'''
\set lucas '''00000000-0000-4000-8000-0000000000c2'''
\set checkin '''0190f5b0-0000-7000-8000-00000000253a'''
\set other '''0190f5b0-0000-7000-8000-00000000253b'''
\set miss '''0190f5b0-0000-7000-8000-00000000253c'''

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

create function pg_temp.ts(t timestamptz) returns text
language sql as $$ select to_char(t at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') $$;

create temp table seqs (n int);
insert into seqs values (0);
grant all on seqs to authenticated;

-- The check-in is answered 15 s into a whole minute 20 minutes ago.
create temp table m as select date_trunc('minute', now() - interval '20 minutes') as t;
grant select on m to authenticated;

create function pg_temp.send(id uuid, type text, payload jsonb, at timestamptz)
returns text
language plpgsql as $$
declare
  n int;
begin
  update seqs set n = seqs.n + 1 returning seqs.n into n;
  return public.agent_events(
    (select device_id from dev),
    jsonb_build_array(jsonb_build_object('id', id, 'seq', n, 'type', type,
      'at', pg_temp.ts(at), 'mono_ms', n, 'payload', payload))
  ) -> 'rejected' -> 0 ->> 'reason';
end;
$$;

create function pg_temp.app(app text, title text, domain text, start_s int, end_s int)
returns jsonb
language sql as $$
  select jsonb_build_object('app', app, 'title', title, 'domain', domain,
    'start', pg_temp.ts((select t from m) + make_interval(secs => start_s)),
    'end', pg_temp.ts((select t from m) + make_interval(secs => end_s)))
$$;

create function pg_temp.pass(id uuid, keys jsonb) returns text
language sql as $$
  select pg_temp.send(id, 'checkin', jsonb_build_object(
    'scheduled_at', pg_temp.ts((select t from m) + interval '10 seconds'),
    'shown_at', pg_temp.ts((select t from m) + interval '10 seconds'),
    'responded_at', pg_temp.ts((select t from m) + interval '15 seconds'),
    'outcome', 'pass', 'response_ms', 5000, 'wrong_clicks', 0,
    'object_keys', keys, 'flags', '[]'::jsonb), (select t from m) + interval '15 seconds')
$$;

-- Storage paths of the check-in's files, worked out as postgres (capture_path is internal).
create temp table paths (checkin_id uuid, name text, path text);
grant select on paths to authenticated;
create function pg_temp.path(p_id uuid, p_name text) returns text
language sql as $$ select p.path from paths p where p.checkin_id = p_id and p.name = p_name $$;

-- Erin works: a passed check-in with a screenshot and a webcam frame, both uploaded, and
-- the app she had in front (a browser on a site) and another app in the same minute.
select pg_temp.act_as(:erin);
create temp table dev as select device_id from public.register_device('macos', '26.0', '0.1.0', 'hash-erin-253');
grant select on dev to authenticated;
select pg_temp.send(gen_random_uuid(), 'clock_in', '{"reason": "manual"}', (select t from m) - interval '1 hour');
select pg_temp.pass(:checkin, '["screen-1.webp", "webcam.webp"]');
select pg_temp.pass(:other, '[]');
select pg_temp.send(:miss, 'checkin', jsonb_build_object(
  'scheduled_at', pg_temp.ts((select t from m) - interval '5 minutes'),
  'shown_at', pg_temp.ts((select t from m) - interval '5 minutes'),
  'outcome', 'miss', 'wrong_clicks', 0, 'object_keys', '[]'::jsonb, 'flags', '[]'::jsonb),
  (select t from m) - interval '4 minutes');
select pg_temp.send(gen_random_uuid(), 'app_session',
  pg_temp.app('Safari', 'Q3 plan - Docs', 'docs.example.com', 0, 40), (select t from m) + interval '40 seconds');
select pg_temp.send(gen_random_uuid(), 'app_session',
  pg_temp.app('Slack', 'General', null, 40, 60), (select t from m) + interval '60 seconds');
-- An app in the next minute: not this check-in's.
select pg_temp.send(gen_random_uuid(), 'app_session',
  pg_temp.app('Xcode', 'App.swift', null, 60, 90), (select t from m) + interval '90 seconds');

select pg_temp.act_as_postgres();
insert into paths
select c.id, k, internal.capture_path(c.org_id, c.user_id, c.scheduled_at, c.id, k)
from public.checkin_events c, unnest(c.object_keys) k where c.id = :checkin;
insert into storage.objects (bucket_id, name) values
  ('captures', pg_temp.path(:checkin, 'screen-1.webp')),
  ('captures', pg_temp.path(:checkin, 'webcam.webp'));
create temp table before as
select outcome, responded_at, response_ms, object_keys,
  (select row(p.status, p.last_checkin_at, p.last_checkin_outcome)::text from public.presence p where p.user_id = :erin) as presence
from public.checkin_events where id = :checkin;
create temp table audits as select coalesce(max(id), 0) as since from public.audit_log;

select is((select count(*)::int from public.activity_samples where user_id = :erin and minute = (select t from m)),
  2, 'setup: two apps in the check-in''s minute');

-- Nobody else can: a peer, the manager, the owner, an admin. Same answer as "doesn't exist".
select pg_temp.act_as(:lucas);
select throws_ok($$ select public.delete_checkin_parts('0190f5b0-0000-7000-8000-00000000253a', '{webcam}') $$,
  '42501', 'checkin_not_found', 'another employee is refused');
select throws_ok($$ select public.checkin_removed_paths('0190f5b0-0000-7000-8000-00000000253a') $$,
  '42501', 'checkin_not_found', 'and cannot list the removed files');
select pg_temp.act_as(:max);
select throws_ok($$ select public.delete_checkin_parts('0190f5b0-0000-7000-8000-00000000253a', '{webcam}') $$,
  '42501', 'checkin_not_found', 'her manager is refused');
select pg_temp.act_as(:ada);
select throws_ok($$ select public.delete_checkin_parts('0190f5b0-0000-7000-8000-00000000253a', '{screen,webcam,apps,domains}') $$,
  '42501', 'checkin_not_found', 'the owner is refused');
select pg_temp.act_as_postgres();
update public.users set role = 'admin' where id = :lucas;
select pg_temp.act_as(:lucas);
select throws_ok($$ select public.delete_checkin_parts('0190f5b0-0000-7000-8000-00000000253a', '{webcam}') $$,
  '42501', 'checkin_not_found', 'an admin is refused');
select pg_temp.act_as_postgres();
update public.users set role = 'employee' where id = :lucas;
select pg_temp.act_as_postgres();
select set_config('role', 'authenticated', true);
select throws_ok($$ select public.delete_checkin_parts('0190f5b0-0000-7000-8000-00000000253a', '{webcam}') $$,
  '42501', 'not_signed_in', 'signed out is refused');

select pg_temp.act_as_postgres();
select ok(
  (select webcam_deleted_at is null and screen_deleted_at is null and apps_deleted_at is null
     and domains_deleted_at is null from public.checkin_events where id = :checkin),
  'a refusal changes nothing'
);
select is((select count(*)::int from public.audit_log where id > (select since from audits)), 0,
  'and logs no deletion');

-- Erin: bad requests.
select pg_temp.act_as(:erin);
select throws_ok($$ select public.delete_checkin_parts('0190f5b0-0000-7000-8000-00000000253a', '{}') $$,
  '22023', 'invalid_parts', 'nothing picked is refused');
select throws_ok($$ select public.delete_checkin_parts('0190f5b0-0000-7000-8000-00000000253a', '{webcam,titles}') $$,
  '22023', 'invalid_parts', 'an unknown part is refused');
select throws_ok($$ select public.delete_checkin_parts('0190f5b0-0000-7000-8000-00000000253c', '{apps}') $$,
  '22023', 'not_a_pass', 'a miss has nothing to remove');

-- The webcam frame only.
create temp table r1 as select public.delete_checkin_parts(:checkin, '{webcam}') as r;
select is((select r -> 'paths' from r1), to_jsonb(array[pg_temp.path(:checkin, 'webcam.webp')]),
  'the webcam file is returned for removal from Storage');
select is((select (r ->> 'objects')::int from r1), 1, 'one object in Storage');
select pg_temp.act_as_postgres();
select ok(
  (select webcam_deleted_at is not null and screen_deleted_at is null and apps_deleted_at is null
     and domains_deleted_at is null from public.checkin_events where id = :checkin),
  'the tombstone is set for the webcam only'
);
select is(
  (select jsonb_build_object('actor', actor_id, 'target', target_user_id, 'parts', metadata -> 'parts',
     'files', metadata -> 'files', 'objects', metadata -> 'objects', 'checkin', metadata ->> 'checkin_id')
   from public.audit_log where id > (select since from audits) and action = 'capture.deleted'),
  jsonb_build_object('actor', :erin, 'target', :erin, 'parts', '["webcam"]'::jsonb,
    'files', '["webcam.webp"]'::jsonb, 'objects', 1, 'checkin', :checkin),
  'capture.deleted: Erin on herself, the check-in, the part, the file and the object count'
);

-- The manager's view: only the screenshot, and when the webcam frame was removed.
select pg_temp.act_as(:max);
create temp table v as select public.capture_view(:checkin) as r;
select is((select jsonb_agg(o ->> 'name') from v, jsonb_array_elements(r -> 'objects') o),
  '["screen-1.webp"]'::jsonb, 'the manager no longer gets the webcam frame');
select ok((select (r -> 'removed' ->> 'webcam') is not null and (r -> 'removed' ->> 'screen') is null from v),
  'and sees that it was removed');
select is((select r ->> 'app' from v), 'Safari', 'the app is still there');

-- The agent can't upload it again; the screenshot still can.
select pg_temp.act_as(:erin);
select is(internal.can_upload_capture(pg_temp.path(:checkin, 'webcam.webp')), false,
  'a removed webcam frame cannot be uploaded again');
select is(internal.can_upload_capture(pg_temp.path(:checkin, 'screen-1.webp')), true,
  'the screenshot is unaffected');

-- Again: nothing new, no second audit row, the file is listed until Storage removed it.
create temp table r2 as select public.delete_checkin_parts(:checkin, '{webcam}') as r;
select is((select r -> 'new_parts' from r2), '[]'::jsonb, 'a part already removed is not removed again');
select is((select r -> 'paths' from r2), to_jsonb(array[pg_temp.path(:checkin, 'webcam.webp')]),
  'a file still in Storage is returned again');
select pg_temp.act_as_postgres();
select is((select count(*)::int from public.audit_log where id > (select since from audits)
  and action in ('capture.deleted', 'activity.deleted')), 1, 'and no second audit row');
-- The function removes it through the Storage API; here, the same effect.
select set_config('storage.allow_delete_query', 'true', true);
delete from storage.objects where name = pg_temp.path(:checkin, 'webcam.webp');
select pg_temp.act_as(:erin);
select is(public.checkin_removed_paths(:checkin), '{}'::text[], 'nothing left once Storage removed it');

-- Domains: the site and the page title of the browser minute go; the app names stay.
create temp table r3 as select public.delete_checkin_parts(:checkin, '{domains}') as r;
select is((select (r ->> 'samples_cleared')::int from r3), 1, 'one browser sample cleared');
select pg_temp.act_as_postgres();
select is(
  (select jsonb_agg(jsonb_build_array(app_name, window_title, domain) order by app_name)
   from public.activity_samples where user_id = :erin and minute = (select t from m)),
  '[["Safari", null, null], ["Slack", "General", null]]'::jsonb,
  'the domain and the browser title are gone, the apps stay'
);
select is(
  (select count(*)::int from public.agent_events_raw
   where user_id = :erin and type = 'app_session' and payload ? 'domain' and payload ->> 'domain' is not null
     and date_trunc('minute', (payload ->> 'start')::timestamptz) = (select t from m)),
  0, 'and the raw events keep no domain'
);
select is(
  (select metadata - 'minute' from public.audit_log where id > (select since from audits) and action = 'activity.deleted'),
  jsonb_build_object('checkin_id', :checkin, 'parts', '["domains"]'::jsonb, 'samples_deleted', 0,
    'samples_cleared', 1, 'raw_events', 1),
  'activity.deleted with the parts and the counts'
);

-- Apps: the minute's samples go, and the raw events keep no app; the next minute is untouched.
select pg_temp.act_as(:erin);
create temp table r4 as select public.delete_checkin_parts(:checkin, '{apps}') as r;
select is((select (r ->> 'samples_deleted')::int from r4), 2, 'both samples of the minute deleted');
select pg_temp.act_as_postgres();
select is((select count(*)::int from public.activity_samples where user_id = :erin and minute = (select t from m)),
  0, 'none left in the minute');
select is((select count(*)::int from public.activity_samples where user_id = :erin and minute = (select t from m) + interval '1 minute'),
  1, 'the next minute is not the check-in''s and stays');
select is(
  (select count(*)::int from public.agent_events_raw
   where user_id = :erin and type = 'app_session' and payload ? 'app'
     and date_trunc('minute', (payload ->> 'start')::timestamptz) = (select t from m)),
  0, 'the raw events of the minute keep no app'
);

-- A sample of that minute arriving late is accepted but not kept, nor its app in the raw event.
select pg_temp.act_as(:erin);
select is(pg_temp.send(gen_random_uuid(), 'app_session', pg_temp.app('Notes', 'Diary', null, 20, 30),
  (select t from m) + interval '30 seconds'), null, 'a late sample of the minute is accepted');
select pg_temp.act_as_postgres();
select is((select count(*)::int from public.activity_samples where user_id = :erin and minute = (select t from m)),
  0, 'but not stored');
select is(
  (select count(*)::int from public.agent_events_raw
   where user_id = :erin and type = 'app_session' and payload ? 'app'
     and date_trunc('minute', (payload ->> 'start')::timestamptz) = (select t from m)),
  0, 'and its raw event keeps no app');

-- The screenshot too; the check-in result and its facts are unchanged.
select pg_temp.act_as(:erin);
select public.delete_checkin_parts(:checkin, '{screen}');
select pg_temp.act_as_postgres();
select ok(
  (select webcam_deleted_at is not null and screen_deleted_at is not null and apps_deleted_at is not null
     and domains_deleted_at is not null from public.checkin_events where id = :checkin),
  'every part has its tombstone'
);
select is(
  (select row(outcome, responded_at, response_ms, object_keys)::text from public.checkin_events where id = :checkin),
  (select row(outcome, responded_at, response_ms, object_keys)::text from before),
  'the check-in still passed, with the same answer and file names'
);
select is(
  (select row(p.status, p.last_checkin_at, p.last_checkin_outcome)::text from public.presence p where p.user_id = :erin),
  (select presence from before), 'and the live status is unchanged');
select is(
  (select count(*)::int from public.audit_log where id > (select since from audits)
     and action in ('capture.deleted', 'activity.deleted')),
  4, 'one audit row per call that removed something'
);

-- An admin removes their own: Erin as an admin, on her other check-in.
update public.users set role = 'admin' where id = :erin;
select pg_temp.act_as(:erin);
select lives_ok($$ select public.delete_checkin_parts('0190f5b0-0000-7000-8000-00000000253b', '{apps}') $$,
  'an admin can remove parts of their own check-in');

select * from finish();
rollback;
