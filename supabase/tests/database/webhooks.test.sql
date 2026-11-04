-- #320 (API-06, API-03, AUD-01): webhooks (endpoints, events, the delivery queue, failure,
-- redaction, retention) and time off in the public API.
begin;
create extension if not exists pgtap with schema extensions;

select plan(96);

\set org '''00000000-0000-4000-8000-000000000001'''
\set org2 '''00000000-0000-4000-8000-000000000002'''
\set ada '''00000000-0000-4000-8000-0000000000a1'''
\set max '''00000000-0000-4000-8000-0000000000b1'''
\set erin '''00000000-0000-4000-8000-0000000000c1'''
\set lucas '''00000000-0000-4000-8000-0000000000c2'''
\set olga '''00000000-0000-4000-8000-0000000000a9'''
\set nina '''00000000-0000-4000-8000-0000000000c8'''

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

-- The API's read layer as a person: their claims, run as the role the api-v1 call uses.
create function pg_temp.read_as(uid uuid) returns void
language sql as $$
  select pg_temp.act_as(uid);
  select set_config('role', 'postgres', true);
$$;

-- The local-stack switch, off unless a test turns it on.
create function pg_temp.allow_private(p_on boolean) returns void
language sql as $$
  delete from vault.secrets where name = 'webhooks_allow_private_hosts';
  select vault.create_secret(case when p_on then 'true' else 'false' end, 'webhooks_allow_private_hosts');
$$;

create temp table made (name text primary key, id uuid, secret text) on commit drop;
grant all on made to authenticated, service_role;

select pg_temp.allow_private(false);

-- Tables -------------------------------------------------------------------------------------

select has_table('public', 'webhooks', 'webhooks exists');
select has_table('public', 'webhook_deliveries', 'webhook_deliveries exists');
select ok((select relrowsecurity from pg_class where oid = 'public.webhooks'::regclass),
  'RLS is on for webhooks');
select ok((select relrowsecurity from pg_class where oid = 'public.webhook_deliveries'::regclass),
  'RLS is on for webhook_deliveries');

-- Creating -------------------------------------------------------------------------------------

select pg_temp.act_as(:ada);
insert into made select 'all', id, secret from public.create_webhook('  https://Hooks.Example.com/ai?x=1 ',
  array['timesheet.submitted', 'timesheet.approved', 'timesheet.returned', 'alert.raised',
        'person.invited', 'person.deactivated', 'time_off.decided', 'alert.raised']);
insert into made select 'people', id, secret from public.create_webhook('https://people.example.com/hook',
  array['person.invited']);

select matches((select secret from made where name = 'all'), '^whsec_[A-Za-z0-9_-]{43}$',
  'a signing secret is whsec_ and 43 base64url characters');
select isnt((select secret from made where name = 'all'), (select secret from made where name = 'people'),
  'each endpoint has its own secret');
select results_eq(
  $$ select url, events from public.list_webhooks() where id = (select id from made where name = 'all') $$,
  $$ values ('https://hooks.example.com/ai?x=1'::text,
       array['alert.raised', 'person.deactivated', 'person.invited', 'time_off.decided',
             'timesheet.approved', 'timesheet.returned', 'timesheet.submitted']) $$,
  'the URL is trimmed with its host in lower case; the events are each listed once'
);
select ok(position((select secret from made where name = 'all') in
    (select string_agg(to_jsonb(w)::text, '') from public.list_webhooks() w)) = 0,
  'list_webhooks never returns the secret');
select is((select count(*)::int from public.webhooks), 2, 'an owner reads the org''s endpoints');

select pg_temp.as_postgres();
select is(
  (select s.decrypted_secret from vault.decrypted_secrets s
   where s.name = 'webhook_secret:' || (select id from made where name = 'all')),
  (select secret from made where name = 'all'),
  'the secret is kept in Vault so deliveries can be signed'
);
select is(
  (select metadata from public.audit_log where action = 'webhook.created'
   and metadata ->> 'webhook_id' = (select id::text from made where name = 'people')),
  jsonb_build_object('webhook_id', (select id from made where name = 'people'),
    'host', 'people.example.com', 'events', jsonb_build_array('person.invited')),
  'creating is audit-logged with the host, not the whole URL (AUD-01)'
);

select pg_temp.act_as(:ada);
select throws_ok($$ select * from public.create_webhook('http://hooks.example.com/x', array['person.invited']) $$,
  '22023', 'invalid_url', 'http is refused');
