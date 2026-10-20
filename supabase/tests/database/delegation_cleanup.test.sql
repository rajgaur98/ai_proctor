begin;
create extension if not exists pgtap with schema extensions;

select plan(67);

-- #147: delegations end when their manager or delegate is deactivated or made an employee;
-- admins set and end on a manager's behalf; the history.
-- Seed org: Ada owner -> Max manager (America/Chicago) -> Erin, Lucas.
-- Added here (all America/Chicago): Ann (admin), Mia and Nora (managers under Ada), Gus
-- (a manager of another org) and Olga's org.
\set ada '''00000000-0000-4000-8000-0000000000a1'''
\set max '''00000000-0000-4000-8000-0000000000b1'''
\set erin '''00000000-0000-4000-8000-0000000000c1'''
\set lucas '''00000000-0000-4000-8000-0000000000c2'''
\set ann '''00000000-0000-4000-8000-0000000000a2'''
\set mia '''00000000-0000-4000-8000-0000000000b2'''
\set nora '''00000000-0000-4000-8000-0000000000b3'''
\set gus '''00000000-0000-4000-8000-0000000000b9'''
\set olga '''00000000-0000-4000-8000-0000000000a9'''
\set org '''00000000-0000-4000-8000-000000000001'''
\set org2 '''00000000-0000-4000-8000-000000000002'''

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

-- Max's local today: delegation ranges are dates in the manager's time zone.
create function pg_temp.mt() returns date
language sql as $$ select (now() at time zone 'America/Chicago')::date $$;

create function pg_temp.audited(act text, who uuid) returns int
language sql security definer as $$
  select count(*)::int from public.audit_log where action = act and target_user_id = who
$$;
create function pg_temp.notified(uid uuid, k text) returns int
language sql security definer as $$
  select count(*)::int from public.notifications where user_id = uid and kind = k
$$;
-- The notification of a kind to a person about someone (by the name in its payload).
create function pg_temp.last_note(uid uuid, k text, who text) returns jsonb
language sql security definer as $$
  select payload from public.notifications where user_id = uid and kind = k and payload ->> 'name' = who
$$;
-- A delegation's end: ended?, reason.
create function pg_temp.ended(did uuid) returns text
language sql security definer as $$
  select (ended_at is not null, end_reason)::text from public.delegations where id = did
$$;

insert into public.orgs (id, name) values (:org2, 'Other Co');
insert into auth.users (id, email) values
  (:ann, 'ann@acme.test'), (:mia, 'mia@acme.test'), (:nora, 'nora@acme.test'),
  (:gus, 'gus@other.test'), (:olga, 'olga@other.test');
insert into public.users (id, org_id, full_name, email, role, manager_id, active, timezone) values
  (:olga, :org2, 'Olga Owner', 'olga@other.test', 'owner', null, true, 'America/Chicago'),
  (:gus, :org2, 'Gus Manager', 'gus@other.test', 'manager', :olga, true, 'America/Chicago'),
  (:ann, :org, 'Ann Admin', 'ann@acme.test', 'admin', :ada, true, 'America/Chicago'),
  (:mia, :org, 'Mia Manager', 'mia@acme.test', 'manager', :ada, true, 'America/Chicago'),
  (:nora, :org, 'Nora Manager', 'nora@acme.test', 'manager', :ada, true, 'America/Chicago');
insert into public.presence (user_id, org_id)
select id, org_id from public.users on conflict (user_id) do nothing;

-- An admin sets and ends a delegation for a manager ----------------------------------------------

select pg_temp.act_as(:ann);
select is((select array_agg(full_name order by full_name) from public.delegate_candidates(:max)),
  array['Ada Admin', 'Ann Admin', 'Mia Manager', 'Nora Manager'],
  'candidates for a manager: an admin sees everyone but that manager');
select is((select array_agg(full_name order by full_name) from public.delegate_candidates()),
  array['Ada Admin', 'Max Manager', 'Mia Manager', 'Nora Manager'],
  'candidates for yourself: unchanged');
select pg_temp.act_as(:max);
select is((select array_agg(full_name order by full_name) from public.delegate_candidates(:max)),
  array['Ada Admin', 'Ann Admin', 'Mia Manager', 'Nora Manager'], 'candidates: a manager for themselves');
select is((select count(*)::int from public.delegate_candidates(:mia)), 0,
  'candidates: a manager gets nothing for someone else');
