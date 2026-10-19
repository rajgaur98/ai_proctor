begin;
create extension if not exists pgtap with schema extensions;

select plan(8);

\set max '''00000000-0000-4000-8000-0000000000b1'''
\set erin '''00000000-0000-4000-8000-0000000000c1'''
\set lucas '''00000000-0000-4000-8000-0000000000c2'''
\set checkin '''0190f5b0-0000-7000-8000-00000000c0de'''

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

-- Erin passes a check-in with a screenshot and a webcam frame.
select pg_temp.act_as(:erin);
create temp table dev as select device_id from public.register_device('macos', '26.0', '0.1.0', 'hash-erin-captures');
select public.agent_events((select device_id from dev), jsonb_build_array(
  jsonb_build_object('id', gen_random_uuid(), 'seq', 1, 'type', 'clock_in', 'at', pg_temp.ts('10 minutes'),
    'mono_ms', 1, 'payload', '{"reason": "manual"}'::jsonb),
  jsonb_build_object('id', :checkin, 'seq', 2, 'type', 'checkin', 'at', pg_temp.ts('5 minutes'),
    'mono_ms', 2, 'payload', jsonb_build_object('scheduled_at', pg_temp.ts('5 minutes'),
      'responded_at', pg_temp.ts('5 minutes'), 'outcome', 'pass', 'wrong_clicks', 0,
      'object_keys', '["webcam.webp", "screen-1.webp"]'::jsonb, 'flags', '[]'::jsonb))
));

-- Her manager opens it.
select pg_temp.act_as(:max);
create temp table v as select public.capture_view(:checkin) as r;
select is(
  (select jsonb_agg(o ->> 'name') from v, jsonb_array_elements(r -> 'objects') o),
  '["screen-1.webp", "webcam.webp"]'::jsonb,
  'the manager gets the files'
);
select ok(
  (select (r -> 'objects' -> 0 ->> 'path') like '00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-0000000000c1/%/0190f5b0-0000-7000-8000-00000000c0de/screen-1.webp' from v),
  'paths follow the upload layout {org}/{user}/{date}/{checkin}/{file}'
);
select is((select (r ->> 'expired')::boolean from v), false, 'recent captures are not expired');

-- Every view is logged, repeats included.
select public.capture_view(:checkin);
select pg_temp.act_as(:erin);
select lives_ok($$ select public.capture_view('0190f5b0-0000-7000-8000-00000000c0de') $$,
  'Erin can open her own (My data, EMP)');
select set_config('role', 'postgres', true);
select is(
  (select count(*)::int from public.audit_log where action = 'capture.viewed' and target_user_id = :erin),
  3, 'each view is a separate audit row'
);
select is(
  (select actor_id from public.audit_log where action = 'capture.viewed' order by id limit 1),
  :max::uuid, 'with who looked'
);

-- A peer can't, and gets the same answer as for a check-in that doesn't exist.
select pg_temp.act_as(:lucas);
select throws_ok($$ select public.capture_view('0190f5b0-0000-7000-8000-00000000c0de') $$,
  '42501', 'checkin_not_found', 'a peer cannot open it');

-- Past retention (30 days by default): nothing to sign.
select set_config('role', 'postgres', true);
update public.checkin_events set scheduled_at = now() - interval '31 days' where id = :checkin;
select pg_temp.act_as(:max);
select is((public.capture_view(:checkin) ->> 'expired')::boolean, true, 'past retention it is expired');

select * from finish();
rollback;