select throws_ok($$ select * from public.create_webhook('https://localhost/x', array['person.invited']) $$,
  '22023', 'invalid_url', 'localhost is refused');
select throws_ok($$ select * from public.create_webhook('https://10.0.0.5/x', array['person.invited']) $$,
  '22023', 'invalid_url', 'a private address is refused');
select throws_ok($$ select * from public.create_webhook('https://169.254.169.254/latest', array['person.invited']) $$,
  '22023', 'invalid_url', 'a link-local address is refused');
select throws_ok($$ select * from public.create_webhook('https://kong:8000/x', array['person.invited']) $$,
  '22023', 'invalid_url', 'a single-label host is refused');
select throws_ok($$ select * from public.create_webhook('https://u:p@hooks.example.com/x', array['person.invited']) $$,
  '22023', 'invalid_url', 'a user name and password in the URL are refused');
select throws_ok($$ select * from public.create_webhook('https://hooks.example.com/y', array['timesheet.deleted']) $$,
  '22023', 'invalid_events', 'an unknown event is refused');
select throws_ok($$ select * from public.create_webhook('https://hooks.example.com/y', '{}') $$,
  '22023', 'invalid_events', 'no events is refused');
select throws_ok($$ select * from public.create_webhook('https://HOOKS.example.com/ai?x=1', array['person.invited']) $$,
  '23505', 'url_taken', 'one endpoint per URL');

select pg_temp.as_postgres();
select pg_temp.allow_private(true);
select pg_temp.act_as(:ada);
insert into made select 'local', id, secret from public.create_webhook('http://rest:3000/rpc/sink',
  array['person.invited']);
select is((select url from public.webhooks where id = (select id from made where name = 'local')),
  'http://rest:3000/rpc/sink', 'with the local-stack switch on, http and private hosts are allowed');
select public.delete_webhook((select id from made where name = 'local'));
select pg_temp.as_postgres();
select pg_temp.allow_private(false);

select pg_temp.act_as(:max);
select throws_ok($$ select * from public.create_webhook('https://m.example.com/x', array['person.invited']) $$,
  '42501', 'admin_only', 'a manager can''t add an endpoint');
select throws_ok($$ select * from public.list_webhooks() $$, '42501', 'admin_only',
  'a manager can''t list endpoints');
select is((select count(*)::int from public.webhooks), 0, 'a manager reads no endpoints through RLS');
select is((select count(*)::int from public.webhook_deliveries), 0, 'nor deliveries');
select throws_ok($$ insert into public.webhooks (org_id, url, events) values
    ('00000000-0000-4000-8000-000000000001', 'https://x.example.com', array['person.invited']) $$,
  '42501', null, 'nobody writes the table directly');

select pg_temp.act_as(:olga);
select is((select count(*)::int from public.webhooks), 0, 'another org''s owner reads none of them');
select throws_ok($$ select public.delete_webhook((select id from made where name = 'all')) $$,
  '42501', 'webhook_not_found', 'nor deletes them');

-- Events ---------------------------------------------------------------------------------------

select pg_temp.as_postgres();
-- A timesheet: draft, then submitted, then approved.
insert into public.timesheets (id, org_id, user_id, period_start, status)
values ('00000000-0000-4000-8000-00000000e301', :org, :erin, date '2026-10-05', 'draft');
select is((select count(*)::int from public.webhook_deliveries), 0, 'a draft week is no event');
update public.timesheets set status = 'submitted', submitted_at = now()
where id = '00000000-0000-4000-8000-00000000e301';
select results_eq(
  $$ select event_type, subject_user_id, payload -> 'data' ->> 'status', payload -> 'data' ->> 'previous_status',
       payload ->> 'type', payload ->> 'api_version', (payload ->> 'id')::uuid = event_id
     from public.webhook_deliveries $$,
  $$ values ('timesheet.submitted'::text, '00000000-0000-4000-8000-0000000000c1'::uuid, 'submitted'::text,
       'draft'::text, 'timesheet.submitted'::text, 'v1'::text, true) $$,
  'submitting queues timesheet.submitted, for the endpoint that wants it only'
);
select ok(
  (select payload -> 'data' ?& array['id', 'user_id', 'period_start', 'period_end', 'worked_s',
     'flagged_s', 'approver_id', 'updated_at'] from public.webhook_deliveries),
  'its data is the API''s Timesheet'
);
update public.timesheets set status = 'approved', approver_id = :max, approved_at = now()
where id = '00000000-0000-4000-8000-00000000e301';
update public.timesheets set approved_at = now() where id = '00000000-0000-4000-8000-00000000e301';
select results_eq(
  $$ select event_type, payload -> 'data' ->> 'approver_id' from public.webhook_deliveries
     where event_type = 'timesheet.approved' $$,
  $$ values ('timesheet.approved'::text, '00000000-0000-4000-8000-0000000000b1'::text) $$,
  'approving queues timesheet.approved once (an update that keeps the status is no event)'
);
select is((select count(distinct event_id)::int from public.webhook_deliveries), 2,
  'every event has its own id');