select pg_temp.act_as(:lucas);
select is((select count(*)::int from public.delegate_candidates(:max)), 0, 'candidates: nothing for an employee');

select pg_temp.act_as(:ann);
create temp table h1 as select public.set_delegation(:nora, pg_temp.mt(), pg_temp.mt() + 2, :max) as id;
grant select on h1 to authenticated;
select ok((select id from h1) is not null, 'an admin sets a delegation for Max');
select is((select (status, ended_at is null, end_reason is null)::text from public.delegation_history(:max)),
  '(active,t,t)', 'history: it is active');
select lives_ok(format($$ select public.end_delegation(%L) $$, (select id from h1)), 'the admin ends it for Max');
select is((select (status, ended_at is not null, end_reason)::text from public.delegation_history(:max)),
  '(ended,t,manual)', 'history: ended early, by hand');
select pg_temp.act_as_postgres();
select is(pg_temp.audited('delegation.ended', :max), 1, 'audit: the end is logged against Max');
select is((select metadata ? 'reason' from public.audit_log where action = 'delegation.ended' and target_user_id = :max::uuid),
  false, 'audit: a manual end carries no clean-up reason');

-- The other delegations -----------------------------------------------------------------------

select pg_temp.act_as(:max);
create temp table d1 as select public.set_delegation(:mia, pg_temp.mt(), pg_temp.mt() + 3) as id;
grant select on d1 to authenticated;
select pg_temp.act_as(:nora);
create temp table d2 as select public.set_delegation(:max, pg_temp.mt() + 5, pg_temp.mt() + 7) as id;
grant select on d2 to authenticated;
select pg_temp.act_as(:mia);
create temp table d3 as select public.set_delegation(:nora, pg_temp.mt(), pg_temp.mt() + 2) as id;
create temp table d0 as select public.set_delegation(:ann, pg_temp.mt() + 10, pg_temp.mt() + 12) as id;
grant select on d3, d0 to authenticated;
select lives_ok(format($$ select public.end_delegation(%L) $$, (select id from d0)), 'Mia cancels one by hand');
select pg_temp.act_as_postgres();
-- A completed one: it ran its course, nobody ended it.
insert into public.delegations (org_id, manager_id, delegate_id, starts_on, ends_on, created_by)
values (:org, :max, :nora, pg_temp.mt() - 20, pg_temp.mt() - 10, :max);
select is(pg_temp.audited('delegation.ended', :mia), 1, 'audit: only the manual end so far');

-- Deactivating a delegate (and a manager) -------------------------------------------------------

select pg_temp.act_as(:lucas);
select throws_ok(format($$ select public.set_user_active(%L, false) $$, :mia::uuid),
  '42501', 'admin_only', 'deactivate: not by an employee');

select pg_temp.act_as(:ada);
select lives_ok(format($$ select public.set_user_active(%L, false) $$, :mia::uuid), 'Ada deactivates Mia');
select pg_temp.act_as_postgres();
select is(pg_temp.ended((select id from d1)), '(t,deactivated)', 'deactivated delegate: Max''s delegation to her ends');
select is(pg_temp.ended((select id from d3)), '(t,deactivated)', 'deactivated manager: her delegation to Nora ends');
select is(pg_temp.ended((select id from d2)), '(f,)', 'unrelated: Nora''s delegation to Max is untouched');
select is(pg_temp.ended((select id from d0)), '(t,manual)', 'already ended by hand: left as it was');
select is(
  (select (ended_at is null, end_reason is null)::text from public.delegations
   where manager_id = :max::uuid and delegate_id = :nora::uuid and ends_on < pg_temp.mt()),
  '(t,t)', 'completed: left alone');
select is(pg_temp.audited('delegation.ended', :max), 2, 'audit: the end of Max''s delegation is logged against the manager');
select is(pg_temp.audited('delegation.ended', :mia), 2, 'audit: and Mia''s own (the manual end and this one)');
select is(
  (select (actor_id = :ada::uuid, metadata ->> 'reason', metadata ->> 'delegate_id' = :nora::text)::text
   from public.audit_log where action = 'delegation.ended' and target_user_id = :mia::uuid
   order by id desc limit 1),
  '(t,deactivated,t)', 'audit: by the admin, with the reason and the delegate');
