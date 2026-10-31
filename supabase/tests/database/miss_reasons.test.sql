begin;
create extension if not exists pgtap with schema extensions;

select plan(8);

\set max '''00000000-0000-4000-8000-0000000000b1'''
\set erin '''00000000-0000-4000-8000-0000000000c1'''
\set lucas '''00000000-0000-4000-8000-0000000000c2'''

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

-- Erin misses one check-in and passes another.
select pg_temp.act_as(:erin);
create temp table dev as select device_id from public.register_device('macos', '26.0', '0.1.0', 'hash-erin-reasons');
create temp table ids (miss uuid, pass uuid);
insert into ids values (gen_random_uuid(), gen_random_uuid());
grant select on dev, ids to authenticated;
select public.agent_events((select device_id from dev), jsonb_build_array(
  jsonb_build_object('id', gen_random_uuid(), 'seq', 1, 'type', 'clock_in', 'at', pg_temp.ts('1 hour'),
    'mono_ms', 1, 'payload', '{"reason": "manual"}'::jsonb),
  jsonb_build_object('id', (select miss from ids), 'seq', 2, 'type', 'checkin', 'at', pg_temp.ts('40 minutes'),
    'mono_ms', 2, 'payload', jsonb_build_object('scheduled_at', pg_temp.ts('42 minutes'), 'outcome', 'miss',
      'wrong_clicks', 0, 'object_keys', '[]'::jsonb, 'flags', '[]'::jsonb)),
  jsonb_build_object('id', (select pass from ids), 'seq', 3, 'type', 'checkin', 'at', pg_temp.ts('20 minutes'),
    'mono_ms', 3, 'payload', jsonb_build_object('scheduled_at', pg_temp.ts('20 minutes'), 'outcome', 'pass',
      'response_ms', 3000, 'wrong_clicks', 0, 'object_keys', '[]'::jsonb, 'flags', '[]'::jsonb))
));

select lives_ok($$ select public.set_miss_reason((select miss from ids), 'meeting', '  Client call ran over ') $$,
  'Erin explains her miss with a quick pick and a note');
select results_eq($$ select missed_reason_kind, missed_reason from public.checkin_events where id = (select miss from ids) $$,
  $$ values ('meeting', 'Client call ran over') $$, 'stored, note trimmed');
select lives_ok($$ select public.set_miss_reason((select miss from ids), 'phone_call') $$,
  'she can change it (until the week is approved, #252)');
select throws_ok($$ select public.set_miss_reason((select pass from ids), 'other', 'x') $$,
  '22023', 'not_a_miss', 'only misses take a reason');
select throws_ok($$ select public.set_miss_reason((select miss from ids), null, '  ') $$,
  '22023', 'reason_required', 'something must be given');
select throws_ok($$ select public.set_miss_reason((select miss from ids), 'lunch') $$,
  '22023', 'invalid_reason', 'quick picks are a fixed list');

-- Her manager reads it but can't write it; a peer can't touch it.
select pg_temp.act_as(:max);
select is((select missed_reason_kind from public.checkin_events where id = (select miss from ids)),
  'phone_call', 'her manager sees the reason');
select throws_ok($$ select public.set_miss_reason((select miss from ids), 'away') $$,
  '42501', 'checkin_not_found', 'only the employee writes it');

select * from finish();
rollback;