insert into public.timesheets (id, org_id, user_id, period_start, status)
values ('00000000-0000-4000-8000-00000000e302', :org, :erin, date '2026-10-12', 'submitted');
update public.timesheets set status = 'returned', returned_at = now(), comment = 'Fix Tuesday'
where id = '00000000-0000-4000-8000-00000000e302';
select results_eq(
  $$ select event_type, payload -> 'data' ->> 'previous_status', payload -> 'data' ->> 'return_comment'
     from public.webhook_deliveries where payload -> 'data' ->> 'id' = '00000000-0000-4000-8000-00000000e302'
     order by event_type desc $$,
  $$ values ('timesheet.submitted'::text, null::text, null::text),
            ('timesheet.returned'::text, 'submitted'::text, 'Fix Tuesday'::text) $$,
  'a week created submitted is timesheet.submitted; returning it is timesheet.returned with the comment'
);
-- Out of the way of the delivery checks below.
delete from public.webhook_deliveries where payload -> 'data' ->> 'id' = '00000000-0000-4000-8000-00000000e302';

-- An alert to two recipients is one event, with an id derived from what it is about.
insert into public.alerts (org_id, user_id, recipient_id, kind, episode, details) values
  (:org, :erin, :max, 'offline', 'ep-1', '{"since":"x"}'),
  (:org, :erin, :ada, 'offline', 'ep-1', '{"since":"x"}');
select results_eq(
  $$ select count(*)::int, min(event_id::text)::uuid from public.webhook_deliveries where event_type = 'alert.raised' $$,
  $$ values (1, md5('alert.raised:00000000-0000-4000-8000-0000000000c1:offline:ep-1')::uuid) $$,
  'an alert raised to two recipients is one alert.raised event with a stable id'
);
select ok(
  (select not (payload -> 'data' ? 'recipient_id') and payload -> 'data' ->> 'kind' = 'offline'
   from public.webhook_deliveries where event_type = 'alert.raised'),
  'it says who and what, not who received it'
);

-- People: invited goes to both endpoints that want it; deactivated once; reactivated is none.
insert into auth.users (id, email) values (:nina, 'nina@acme.test');
insert into public.users (id, org_id, full_name, email, role, manager_id)
values (:nina, :org, 'Nina New', 'nina@acme.test', 'employee', :max);
select is((select count(*)::int from public.webhook_deliveries where event_type = 'person.invited'), 2,
  'person.invited goes to both endpoints that want it');
select is((select count(distinct event_id)::int from public.webhook_deliveries where event_type = 'person.invited'), 1,
  'with the same event id');
select is((select payload -> 'data' ->> 'email' from public.webhook_deliveries
  where event_type = 'person.invited' limit 1), 'nina@acme.test', 'its data is the API''s Person');
update public.users set active = false where id = :lucas;
update public.users set active = true where id = :lucas;
update public.users set full_name = 'Lucas M' where id = :lucas;
select results_eq(
  $$ select event_type, payload -> 'data' ->> 'active' from public.webhook_deliveries
     where subject_user_id = '00000000-0000-4000-8000-0000000000c2' $$,
  $$ values ('person.deactivated'::text, 'false'::text) $$,
  'deactivating is person.deactivated; reactivating or renaming is no event'
);

-- Time off: asked (pending) is no event; the manager's decision is.
select pg_temp.act_as(:erin);
select public.request_leave((select id from public.leave_types where org_id = :org and name = 'Vacation'),
  (now() at time zone 'America/Los_Angeles')::date + 20, (now() at time zone 'America/Los_Angeles')::date + 21,
  null, null, 'Family trip, secret plans');