select is(
  (select metadata ->> 'reason' from public.audit_log
   where action = 'delegation.ended' and target_user_id = :max::uuid order by id desc limit 1),
  'deactivated', 'audit: the reason for Max''s side too');
select is(pg_temp.audited('member.deactivated', :mia), 1, 'audit: next to the deactivation');
select is(pg_temp.notified(:max, 'delegation.ended'), 1, 'notify: Max is told his delegate is gone');
select is(
  (select (p ->> 'for', p ->> 'reason', p ->> 'name', p ->> 'manager_id' = :max::text,
           p ->> 'delegate_id' = :mia::text)::text
   from (select pg_temp.last_note(:max, 'delegation.ended', 'Mia Manager') as p) n),
  '(manager,deactivated,"Mia Manager",t,t)', 'notify: the manager''s note names the delegate and the reason');
select is(pg_temp.notified(:nora, 'delegation.ended'), 2, 'notify: Nora is told her delegate manager is gone (and of Max''s earlier end)');
select is(
  (select (p ->> 'for', p ->> 'reason', p ->> 'name')::text
   from (select pg_temp.last_note(:nora, 'delegation.ended', 'Mia Manager') as p) n),
  '(delegate,deactivated,"Mia Manager")', 'notify: the delegate''s note names the manager and the reason');
select is(pg_temp.notified(:mia, 'delegation.ended'), 0, 'notify: the deactivated person is not');

select pg_temp.act_as(:max);
select is(public.can_view_user(:erin), true, 'Max still manages Erin');
select pg_temp.act_as(:ada);
select lives_ok(format($$ select public.set_user_active(%L, true) $$, :mia::uuid), 'Ada reactivates Mia');
select pg_temp.act_as_postgres();
select is(pg_temp.ended((select id from d1)), '(t,deactivated)', 'reactivating does not bring the delegation back');
select is(pg_temp.audited('delegation.ended', :max), 2, 'audit: nothing more is logged');

-- Deactivating someone with no live delegation ends nothing.
select pg_temp.act_as(:ada);
select lives_ok(format($$ select public.set_user_active(%L, false) $$, :lucas::uuid), 'Ada deactivates Lucas');
select pg_temp.act_as_postgres();
select is((select count(*)::int from public.audit_log where action = 'delegation.ended'), 4, 'audit: no delegation ended for him');
select is(pg_temp.audited('member.deactivated', :lucas), 1, 'audit: the deactivation is logged');

-- Demoting a manager and a delegate --------------------------------------------------------------

-- Nora has no reports and an upcoming delegation to Max (d2): made an admin she keeps it, made
-- an employee it is cancelled.
select pg_temp.act_as(:ada);
select lives_ok(
  $$ select public.update_member('00000000-0000-4000-8000-0000000000b3', 'Nora Manager', 'admin',
       '00000000-0000-4000-8000-0000000000a1', 'US', 'TX', 'America/Chicago') $$,
  'Ada makes Nora an admin');
select pg_temp.act_as_postgres();
select is(pg_temp.ended((select id from d2)), '(f,)', 'a manager made an admin keeps her delegation');
select pg_temp.act_as(:ada);
select lives_ok(
  $$ select public.update_member('00000000-0000-4000-8000-0000000000b3', 'Nora Manager', 'employee',
       '00000000-0000-4000-8000-0000000000a1', 'US', 'TX', 'America/Chicago') $$,
  'Ada makes Nora an employee');
select pg_temp.act_as_postgres();
select is(pg_temp.ended((select id from d2)), '(t,demoted)', 'demoted manager: her upcoming delegation to Max is cancelled');
select is(
  (select (actor_id = :ada::uuid, metadata ->> 'reason')::text
   from public.audit_log where action = 'delegation.ended' and target_user_id = :nora::uuid),
  '(t,demoted)', 'audit: by the admin, with the reason, against the manager');
select is(pg_temp.audited('member.role_changed', :nora), 2, 'audit: next to the role changes');
select is(pg_temp.notified(:max, 'delegation.ended'), 2, 'notify: Max, her delegate, is told');
select is(
  (select (p ->> 'for', p ->> 'reason', p ->> 'name')::text
   from (select pg_temp.last_note(:max, 'delegation.ended', 'Nora Manager') as p) n),
  '(delegate,demoted,"Nora Manager")', 'notify: with the reason and her name');
