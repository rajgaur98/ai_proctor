-- #335 (API-06, AUD-01): webhook test events, redelivery, and the rotation grace period.
begin;
create extension if not exists pgtap with schema extensions;

select plan(57);

\set org2 '''00000000-0000-4000-8000-000000000002'''
\set ada '''00000000-0000-4000-8000-0000000000a1'''
\set max '''00000000-0000-4000-8000-0000000000b1'''
\set olga '''00000000-0000-4000-8000-0000000000a9'''

insert into public.orgs (id, name) values (:org2, 'Other Co');
insert into auth.users (id, email) values (:olga, 'olga@other.test');
insert into public.users (id, org_id, full_name, email, role, manager_id) values
  (:olga, :org2, 'Olga Owner', 'olga@other.test', 'owner', null);

create function pg_temp.act_as(uid uuid) returns void
language sql as $$
  select set_config('role', 'postgres', true);
  select set_config('request.jwt.claims',
    (internal.custom_access_token_hook(jsonb_build_object(
      'user_id', uid, 'claims', jsonb_build_object('sub', uid, 'role', 'authenticated')
    )) -> 'claims')::text, true);
  select set_config('role', 'authenticated', true);
$$;

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

delete from vault.secrets where name = 'webhooks_allow_private_hosts';
select vault.create_secret('false', 'webhooks_allow_private_hosts');

create temp table made (name text primary key, id uuid, secret text) on commit drop;
grant all on made to authenticated, service_role;

-- Columns -------------------------------------------------------------------------------------

select has_column('public', 'webhooks', 'previous_secret_expires_at',
  'webhooks has previous_secret_expires_at');
select has_column('public', 'webhook_deliveries', 'redelivery_of',
  'webhook_deliveries has redelivery_of');

select pg_temp.act_as(:ada);
insert into made select 'hook', id, secret from public.create_webhook('https://grace.example.com/hook',
  array['person.invited', 'time_off.decided']);
insert into made select 'other', id, secret from public.create_webhook('https://other.example.com/hook',
  array['person.invited']);

-- Test event ------------------------------------------------------------------------------------

insert into made values ('ping', public.send_test_webhook((select id from made where name = 'hook')), null);
select pg_temp.as_postgres();
select is(
  (select jsonb_build_object('type', d.event_type, 'status', d.status, 'attempts', d.attempts,
     'subject', d.subject_user_id, 'redelivery_of', d.redelivery_of)
   from public.webhook_deliveries d where d.id = (select id from made where name = 'ping')),
  jsonb_build_object('type', 'ping', 'status', 'pending', 'attempts', 0, 'subject', null,
    'redelivery_of', null),
  'a test event is a ping queued for the endpoint'
);
select is(
  (select d.payload - 'created_at' from public.webhook_deliveries d
   where d.id = (select id from made where name = 'ping')),
  jsonb_build_object('id', (select event_id from public.webhook_deliveries
      where id = (select id from made where name = 'ping')),
    'type', 'ping', 'api_version', 'v1',
    'data', jsonb_build_object('webhook_id', (select id from made where name = 'hook'))),
  'its body has the event shape, with the endpoint''s id as data'
);
select is(
  (select count(*)::int from public.webhook_deliveries
   where webhook_id = (select id from made where name = 'other')),
  0, 'only that endpoint gets it'
);
select is(
  (select jsonb_build_object('actor', actor_id, 'host', metadata ->> 'host',
     'delivery', metadata ->> 'delivery_id', 'webhook', metadata ->> 'webhook_id')
   from public.audit_log where action = 'webhook.test_sent'
     and metadata ->> 'delivery_id' = (select id::text from made where name = 'ping')),
  jsonb_build_object('actor', :ada, 'host', 'grace.example.com',
    'delivery', (select id from made where name = 'ping'),
    'webhook', (select id from made where name = 'hook')),
  'a test event is audit-logged with the host, never the URL'
);

select pg_temp.act_as(:max);
select throws_ok($$ select public.send_test_webhook((select id from made where name = 'hook')) $$,
  '42501', null, 'a manager can''t send a test event');
select pg_temp.act_as(:olga);
select throws_ok($$ select public.send_test_webhook((select id from made where name = 'hook')) $$,
  '42501', 'webhook_not_found', 'nor another org''s owner');
select pg_temp.as_postgres();
select ok(not has_function_privilege('anon', 'public.send_test_webhook(uuid)', 'execute'),
  'anon can''t call send_test_webhook');
select ok(not has_function_privilege('anon', 'public.redeliver_webhook(uuid)', 'execute'),
  'anon can''t call redeliver_webhook');