select pg_temp.as_postgres();
select is((select count(*)::int from public.webhook_deliveries where event_type = 'time_off.decided'), 0,
  'a pending request is no event');
select pg_temp.act_as(:max);
select public.decide_leave((select id from public.leave_requests where user_id = :erin), true, 'Enjoy, private words');
select pg_temp.as_postgres();
select results_eq(
  $$ select event_type, payload -> 'data' ->> 'status', payload -> 'data' ->> 'decided_by',
       payload -> 'data' ->> 'type_name', payload -> 'data' ->> 'kind'
     from public.webhook_deliveries where event_type = 'time_off.decided' $$,
  $$ values ('time_off.decided'::text, 'approved'::text, '00000000-0000-4000-8000-0000000000b1'::text,
       'Vacation'::text, 'days'::text) $$,
  'deciding is time_off.decided, with the approver'
);
select ok(
  (select payload::text not like '%secret plans%' and payload::text not like '%private words%'
   from public.webhook_deliveries where event_type = 'time_off.decided'),
  'never the note or the decision note'
);

-- An endpoint that is off gets nothing new.
select pg_temp.act_as(:ada);
select public.update_webhook((select id from made where name = 'people'), 'https://people.example.com/hook',
  array['person.invited'], false);
select pg_temp.as_postgres();
select results_eq(
  $$ select enabled, disabled_reason from public.webhooks where id = (select id from made where name = 'people') $$,
  $$ values (false, 'admin'::text) $$, 'an admin turns an endpoint off'
);
insert into auth.users (id, email) values ('00000000-0000-4000-8000-0000000000c7', 'omar@acme.test');
insert into public.users (id, org_id, full_name, email, role, manager_id)
values ('00000000-0000-4000-8000-0000000000c7', :org, 'Omar Off', 'omar@acme.test', 'employee', :max);
select is((select count(*)::int from public.webhook_deliveries
  where subject_user_id = '00000000-0000-4000-8000-0000000000c7'), 1,
  'an endpoint that is off is not sent new events');
select is(
  (select metadata -> 'changed' from public.audit_log where action = 'webhook.changed'
   and metadata ->> 'webhook_id' = (select id::text from made where name = 'people')),
  '{"enabled": {"from": true, "to": false}}'::jsonb,
  'the change is audit-logged with what changed'
);

-- Delivery: claim and record -------------------------------------------------------------------

select pg_temp.act_as(:ada);
select throws_ok($$ select * from public.webhook_claim(10) $$, '42501', null,
  'a signed-in person can''t claim deliveries');

create temp table claimed (id uuid, url text, secret text, previous_secret text, payload jsonb, event_type text,
  event_id uuid, attempt int, allow_private boolean) on commit drop;
grant all on claimed to service_role;
select pg_temp.as_service();
insert into claimed select * from public.webhook_claim(100);
select is((select count(*)::int from claimed),
  (select count(*)::int from public.webhook_deliveries d join public.webhooks w on w.id = d.webhook_id
   where w.enabled),
  'the deliver function claims every due delivery of enabled endpoints');
select ok((select bool_and(secret = (select secret from made where name = 'all') and attempt = 1
    and not allow_private and url = 'https://hooks.example.com/ai?x=1') from claimed),
  'each with its URL, its secret, the attempt and whether private hosts are allowed');
select is((select count(*)::int from public.webhook_claim(100)), 0, 'a claimed delivery isn''t handed out twice');
select pg_temp.as_postgres();
select ok((select bool_and(attempts = 1 and next_attempt_at between now() + interval '59 seconds'
    and now() + interval '61 seconds') from public.webhook_deliveries where id in (select id from claimed)),
  'claiming counts the attempt and sets the next one a minute later');
select results_eq(
  $$ select internal.webhook_backoff(n) from generate_series(1, 6) n $$,
  $$ values (interval '1 minute'), (interval '4 minutes'), (interval '16 minutes'),
            (interval '64 minutes'), (interval '256 minutes'), (interval '1024 minutes') $$,
  'retries back off: 1, 4, 16, 64, 256, 1024 minutes'
);