select is(pg_temp.notified(:nora, 'delegation.ended'), 2, 'notify: Nora herself is not told');

-- Max names Ann as delegate; Ann is made an employee, so the delegation ends and Max is told.
select pg_temp.act_as(:max);
create temp table d5 as select public.set_delegation(:ann, pg_temp.mt(), pg_temp.mt() + 4) as id;
grant select on d5 to authenticated;
select pg_temp.act_as(:ada);
select lives_ok(
  $$ select public.update_member('00000000-0000-4000-8000-0000000000a2', 'Ann Admin', 'employee',
       '00000000-0000-4000-8000-0000000000a1', 'US', 'TX', 'America/Chicago') $$,
  'Ada makes Ann an employee');
select pg_temp.act_as_postgres();
select is(pg_temp.ended((select id from d5)), '(t,demoted)', 'demoted delegate: the delegation ends');
select is(
  (select (p ->> 'for', p ->> 'reason', p ->> 'name')::text
   from (select pg_temp.last_note(:max, 'delegation.ended', 'Ann Admin') as p) n),
  '(manager,demoted,"Ann Admin")', 'notify: Max is told his delegate was demoted');
select is((select count(*)::int from public.delegations where ended_at is null and ends_on >= pg_temp.mt()), 0,
  'no live delegation is left among them');

-- A failed change leaves the delegation alone (rolled back with it).
select pg_temp.act_as(:max);
create temp table d6 as select public.set_delegation(:ada, pg_temp.mt(), pg_temp.mt() + 1) as id;
grant select on d6 to authenticated;
select pg_temp.act_as(:ada);
select throws_ok(format($$ select public.set_user_active(%L, false) $$, :ada::uuid),
  '42501', 'cannot_change_self', 'the owner cannot deactivate themselves');
select pg_temp.act_as_postgres();
select is(pg_temp.ended((select id from d6)), '(f,)', 'and nothing ended');

-- History access ------------------------------------------------------------------------------

select pg_temp.act_as(:max);
select is((select array_agg(status order by status, id) from public.delegation_history()),
  array['active', 'completed', 'ended', 'ended', 'ended', 'ended'],
  'history: a manager sees all of theirs, given and received, past and ended');
select is((select count(*)::int from public.delegation_history() where delegate_id = :max::uuid), 1,
  'history: including the one they received');
select is((select (manager_name, delegate_name)::text from public.delegation_history() where id = (select id from d1)),
  '("Max Manager","Mia Manager")', 'history: with the names');
select is((select (status, end_reason)::text from public.delegation_history() where id = (select id from d1)),
  '(ended,deactivated)', 'history: and why it ended');
select throws_ok(format($$ select * from public.delegation_history(%L) $$, :mia::uuid),
  '42501', 'not_allowed', 'history: a manager cannot read a peer''s');
select is((select count(*)::int from public.delegation_history(:max)), 6, 'history: asking for yourself by id is fine');

select pg_temp.act_as(:mia);
select is((select array_agg(status order by id) from public.delegation_history()), array['ended', 'ended', 'ended']::text[],
  'history: Mia sees what she gave and received');
select pg_temp.act_as(:erin);
select is((select count(*)::int from public.delegation_history()), 0, 'history: an employee has none');
select throws_ok(format($$ select * from public.delegation_history(%L) $$, :max::uuid),
  '42501', 'not_allowed', 'history: and cannot read a manager''s');

select pg_temp.act_as(:ada);
select is((select count(*)::int from public.delegation_history(:max)), 6, 'history: the owner reads any manager''s');
select is((select count(*)::int from public.delegation_history(:mia)), 3, 'history: and a delegate''s');
select throws_ok(format($$ select * from public.delegation_history(%L) $$, :gus::uuid),
  '42501', 'manager_not_found', 'history: not another org''s');
select throws_ok(format($$ select * from public.delegation_history(%L) $$, gen_random_uuid()),
  '42501', 'manager_not_found', 'history: nor someone who does not exist');
select pg_temp.act_as(:olga);
select is((select count(*)::int from public.delegation_history(:gus)), 0, 'history: another org''s owner sees only theirs');
select throws_ok(format($$ select * from public.delegation_history(%L) $$, :max::uuid),
  '42501', 'manager_not_found', 'history: and not this org''s');

select * from finish();
rollback;