-- Ten an hour per endpoint.
select pg_temp.act_as(:ada);
select public.send_test_webhook((select id from made where name = 'hook')) from generate_series(1, 9);
select throws_ok($$ select public.send_test_webhook((select id from made where name = 'hook')) $$,
  '22023', 'too_many_tests', 'at most 10 test events an hour per endpoint');
select lives_ok($$ select public.send_test_webhook((select id from made where name = 'other')) $$,
  'another endpoint has its own 10');

-- Off: none.
select public.update_webhook((select id from made where name = 'other'), 'https://other.example.com/hook',
  array['person.invited'], false);
select throws_ok($$ select public.send_test_webhook((select id from made where name = 'other')) $$,
  '22023', 'webhook_off', 'no test event while the endpoint is off');

-- Redeliver -------------------------------------------------------------------------------------

select pg_temp.as_postgres();
select internal.webhook_emit((select org_id from public.webhooks where id = (select id from made where name = 'hook')),
  'person.invited', '00000000-0000-4000-8000-0000000e0001', :max, '{"id": "x"}');
select internal.webhook_emit((select org_id from public.webhooks where id = (select id from made where name = 'hook')),
  'person.invited', '00000000-0000-4000-8000-0000000e0001', :max, '{"id": "x"}');
select is((select count(*)::int from public.webhook_deliveries
    where event_id = '00000000-0000-4000-8000-0000000e0001'),
  1, 'an event emitted twice is still queued once per endpoint');
insert into made select 'orig', id, null from public.webhook_deliveries
  where event_id = '00000000-0000-4000-8000-0000000e0001';

select pg_temp.act_as(:ada);
select throws_ok($$ select public.redeliver_webhook((select id from made where name = 'orig')) $$,
  '22023', 'delivery_pending', 'a delivery still waiting isn''t redelivered');

select pg_temp.as_postgres();
update public.webhook_deliveries set status = 'delivered', attempts = 1, delivered_at = now(),
  response_status = 200 where id = (select id from made where name = 'orig');

select pg_temp.act_as(:ada);
insert into made values ('again', public.redeliver_webhook((select id from made where name = 'orig')), null);
select pg_temp.as_postgres();
select isnt((select id from made where name = 'again'), (select id from made where name = 'orig'),
  'a redelivery is a new delivery');
select is(
  (select jsonb_build_object('event', n.event_id = o.event_id, 'type', n.event_type = o.event_type,
     'payload', n.payload = o.payload, 'subject', n.subject_user_id = o.subject_user_id,
     'webhook', n.webhook_id = o.webhook_id, 'of', n.redelivery_of = o.id,
     'status', n.status, 'attempts', n.attempts)
   from public.webhook_deliveries n, public.webhook_deliveries o
   where n.id = (select id from made where name = 'again') and o.id = (select id from made where name = 'orig')),
  jsonb_build_object('event', true, 'type', true, 'payload', true, 'subject', true, 'webhook', true,
    'of', true, 'status', 'pending', 'attempts', 0),
  'of the same event (id, type, body, person), to the same endpoint, linked to the original'
);
select is((select status from public.webhook_deliveries where id = (select id from made where name = 'orig')),
  'delivered', 'the original is unchanged');
select is(
  (select jsonb_build_object('actor', actor_id, 'host', metadata ->> 'host',
     'of', metadata ->> 'redelivery_of', 'event', metadata ->> 'event_id',
     'type', metadata ->> 'event_type')
   from public.audit_log where action = 'webhook.redelivered'
     and metadata ->> 'delivery_id' = (select id::text from made where name = 'again')),
  jsonb_build_object('actor', :ada, 'host', 'grace.example.com',
    'of', (select id from made where name = 'orig'), 'event', '00000000-0000-4000-8000-0000000e0001',
    'type', 'person.invited'),
  'a redelivery is audit-logged'
);

select pg_temp.act_as(:ada);
select throws_ok($$ select public.redeliver_webhook((select id from made where name = 'orig')) $$,
  '22023', 'delivery_pending', 'not again while a copy of the event still waits');
select is(
  (select redelivery_of from public.list_webhook_deliveries((select id from made where name = 'hook'))
   where id = (select id from made where name = 'again')),
  (select id from made where name = 'orig'), 'the log says what a redelivery repeats');
select is(
  (select redelivery_of from public.list_webhook_deliveries((select id from made where name = 'hook'))
   where id = (select id from made where name = 'orig')),
  null, 'and nothing for an original');

select pg_temp.as_postgres();
update public.webhook_deliveries set status = 'failed', attempts = 7
  where id = (select id from made where name = 'again');
select pg_temp.act_as(:ada);
insert into made values ('again2', public.redeliver_webhook((select id from made where name = 'again')), null);
select pg_temp.as_postgres();
select is((select count(*)::int from public.webhook_deliveries
    where event_id = '00000000-0000-4000-8000-0000000e0001'),
  3, 'a failed redelivery can be redelivered too: one event, three deliveries');