select pg_temp.as_service();
select public.webhook_record((select id from claimed where event_type = 'timesheet.submitted'), true, 204, null);
select public.webhook_record((select id from claimed where event_type = 'timesheet.approved'), false, 500, 'HTTP 500');
select pg_temp.as_postgres();
select results_eq(
  $$ select status, response_status, last_error, delivered_at is not null from public.webhook_deliveries
     where event_type in ('timesheet.submitted', 'timesheet.approved') order by event_type desc $$,
  $$ values ('delivered'::text, 204, null::text, true), ('pending'::text, 500, 'HTTP 500'::text, false) $$,
  'a 2xx is delivered; a failure waits for its next attempt'
);

-- The last attempt failing fails the delivery; five in a row turn the endpoint off.
update public.webhooks set failed_in_row = 3 where id = (select id from made where name = 'all');
update public.webhook_deliveries set attempts = 7 where event_type in ('timesheet.approved', 'alert.raised');
select pg_temp.as_service();
select public.webhook_record((select id from claimed where event_type = 'timesheet.approved'), false, 500, 'HTTP 500');
select pg_temp.as_postgres();
select results_eq(
  $$ select status, (select failed_in_row from public.webhooks where id = d.webhook_id),
       (select enabled from public.webhooks where id = d.webhook_id)
     from public.webhook_deliveries d where event_type = 'timesheet.approved' $$,
  $$ values ('failed'::text, 4, true) $$,
  'after the 7th attempt the delivery has failed and counts against the endpoint'
);
select pg_temp.as_service();
select public.webhook_record((select id from claimed where event_type = 'alert.raised'), false, null, 'could not connect');
select pg_temp.as_postgres();
select results_eq(
  $$ select enabled, disabled_reason, failed_in_row from public.webhooks
     where id = (select id from made where name = 'all') $$,
  $$ values (false, 'failing'::text, 5) $$,
  'the 5th failed delivery in a row turns the endpoint off'
);
select is(
  (select array_agg(user_id order by user_id) from public.notifications where kind = 'webhook.disabled'),
  array[:ada]::uuid[],
  'every active owner and admin is notified'
);
select is(
  (select payload ->> 'host' from public.notifications where kind = 'webhook.disabled'),
  'hooks.example.com', 'with the endpoint''s host'
);
select ok(
  (select actor_id is null and metadata ->> 'reason' = 'failing' from public.audit_log
   where action = 'webhook.disabled'),
  'turning it off is audit-logged, by the system'
);
select pg_temp.as_service();
select is((select count(*)::int from public.webhook_claim(100)), 0,
  'an endpoint that is off is not delivered to');
select public.webhook_record((select id from claimed where event_type = 'person.invited' limit 1), true, 200, null);
select pg_temp.as_postgres();
select is((select failed_in_row from public.webhooks where id = (select id from made where name = 'all')), 0,
  'a delivered one resets the count');

-- An attempt whose result never came back fails after the last one.
update public.webhook_deliveries set attempts = 7, next_attempt_at = now() - interval '1 second'
where event_type = 'person.deactivated';
select pg_temp.as_service();
select count(*) from public.webhook_claim(1);
select pg_temp.as_postgres();
select is((select status || ': ' || last_error from public.webhook_deliveries where event_type = 'person.deactivated'),
  'failed: no result recorded', 'a delivery stuck after its last attempt is failed');

-- Turning on, rotating, the log -------------------------------------------------------------------

select pg_temp.act_as(:ada);
select public.update_webhook((select id from made where name = 'all'), 'https://hooks.example.com/ai?x=1',
  array['person.invited', 'time_off.decided'], true);
select results_eq(
  $$ select enabled, disabled_reason, events from public.webhooks where id = (select id from made where name = 'all') $$,
  $$ values (true, null::text, array['person.invited', 'time_off.decided']) $$,
  'an admin turns it back on and changes its events'
);
select throws_ok($$ select public.update_webhook((select id from made where name = 'all'),
    'https://people.example.com/hook', array['person.invited'], true) $$,
  '23505', 'url_taken', 'not to another endpoint''s URL');
insert into made values ('rotated', (select id from made where name = 'all'),
  public.rotate_webhook_secret((select id from made where name = 'all')));
select matches((select secret from made where name = 'rotated'), '^whsec_[A-Za-z0-9_-]{43}$',
  'rotating returns a new secret');
select isnt((select secret from made where name = 'rotated'), (select secret from made where name = 'all'),
  'a different one');
select ok((select secret_rotated_at is not null from public.list_webhooks() where id = (select id from made where name = 'all')),
  'the list says when it was rotated');
