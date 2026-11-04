-- #322: team_live reads as its owner, filtered once to internal.viewable_user_ids(), and the
-- teams policy asks internal.viewable_team_ids(). Both must give exactly what the per-row
-- checks gave before, for every kind of viewer: the old security_invoker view is rebuilt
-- here (in this transaction only) and compared row by row, and the visible set is compared
-- with can_view_user() person by person.
begin;
create extension if not exists pgtap with schema extensions;

select plan(53);

-- Seed org: Ada owner -> Max manager (America/Chicago) -> Erin, Lucas.
-- Added here: Ann (admin), Mia (Max's active delegate), Nora (her delegation from Max has
-- ended), Pete (his starts next week), Ivan (inactive manager, Max's delegate), Ezra
-- (inactive employee under Max), Gina (in Mia's team) and another org (Olga, Gus, Gail).
\set org '''00000000-0000-4000-8000-000000000001'''
\set org2 '''00000000-0000-4000-8000-000000000002'''
\set ada '''00000000-0000-4000-8000-0000000000a1'''
\set max '''00000000-0000-4000-8000-0000000000b1'''
\set erin '''00000000-0000-4000-8000-0000000000c1'''
\set lucas '''00000000-0000-4000-8000-0000000000c2'''
\set ann '''00000000-0000-4000-8000-0000000000a2'''
\set mia '''00000000-0000-4000-8000-0000000000b2'''
\set nora '''00000000-0000-4000-8000-0000000000b3'''
\set ivan '''00000000-0000-4000-8000-0000000000b4'''
\set pete '''00000000-0000-4000-8000-0000000000b5'''
\set ezra '''00000000-0000-4000-8000-0000000000c3'''
\set gina '''00000000-0000-4000-8000-0000000000c4'''
\set olga '''00000000-0000-4000-8000-0000000000a9'''
\set gus '''00000000-0000-4000-8000-0000000000b9'''
\set gail '''00000000-0000-4000-8000-0000000000c9'''

create function pg_temp.act_as(uid uuid, aal text default 'aal1') returns void
language sql as $$
  select set_config('role', 'postgres', true);
  select set_config('request.jwt.claims',
    (internal.custom_access_token_hook(jsonb_build_object(
      'user_id', uid,
      'claims', jsonb_build_object('sub', uid, 'role', 'authenticated', 'aal', aal)
    )) -> 'claims')::text, true);
  select set_config('role', 'authenticated', true);
$$;

-- What can_view_user() says, for every person in every org (as the owner, so users' own
-- row-level security doesn't hide anyone from the question).
create function pg_temp.can_view_all() returns setof uuid
language sql security definer as $$
  select id from public.users where public.can_view_user(id)
$$;

-- The teams the old policy (20261022100000_teams) let the caller read; users' own policy
-- applied to the members it looked at, hence m.org_id and can_view_user twice over.
create function pg_temp.teams_before() returns setof uuid
language sql security definer as $$
  select t.id from public.teams t
  where t.org_id = internal.jwt_org_id()
    and (
      exists (
        select 1 from public.users me
        where me.id = auth.uid() and me.active and me.role in ('owner', 'admin'))
      or exists (
        select 1 from public.users m
        where m.team_id = t.id
          and m.org_id = internal.jwt_org_id() and public.can_view_user(m.id)
          and public.can_view_user(m.id))
    )
$$;

-- People, teams, delegations ------------------------------------------------------------------

insert into public.orgs (id, name) values (:org2, 'Other Co');
insert into auth.users (id, email) values
  (:ann, 'ann@acme.test'), (:mia, 'mia@acme.test'), (:nora, 'nora@acme.test'),
  (:ivan, 'ivan@acme.test'), (:pete, 'pete@acme.test'), (:ezra, 'ezra@acme.test'),
  (:gina, 'gina@acme.test'), (:olga, 'olga@other.test'), (:gus, 'gus@other.test'),
  (:gail, 'gail@other.test');
insert into public.users (id, org_id, full_name, email, role, manager_id, active) values
  (:olga, :org2, 'Olga Owner', 'olga@other.test', 'owner', null, true),
  (:gus, :org2, 'Gus Manager', 'gus@other.test', 'manager', :olga, true),
  (:gail, :org2, 'Gail Employee', 'gail@other.test', 'employee', :gus, true),
  (:ann, :org, 'Ann Admin', 'ann@acme.test', 'admin', :ada, true),
  (:mia, :org, 'Mia Manager', 'mia@acme.test', 'manager', :ada, true),
  (:nora, :org, 'Nora Manager', 'nora@acme.test', 'manager', :ada, true),
  (:pete, :org, 'Pete Manager', 'pete@acme.test', 'manager', :ada, true),
  (:ivan, :org, 'Ivan Manager', 'ivan@acme.test', 'manager', :ada, false),
  (:ezra, :org, 'Ezra Employee', 'ezra@acme.test', 'employee', :max, false),
  (:gina, :org, 'Gina Employee', 'gina@acme.test', 'employee', :mia, true);
insert into public.presence (user_id, org_id, status)
select id, org_id, 'active' from public.users on conflict (user_id) do nothing;

insert into public.teams (id, org_id, name) values
  ('00000000-0000-4000-8000-0000000000e1', :org, 'Support'),
  ('00000000-0000-4000-8000-0000000000e2', :org, 'Sales'),
  ('00000000-0000-4000-8000-0000000000e3', :org, 'Leads'),
  ('00000000-0000-4000-8000-0000000000e4', :org, 'Empty'),
  ('00000000-0000-4000-8000-0000000000e5', :org, 'Former'),
  ('00000000-0000-4000-8000-0000000000e9', :org2, 'Other support');
update public.users set team_id = '00000000-0000-4000-8000-0000000000e1' where id in (:erin, :gina);
update public.users set team_id = '00000000-0000-4000-8000-0000000000e2' where id = :lucas;
update public.users set team_id = '00000000-0000-4000-8000-0000000000e3' where id in (:max, :mia);
update public.users set team_id = '00000000-0000-4000-8000-0000000000e5' where id = :ezra;
update public.users set team_id = '00000000-0000-4000-8000-0000000000e9' where id = :gail;

-- Delegations are dates in the manager's (Max's) time zone.
insert into public.delegations (org_id, manager_id, delegate_id, starts_on, ends_on, ended_at) values
  (:org, :max, :mia, (now() at time zone 'America/Chicago')::date - 1,
   (now() at time zone 'America/Chicago')::date + 3, null),
  (:org, :max, :nora, (now() at time zone 'America/Chicago')::date - 1,
   (now() at time zone 'America/Chicago')::date + 3, now()),
  (:org, :max, :pete, (now() at time zone 'America/Chicago')::date + 7,
   (now() at time zone 'America/Chicago')::date + 9, null),
  (:org, :max, :ivan, (now() at time zone 'America/Chicago')::date - 1,
   (now() at time zone 'America/Chicago')::date + 3, null);

-- Today's check-ins and shifts, so the joined columns aren't all defaults. One check-in and
-- one shift are filed under the other org: neither read ever counted them.
insert into public.devices (id, org_id, user_id, platform, os_version, agent_version, hardware_hash)
values ('00000000-0000-4000-8000-0000000000d1', :org, :erin, 'macos', '26', '0.1.0', 'hash-erin-322');
insert into public.checkin_events (id, org_id, user_id, device_id, scheduled_at, outcome)
select gen_random_uuid(), o, :erin, '00000000-0000-4000-8000-0000000000d1',
  date_trunc('day', now() at time zone 'America/Los_Angeles') at time zone 'America/Los_Angeles'
    + m * interval '1 minute', x::public.checkin_outcome
from (values (:org::uuid, 1, 'pass'), (:org::uuid, 2, 'miss'), (:org2::uuid, 3, 'pass')) v(o, m, x);
insert into public.shifts (org_id, user_id, days, start_time, end_time, timezone) values
  (:org, :lucas, array[1, 2, 3, 4, 5, 6, 7], '09:00', '17:00', 'America/Los_Angeles'),
  (:org2, :gina, array[1, 2, 3, 4, 5, 6, 7], '09:00', '17:00', 'America/Los_Angeles');

-- The read as it was (20261022100000_teams), with the caller's row-level security.
create view public.team_live_322_before
with (security_invoker = on)
as
select
  u.id as user_id, u.org_id, u.full_name, u.role, u.manager_id, u.timezone,
  p.status, p.since, p.last_checkin_at, p.last_checkin_outcome, p.project_id,
  coalesce(today.shown, 0) as checkins_shown_today,
  coalesce(today.passed, 0) as checkins_passed_today,
  exists (
    select 1 from public.shifts s
    where s.user_id = u.id
      and extract(isodow from now() at time zone s.timezone)::int = any (s.days)
  ) as scheduled_today,
  p.tamper_reason,
  u.team_id
from public.users u
join public.presence p on p.user_id = u.id
left join lateral (
  select
    count(*) filter (where c.outcome <> 'deferred')::int as shown,
    count(*) filter (where c.outcome = 'pass')::int as passed
  from public.checkin_events c
  where c.user_id = u.id
    and c.scheduled_at >= (date_trunc('day', now() at time zone u.timezone) at time zone u.timezone)
) today on true
where u.active;
grant select on public.team_live_322_before to authenticated;

-- The same rows, columns and visible teams as before, per viewer -----------------------------

create function pg_temp.same_as_before(who text) returns setof text
language plpgsql as $$
begin
  return next results_eq(
    'select * from public.team_live order by user_id',
    'select * from public.team_live_322_before order by user_id',
    who || ': team_live gives the same rows as the per-row checks did');
  return next set_eq(
    'select internal.viewable_user_ids()',
    'select pg_temp.can_view_all()',
    who || ': the visible set is exactly who can_view_user allows');
  return next set_eq(
    'select id from public.teams',
    'select pg_temp.teams_before()',
    who || ': the same teams as before');
end;
$$;

select pg_temp.act_as(:ada);
select pg_temp.same_as_before('owner');
select is((select count(*)::int from public.team_live), 9, 'owner: every active person in the org');

select pg_temp.act_as(:ann);
select pg_temp.same_as_before('admin');
select is((select count(*)::int from public.team_live), 9, 'admin: every active person in the org');

select pg_temp.act_as(:max);
select pg_temp.same_as_before('manager');
select is((select array_agg(full_name order by full_name) from public.team_live),
  array['Erin Employee', 'Lucas Martin', 'Max Manager'],
  'manager: their direct reports and themselves, not an inactive report');
select is((select checkins_shown_today from public.team_live where user_id = :erin), 2,
  'manager: a check-in filed under another org is not counted');
select is((select scheduled_today from public.team_live where user_id = :lucas), true,
  'manager: scheduled today from the person''s shift');

select pg_temp.act_as(:mia);
select pg_temp.same_as_before('active delegate');
select is((select array_agg(full_name order by full_name) from public.team_live),
  array['Erin Employee', 'Gina Employee', 'Lucas Martin', 'Mia Manager'],
  'active delegate: their own reports and the delegating manager''s');
select is((select array_agg(name order by name) from public.teams),
  array['Former', 'Leads', 'Sales', 'Support'],
  'active delegate: the teams of the people they see (an inactive report''s too, as before)');
select is((select scheduled_today from public.team_live where user_id = :gina), false,
  'active delegate: a shift filed under another org does not count');

select pg_temp.act_as(:nora);
select pg_temp.same_as_before('ended delegation');
select is((select array_agg(full_name) from public.team_live), array['Nora Manager'],
  'ended delegation: only themselves');

select pg_temp.act_as(:pete);
select pg_temp.same_as_before('future delegation');
select is((select array_agg(full_name) from public.team_live), array['Pete Manager'],
  'future delegation: only themselves');

select pg_temp.act_as(:erin);
select pg_temp.same_as_before('employee');
select is((select array_agg(full_name) from public.team_live), array['Erin Employee'],
  'employee: only their own row');
select is((select array_agg(name) from public.teams), array['Support'], 'employee: only their team');

select pg_temp.act_as(:ivan);
select pg_temp.same_as_before('inactive viewer');
select is_empty('select 1 from public.team_live', 'inactive viewer: nothing');

select pg_temp.act_as(:gus);
select pg_temp.same_as_before('manager in another org');
select is((select array_agg(full_name order by full_name) from public.team_live),
  array['Gail Employee', 'Gus Manager'], 'another org: only its own people');

-- NFR-SEC-05: owners and admins see the org only with an MFA-verified session when the org
-- requires it.
select set_config('role', 'postgres', true);
update public.orgs set policy = policy || '{"require_admin_mfa": true}' where id = :org;

select pg_temp.act_as(:ann, 'aal1');
select pg_temp.same_as_before('admin without MFA, MFA required');
select is((select array_agg(full_name) from public.team_live), array['Ann Admin'],
  'admin without MFA, MFA required: only themselves');

select pg_temp.act_as(:ada, 'aal2');
select pg_temp.same_as_before('owner with MFA, MFA required');
select is((select count(*)::int from public.team_live), 9, 'owner with MFA: every active person');

-- Signed out: nothing, and no rights on the view at all.
select set_config('role', 'anon', true);
select set_config('request.jwt.claims', '', true);
select throws_ok('select 1 from public.team_live', '42501', null, 'anon cannot read the view');

select set_config('role', 'postgres', true);
select set_config('request.jwt.claims', '', true);
select ok(not has_table_privilege('authenticated', 'public.team_live', 'insert, update, delete'),
  'the view is read-only for signed-in callers');
select ok((select reloptions @> array['security_barrier=true'] from pg_class
           where oid = 'public.team_live'::regclass),
  'security_barrier: a caller''s filters run after the visibility filter');
select ok(not has_function_privilege('anon', 'internal.viewable_user_ids()', 'execute'),
  'anon cannot run the visible set');

select * from finish();
rollback;