select is((select redelivery_of from public.webhook_deliveries where id = (select id from made where name = 'again2')),
  (select id from made where name = 'again'), 'each linked to the one it repeats');
select internal.webhook_emit((select org_id from public.webhooks where id = (select id from made where name = 'hook')),
  'person.invited', '00000000-0000-4000-8000-0000000e0001', :max, '{"id": "x"}');
select is((select count(*)::int from public.webhook_deliveries
    where event_id = '00000000-0000-4000-8000-0000000e0001'),
  3, 'and the event emitted again still isn''t queued a second time');

select pg_temp.act_as(:max);
select throws_ok($$ select public.redeliver_webhook((select id from made where name = 'orig')) $$,
  '42501', null, 'a manager can''t redeliver');
select pg_temp.act_as(:olga);
select throws_ok($$ select public.redeliver_webhook((select id from made where name = 'orig')) $$,
  '42501', 'delivery_not_found', 'nor another org''s owner');

-- Off: none.
select pg_temp.as_postgres();
insert into made select 'other_d', id, null from public.webhook_deliveries
  where webhook_id = (select id from made where name = 'other') limit 1;
update public.webhook_deliveries set status = 'failed' where id = (select id from made where name = 'other_d');
select pg_temp.act_as(:ada);
select throws_ok($$ select public.redeliver_webhook((select id from made where name = 'other_d')) $$,
  '22023', 'webhook_off', 'no redelivery while the endpoint is off');

-- Rotation grace period ------------------------------------------------------------------------

select pg_temp.as_postgres();
select is((select previous_secret_expires_at from public.webhooks where id = (select id from made where name = 'hook')),
  null, 'no previous secret before a rotation');

select pg_temp.act_as(:ada);
insert into made values ('rot1', null, public.rotate_webhook_secret((select id from made where name = 'hook')));
select pg_temp.as_postgres();
select is((select s.decrypted_secret from vault.decrypted_secrets s
    where s.name = 'webhook_secret:' || (select id from made where name = 'hook')),
  (select secret from made where name = 'rot1'), 'the new secret signs');
select is((select s.decrypted_secret from vault.decrypted_secrets s
    where s.name = 'webhook_secret_prev:' || (select id from made where name = 'hook')),
  (select secret from made where name = 'hook'), 'the replaced one is kept in Vault');
select is((select previous_secret_expires_at from public.webhooks where id = (select id from made where name = 'hook')),
  now() + interval '24 hours', 'for 24 hours');
select is(
  (select (metadata ->> 'previous_valid_until')::timestamptz from public.audit_log
   where action = 'webhook.secret_rotated' and metadata ->> 'webhook_id' = (select id::text from made where name = 'hook')),
  now() + interval '24 hours', 'the rotation''s audit row says until when');

select pg_temp.act_as(:ada);
select is((select previous_secret_expires_at from public.list_webhooks() where id = (select id from made where name = 'hook')),
  now() + interval '24 hours', 'the list shows the grace period');
select ok(position((select secret from made where name = 'hook') in
    (select string_agg(w::text, ',') from public.list_webhooks() w)) = 0
  and position((select secret from made where name = 'rot1') in
    (select string_agg(w::text, ',') from public.list_webhooks() w)) = 0,
  'and neither secret');

create temp table claimed (id uuid, url text, secret text, previous_secret text, payload jsonb,
  event_type text, event_id uuid, attempt int, allow_private boolean) on commit drop;
grant all on claimed to service_role;
select pg_temp.as_service();
insert into claimed select * from public.webhook_claim(100);
select ok((select count(*) > 0 from claimed where url = 'https://grace.example.com/hook'),
  'the endpoint has deliveries to claim');
select ok((select bool_and(secret = (select secret from made where name = 'rot1')
      and previous_secret = (select secret from made where name = 'hook'))
    from claimed where url = 'https://grace.example.com/hook'),
  'deliveries are handed out with the new secret and the previous one');
select pg_temp.as_postgres();
select is((select count(*)::int from claimed where url <> 'https://grace.example.com/hook'
    and previous_secret is not null), 0, 'only for the endpoint that was rotated');

-- Rotating again within the 24 hours: the secret just retired becomes the previous one.
select pg_temp.as_postgres();
update public.webhooks set previous_secret_expires_at = now() + interval '3 hours'
  where id = (select id from made where name = 'hook');
select pg_temp.act_as(:ada);
insert into made values ('rot2', null, public.rotate_webhook_secret((select id from made where name = 'hook')));
select pg_temp.as_postgres();
select is((select s.decrypted_secret from vault.decrypted_secrets s
    where s.name = 'webhook_secret_prev:' || (select id from made where name = 'hook')),
  (select secret from made where name = 'rot1'), 'rotating again keeps the secret it replaces');