select pg_temp.as_postgres();
select is((select s.decrypted_secret from vault.decrypted_secrets s
    where s.name = 'webhook_secret:' || (select id from made where name = 'all')),
  (select secret from made where name = 'rotated'), 'deliveries are signed with the new secret');
select is((select count(*)::int from public.audit_log where action = 'webhook.secret_rotated'
    and metadata ->> 'webhook_id' = (select id::text from made where name = 'all')), 1,
  'rotating is audit-logged');

select pg_temp.act_as(:ada);
select results_eq(
  $$ select event_type, status, attempts, response_status from public.list_webhook_deliveries(
       (select id from made where name = 'all'), 100) where event_type like 'timesheet.%' order by event_type $$,
  $$ values ('timesheet.approved'::text, 'failed'::text, 7, 500), ('timesheet.submitted'::text, 'delivered'::text, 1, 204) $$,
  'the delivery log shows status, attempts and the response code'
);
select ok((select bool_and(next_attempt_at is null) from public.list_webhook_deliveries(null, 100) where status <> 'pending'),
  'and a next attempt only while one is waiting');
select is((select count(*)::int from public.webhook_deliveries), (select count(*)::int from public.list_webhook_deliveries(null, 500)),
  'an owner reads the org''s deliveries');

-- Deleting a person: their data leaves the queue -----------------------------------------------

select pg_temp.as_postgres();
update public.webhook_deliveries set status = 'pending', attempts = 0, next_attempt_at = now()
where subject_user_id = :nina and webhook_id = (select id from made where name = 'all');
update public.webhook_deliveries set status = 'delivered' where subject_user_id = :nina
  and webhook_id = (select id from made where name = 'people');
select internal.delete_user_data(:ada, :nina);
select is((select count(*)::int from public.webhook_deliveries where webhook_id = (select id from made where name = 'people')
    and event_type = 'person.invited' and payload::text like '%' || :nina || '%'), 0,
  'a deleted person''s delivered events leave the log');
select results_eq(
  $$ select payload -> 'data', payload -> 'redacted', subject_user_id from public.webhook_deliveries
     where webhook_id = (select id from made where name = 'all') and event_type = 'person.invited'
       and payload -> 'data' ->> 'id' = '00000000-0000-4000-8000-0000000000c8' $$,
  $$ values (jsonb_build_object('id', '00000000-0000-4000-8000-0000000000c8', 'user_id', '00000000-0000-4000-8000-0000000000c8'),
       'true'::jsonb, null::uuid) $$,
  'a queued one keeps only ids and says it was redacted'
);
select ok((select bool_and(payload::text not like '%Nina%' and payload::text not like '%nina@%')
  from public.webhook_deliveries), 'nothing of theirs is left in any payload');

-- Retention, deleting an endpoint ------------------------------------------------------------------

update public.webhook_deliveries set created_at = now() - interval '31 days' where event_type = 'alert.raised';
select is(internal.webhooks_purge(), 1, 'deliveries older than 30 days are purged');
select is((select count(*)::int from cron.job where jobname in ('webhooks_kick', 'webhooks_purge')), 2,
  'the kick and the purge are scheduled');

select pg_temp.act_as(:ada);
select public.delete_webhook((select id from made where name = 'people'));
select pg_temp.as_postgres();
select is((select count(*)::int from public.webhook_deliveries where webhook_id = (select id from made where name = 'people')), 0,
  'deleting an endpoint deletes its log');
select is((select count(*)::int from vault.secrets where name = 'webhook_secret:' || (select id from made where name = 'people')), 0,
  'and its secret');
insert into public.orgs (id, name) values ('00000000-0000-4000-8000-000000000003', 'Gone Co');
insert into public.webhooks (id, org_id, url, events)
values ('00000000-0000-4000-8000-00000000e3ff', '00000000-0000-4000-8000-000000000003',
  'https://gone.example.com/x', array['person.invited']);
