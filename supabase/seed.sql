-- Local development seed: one org with an owner/admin, a manager and two employees.
-- Every account signs in with email + password `password123` (local stack only).

insert into public.orgs (id, name, data_region, region_preset)
values ('00000000-0000-4000-8000-000000000001', 'Acme Remote', 'us', 'us');

-- auth.users + auth.identities so email/password sign-in works against local Auth.
with seed_users (id, email, full_name) as (
  values
    ('00000000-0000-4000-8000-0000000000a1'::uuid, 'admin@acme.test', 'Ada Admin'),
    ('00000000-0000-4000-8000-0000000000b1'::uuid, 'manager@acme.test', 'Max Manager'),
    ('00000000-0000-4000-8000-0000000000c1'::uuid, 'erin@acme.test', 'Erin Employee'),
    ('00000000-0000-4000-8000-0000000000c2'::uuid, 'lucas@acme.test', 'Lucas Martin')
),
inserted as (
  insert into auth.users (
    instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
    confirmation_token, email_change, email_change_token_new, recovery_token
  )
  select
    '00000000-0000-0000-0000-000000000000', id, 'authenticated', 'authenticated', email,
    extensions.crypt('password123', extensions.gen_salt('bf')), now(),
    '{"provider": "email", "providers": ["email"]}'::jsonb,
    jsonb_build_object('full_name', full_name), now(), now(),
    '', '', '', ''
  from seed_users
  returning id, email
)
insert into auth.identities (
  id, user_id, provider_id, provider, identity_data, last_sign_in_at, created_at, updated_at
)
select
  gen_random_uuid(), id, id::text, 'email',
  jsonb_build_object('sub', id::text, 'email', email, 'email_verified', true),
  now(), now(), now()
from inserted;

insert into public.users (
  id, org_id, full_name, email, role, manager_id, work_country, work_state, timezone
)
values
  ('00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-000000000001',
   'Ada Admin', 'admin@acme.test', 'owner', null, 'US', 'NY', 'America/New_York'),
  ('00000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-000000000001',
   'Max Manager', 'manager@acme.test', 'manager', '00000000-0000-4000-8000-0000000000a1',
   'US', 'IL', 'America/Chicago'),
  ('00000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-000000000001',
   'Erin Employee', 'erin@acme.test', 'employee', '00000000-0000-4000-8000-0000000000b1',
   'US', 'CA', 'America/Los_Angeles'),
  ('00000000-0000-4000-8000-0000000000c2', '00000000-0000-4000-8000-000000000001',
   'Lucas Martin', 'lucas@acme.test', 'employee', '00000000-0000-4000-8000-0000000000b1',
   'US', 'TX', 'America/Chicago');

-- Weekday 9-to-5 shifts for both employees, plus a night shift crossing midnight.
insert into public.shifts (org_id, user_id, days, start_time, end_time, timezone)
values
  ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000c1',
   '{1,2,3,4,5}', '09:00', '17:00', 'America/Los_Angeles'),
  ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000c2',
   '{1,2,3,4}', '22:00', '06:00', 'America/Chicago');

insert into public.presence (user_id, org_id)
select id, org_id from public.users;

-- A client with a billable project for both employees, and an internal one for Erin.
insert into public.clients (id, org_id, name)
values ('00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-000000000001', 'Northwind');
insert into public.projects (id, org_id, client_id, name, billable)
values
  ('00000000-0000-4000-8000-0000000000f1', '00000000-0000-4000-8000-000000000001',
   '00000000-0000-4000-8000-0000000000e1', 'Website revamp', true),
  ('00000000-0000-4000-8000-0000000000f2', '00000000-0000-4000-8000-000000000001',
   null, 'Internal', false);
insert into public.project_members (project_id, user_id, org_id)
values
  ('00000000-0000-4000-8000-0000000000f1', '00000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-000000000001'),
  ('00000000-0000-4000-8000-0000000000f1', '00000000-0000-4000-8000-0000000000c2', '00000000-0000-4000-8000-000000000001'),
  ('00000000-0000-4000-8000-0000000000f2', '00000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-000000000001');

-- Everyone has acknowledged version 1 of the monitoring notice (the org's template
-- notice is created with the org), so they can clock in. Tests that need someone who
-- hasn't acknowledged create that state themselves.
insert into public.notice_acks (user_id, notice_id)
select u.id, n.id
from public.users u
join public.notices n on n.org_id = u.org_id and n.version = 1;