select is((select count(*)::int from vault.secrets
    where name = 'webhook_secret_prev:' || (select id from made where name = 'hook')),
  1, 'only one previous secret');
select is((select previous_secret_expires_at from public.webhooks where id = (select id from made where name = 'hook')),
  now() + interval '24 hours', 'for a fresh 24 hours');

-- The 24 hours are up: no longer handed out, then removed.
update public.webhooks set previous_secret_expires_at = now() - interval '1 second'
  where id = (select id from made where name = 'hook');
update public.webhook_deliveries set next_attempt_at = now() - interval '1 second'
  where webhook_id = (select id from made where name = 'hook') and status = 'pending';
truncate claimed;
select pg_temp.as_service();
insert into claimed select * from public.webhook_claim(100);
select pg_temp.as_postgres();
select ok((select bool_and(previous_secret is null and secret = (select secret from made where name = 'rot2'))
    from claimed where url = 'https://grace.example.com/hook'),
  'after the grace period only the new secret is handed out, before the cleanup runs');
select pg_temp.act_as(:ada);
select is((select previous_secret_expires_at from public.list_webhooks() where id = (select id from made where name = 'hook')),
  null, 'and the list shows none');
select pg_temp.as_postgres();
-- An earlier updated_at, set past the touch trigger, so a bump would show.
alter table public.webhooks disable trigger webhooks_touch_updated_at;
update public.webhooks set updated_at = '2026-01-01T00:00:00Z' where id = (select id from made where name = 'hook');
alter table public.webhooks enable trigger webhooks_touch_updated_at;
select is(internal.webhooks_end_grace(), 1, 'the cleanup removes one previous secret');
select is((select count(*)::int from vault.secrets
    where name = 'webhook_secret_prev:' || (select id from made where name = 'hook')),
  0, 'it leaves Vault');
select is((select previous_secret_expires_at from public.webhooks where id = (select id from made where name = 'hook')),
  null, 'and the endpoint has no grace period');
select is((select updated_at from public.webhooks where id = (select id from made where name = 'hook')),
  '2026-01-01T00:00:00Z'::timestamptz, 'ending it doesn''t count as a change to the endpoint');
select is(internal.webhooks_end_grace(), 0, 'nothing more to remove');
select is((select s.decrypted_secret from vault.decrypted_secrets s
    where s.name = 'webhook_secret:' || (select id from made where name = 'hook')),
  (select secret from made where name = 'rot2'), 'the current secret stays');
select is((select schedule from cron.job where jobname = 'webhooks_end_grace'), '* * * * *',
  'the cleanup runs every minute');
select ok(not has_function_privilege('authenticated', 'internal.webhooks_end_grace()', 'execute'),
  'signed-in people can''t run the cleanup');

-- A rotation inside the grace period while the endpoint is deleted: both secrets go.
select pg_temp.act_as(:ada);
select public.rotate_webhook_secret((select id from made where name = 'hook'));
select pg_temp.as_postgres();
select is((select count(*)::int from vault.secrets
    where name in ('webhook_secret:' || (select id from made where name = 'hook'),
                   'webhook_secret_prev:' || (select id from made where name = 'hook'))),
  2, 'during a grace period both secrets are in Vault');
select pg_temp.act_as(:ada);
select public.delete_webhook((select id from made where name = 'hook'));
select pg_temp.as_postgres();
select is((select count(*)::int from vault.secrets
    where name in ('webhook_secret:' || (select id from made where name = 'hook'),
                   'webhook_secret_prev:' || (select id from made where name = 'hook'))),
  0, 'deleting the endpoint removes both');
select is((select count(*)::int from public.webhook_deliveries
    where event_id = '00000000-0000-4000-8000-0000000e0001'),
  0, 'and its deliveries, redeliveries included');

-- A rotation with no current secret in Vault (never normally): no previous one is invented.
select pg_temp.as_postgres();
delete from vault.secrets where name = 'webhook_secret:' || (select id from made where name = 'other');
select pg_temp.act_as(:ada);
insert into made values ('rot_other', null, public.rotate_webhook_secret((select id from made where name = 'other')));
select pg_temp.as_postgres();
select is((select previous_secret_expires_at from public.webhooks where id = (select id from made where name = 'other')),
  null, 'a rotation with no secret to replace has no grace period');
select is((select s.decrypted_secret from vault.decrypted_secrets s
    where s.name = 'webhook_secret:' || (select id from made where name = 'other')),
  (select secret from made where name = 'rot_other'), 'and signs with the new secret');
select is((select count(*)::int from vault.secrets
    where name = 'webhook_secret_prev:' || (select id from made where name = 'other')),
  0, 'with no previous secret');

select * from finish();
rollback;