select vault.create_secret('whsec_x', 'webhook_secret:00000000-0000-4000-8000-00000000e3ff');
-- As a cascade from its org would (the org itself can't go while its audit log exists).
delete from public.webhooks where id = '00000000-0000-4000-8000-00000000e3ff';
select is((select count(*)::int from vault.secrets where name = 'webhook_secret:00000000-0000-4000-8000-00000000e3ff'), 0,
  'an endpoint removed any other way takes its secret too');
select is((select metadata ->> 'host' from public.audit_log where action = 'webhook.deleted'
    and metadata ->> 'webhook_id' = (select id::text from made where name = 'people')), 'people.example.com',
  'deleting is audit-logged');

-- Ten endpoints at most.
select pg_temp.act_as(:ada);
select public.create_webhook('https://h' || n || '.example.com/x', array['person.invited']) from generate_series(1, 9) n;
select throws_ok($$ select * from public.create_webhook('https://h99.example.com/x', array['person.invited']) $$,
  '22023', 'too_many_webhooks', 'at most 10 endpoints per org');

-- Time off in the API ----------------------------------------------------------------------------

select pg_temp.as_postgres();
insert into public.holidays (org_id, day, name, country) values
  (:org, date '2026-12-25', 'Christmas', null), (:org, date '2026-07-04', 'Independence Day', 'US');
select ok('timeoff:read' = any (internal.api_scopes()), 'timeoff:read is a scope');
select is(internal.api_operation_scope('time_off.list'), 'timeoff:read', 'time_off.list needs it');
select is(internal.api_operation_scope('holidays.list'), 'timeoff:read', 'holidays.list too');

select pg_temp.read_as(:ada);
select results_eq(
  $$ select r ->> 'user_id', r ->> 'status', r ->> 'decided_by', (r ? 'note') or (r ? 'decision_note')
     from jsonb_array_elements(internal.api_dispatch('time_off.list', '{}') -> 'data') r $$,
  $$ values ('00000000-0000-4000-8000-0000000000c1'::text, 'approved'::text,
       '00000000-0000-4000-8000-0000000000b1'::text, false) $$,
  'GET /v1/time-off lists requests with the approver and no notes'
);
select is(jsonb_array_length(internal.api_dispatch('time_off.list', '{"status":"pending"}') -> 'data'), 0,
  'filtered by status');
select is(jsonb_array_length(internal.api_dispatch('time_off.list', '{"to":"2026-01-01"}') -> 'data'), 0,
  'and by days');
select throws_ok($$ select internal.api_dispatch('time_off.list', '{"status":"maybe"}') $$, '22023', 'invalid_param',
  'a bad status is refused');
select results_eq(
  $$ select r ->> 'name', r ->> 'country' from jsonb_array_elements(
       internal.api_dispatch('holidays.list', '{"from":"2026-12-01"}') -> 'data') r $$,
  $$ values ('Christmas'::text, null::text) $$,
  'GET /v1/holidays lists the calendar, filtered by day'
);
select is(jsonb_array_length(internal.api_dispatch('holidays.list', '{"limit":"1"}') -> 'data'), 1, 'paged');

select pg_temp.read_as(:erin);
select is(jsonb_array_length(internal.api_dispatch('time_off.list', '{}') -> 'data'), 1,
  'an employee sees her own requests');
select pg_temp.read_as(:olga);
select is(jsonb_array_length(internal.api_dispatch('time_off.list', '{}') -> 'data'), 0,
  'another org sees none');
select is(jsonb_array_length(internal.api_dispatch('holidays.list', '{}') -> 'data'), 0,
  'nor its holidays');

-- updated_at for syncing.
select pg_temp.as_postgres();
alter table public.leave_requests disable trigger leave_requests_touch_updated_at;
update public.leave_requests set updated_at = now() - interval '1 day' where user_id = :erin;
alter table public.leave_requests enable trigger leave_requests_touch_updated_at;
update public.leave_requests set status = 'cancelled', cancelled_at = now() where user_id = :erin;
select is((select updated_at from public.leave_requests where user_id = :erin), now(),
  'a changed request has a new updated_at');

-- A key with the scope reads time off through the API; one without is refused.
select pg_temp.act_as(:ada);
insert into made select 'key-timeoff', id, key from public.create_api_key('Time off sync', array['timeoff:read']);
insert into made select 'key-people', id, key from public.create_api_key('People only', array['people:read']);
select pg_temp.as_service();
select is((public.api_v1_call((select id from made where name = 'key-timeoff'), 'holidays.list', '{}') ->> 'status')::int,
  200, 'a key with timeoff:read lists holidays');
select is(public.api_v1_call((select id from made where name = 'key-people'), 'time_off.list', '{}') -> 'body' -> 'error' ->> 'code',
  'insufficient_scope', 'a key without it is refused');

select * from finish();
rollback;
