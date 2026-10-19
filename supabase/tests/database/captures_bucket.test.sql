begin;
create extension if not exists pgtap with schema extensions;

select plan(13);

\set org '''00000000-0000-4000-8000-000000000001'''
\set erin '''00000000-0000-4000-8000-0000000000c1'''
\set lucas '''00000000-0000-4000-8000-0000000000c2'''

create function pg_temp.act_as(uid uuid) returns void
language sql as $$
  select set_config('role', 'authenticated', true);
  select set_config('request.jwt.claims',
    jsonb_build_object('sub', uid, 'role', 'authenticated')::text, true);
$$;

create function pg_temp.act_as_postgres() returns void
language sql as $$
  select set_config('role', 'postgres', true);
  select set_config('request.jwt.claims', '', true);
$$;

-- Erin's device, one passed check-in with two files, one miss.
insert into public.devices (id, org_id, user_id, platform, os_version, agent_version, hardware_hash)
values ('00000000-0000-4000-8000-0000000000d1', :org, :erin, 'macos', '26.0', '0.1.0', 'hash-erin-cap');
insert into public.checkin_events (id, org_id, user_id, device_id, scheduled_at, outcome, object_keys)
values
  ('00000000-0000-4000-8000-0000000000f1', :org, :erin, '00000000-0000-4000-8000-0000000000d1',
   '2026-10-19T09:40:00Z', 'pass', array['screen-1.webp', 'webcam.webp']),
  ('00000000-0000-4000-8000-0000000000f2', :org, :erin, '00000000-0000-4000-8000-0000000000d1',
   '2026-10-19T11:00:00Z', 'miss', '{}');

create function pg_temp.upload(path text) returns void
language sql as $$
  insert into storage.objects (bucket_id, name, owner_id) values ('captures', path, auth.uid()::text);
$$;

\set ok_path '''00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-0000000000c1/2026-10-19/00000000-0000-4000-8000-0000000000f1/screen-1.webp'''

select is((select public from storage.buckets where id = 'captures'), false, 'captures bucket is private');
select is((select allowed_mime_types from storage.buckets where id = 'captures'), array['image/webp'], 'only WebP is accepted');

select pg_temp.act_as(:erin);
select lives_ok(format('select pg_temp.upload(%L)', :ok_path), 'Erin uploads a declared file for her passed check-in');
select lives_ok(
  format('select pg_temp.upload(%L)', replace(:ok_path, 'screen-1.webp', 'webcam.webp')),
  'and the second declared file'
);
select throws_ok(
  format('select pg_temp.upload(%L)', replace(:ok_path, 'screen-1.webp', 'screen-2.webp')),
  '42501', null, 'a file the check-in did not declare is refused'
);
select throws_ok(
  format('select pg_temp.upload(%L)', replace(:ok_path, '2026-10-19', '2026-10-18')),
  '42501', null, 'the wrong date folder is refused'
);
select throws_ok(
  format('select pg_temp.upload(%L)',
    replace(replace(:ok_path, '0000000000f1', '0000000000f2'), 'screen-1.webp', 'screen-1.webp')),
  '42501', null, 'nothing can be uploaded for a missed check-in'
);
select throws_ok(
  format('select pg_temp.upload(%L)', replace(:ok_path, '0000000000f1', '0000000000f9')),
  '42501', null, 'a check-in that does not exist (orphaned file) is refused'
);

select pg_temp.act_as(:lucas);
select throws_ok(
  format('select pg_temp.upload(%L)', replace(:ok_path, 'screen-1.webp', 'webcam.webp')),
  '42501', null, 'another user cannot upload into Erin''s folder'
);
select is_empty('select 1 from storage.objects where bucket_id = ''captures''', 'other users cannot list captures');

select pg_temp.act_as(:erin);
select is_empty('select 1 from storage.objects where bucket_id = ''captures''', 'even the owner cannot read captures through the API');

select pg_temp.act_as_postgres();
select is(
  (select count(*)::int from storage.objects where bucket_id = 'captures'), 2,
  'exactly the two allowed files were stored'
);

-- Only the functions policies need are callable by API roles in the internal schema.
select is_empty(
  $$ select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'internal' and p.proname not in ('can_upload_capture', 'jwt_org_id')
       and (has_function_privilege('authenticated', p.oid, 'execute')
            or has_function_privilege('anon', p.oid, 'execute')) $$,
  'no other internal function is executable by anon or authenticated'
);

select * from finish();
rollback;
