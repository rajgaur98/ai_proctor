begin;
create extension if not exists pgtap with schema extensions;

select plan(114);

-- Seed org: Ada owner (America/New_York) -> Max manager (America/Chicago) -> Erin, Lucas.
-- Added here: Mia and Nora (managers under Ada), Ann (admin), Ivan (inactive manager),
-- Gus (a manager of another org) and Olga's org.
\set ada '''00000000-0000-4000-8000-0000000000a1'''
\set max '''00000000-0000-4000-8000-0000000000b1'''
\set erin '''00000000-0000-4000-8000-0000000000c1'''
\set lucas '''00000000-0000-4000-8000-0000000000c2'''
\set ann '''00000000-0000-4000-8000-0000000000a2'''
\set mia '''00000000-0000-4000-8000-0000000000b2'''
\set nora '''00000000-0000-4000-8000-0000000000b3'''
\set ivan '''00000000-0000-4000-8000-0000000000b4'''
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

-- Audit rows of one action about one person, and notifications of one kind to one person,
-- read as the owner.
create function pg_temp.audited(act text, who uuid) returns int
language sql security definer as $$
  select count(*)::int from public.audit_log where action = act and target_user_id = who
$$;
create function pg_temp.notified(uid uuid, k text) returns int
language sql security definer as $$
  select count(*)::int from public.notifications where user_id = uid and kind = k
$$;

insert into public.orgs (id, name) values (:org2, 'Other Co');
insert into auth.users (id, email) values
  (:ann, 'ann@acme.test'), (:mia, 'mia@acme.test'), (:nora, 'nora@acme.test'),
  (:ivan, 'ivan@acme.test'), (:gus, 'gus@other.test'), (:olga, 'olga@other.test');
insert into public.users (id, org_id, full_name, email, role, manager_id, active) values
  (:olga, :org2, 'Olga Owner', 'olga@other.test', 'owner', null, true),
  (:gus, :org2, 'Gus Manager', 'gus@other.test', 'manager', :olga, true),
  (:ann, :org, 'Ann Admin', 'ann@acme.test', 'admin', :ada, true),
  (:mia, :org, 'Mia Manager', 'mia@acme.test', 'manager', :ada, true),
  (:nora, :org, 'Nora Manager', 'nora@acme.test', 'manager', :ada, true),
  (:ivan, :org, 'Ivan Manager', 'ivan@acme.test', 'manager', :ada, false);
insert into public.presence (user_id, org_id)
select id, org_id from public.users on conflict (user_id) do nothing;

-- Erin is in America/Los_Angeles; the week of Monday 16 March 2026 is daylight time (-07).
-- Monday: verified 09:00-11:00, idle 11:00-11:20 (flagged), verified 11:20-13:00.
insert into public.time_segments (org_id, user_id, day, start_at, end_at, type, counted, flagged)
values
  (:org, :erin, '2026-03-16', '2026-03-16 09:00:00-07', '2026-03-16 11:00:00-07', 'verified', true, false),
  (:org, :erin, '2026-03-16', '2026-03-16 11:00:00-07', '2026-03-16 11:20:00-07', 'idle', true, true),
  (:org, :erin, '2026-03-16', '2026-03-16 11:20:00-07', '2026-03-16 13:00:00-07', 'verified', true, false);

-- Setting a delegation: who and what ---------------------------------------------------------

select pg_temp.act_as(:lucas);
select throws_ok(format($$ select public.set_delegation(%L, pg_temp.mt(), pg_temp.mt() + 3) $$, :mia::uuid),
  '22023', 'not_a_manager', 'set: an employee has nothing to delegate');
select is((select count(*)::int from public.delegate_candidates()), 0, 'candidates: none for an employee');

select pg_temp.act_as(:max);
select throws_ok(format($$ select public.set_delegation(%L, pg_temp.mt(), pg_temp.mt() + 3) $$, :lucas::uuid),
  '22023', 'delegate_must_be_manager', 'set: the delegate is not an employee');
select throws_ok(format($$ select public.set_delegation(%L, pg_temp.mt(), pg_temp.mt() + 3) $$, :max::uuid),
  '22023', 'cannot_delegate_to_self', 'set: not to yourself');
select throws_ok(format($$ select public.set_delegation(%L, pg_temp.mt(), pg_temp.mt() + 3) $$, :gus::uuid),
  '22023', 'delegate_not_found', 'set: the delegate is in the same org');
select throws_ok(format($$ select public.set_delegation(%L, pg_temp.mt(), pg_temp.mt() + 3) $$, :ivan::uuid),
  '22023', 'delegate_not_found', 'set: the delegate is active');
select throws_ok(format($$ select public.set_delegation(%L, pg_temp.mt(), pg_temp.mt() + 3) $$, gen_random_uuid()),
  '22023', 'delegate_not_found', 'set: the delegate exists');
select throws_ok(format($$ select public.set_delegation(%L, pg_temp.mt() - 1, pg_temp.mt() + 3) $$, :mia::uuid),
  '22023', 'invalid_range', 'set: not starting before today');
select throws_ok(format($$ select public.set_delegation(%L, pg_temp.mt() + 3, pg_temp.mt() + 2) $$, :mia::uuid),
  '22023', 'invalid_range', 'set: the end is not before the start');
select throws_ok(format($$ select public.set_delegation(%L, pg_temp.mt(), pg_temp.mt() + 91) $$, :mia::uuid),
  '22023', 'invalid_range', 'set: at most 90 days (91 days is refused)');
select throws_ok(format($$ select public.set_delegation(%L, null, pg_temp.mt() + 3) $$, :mia::uuid),
  '22023', 'invalid_range', 'set: dates are required');
select throws_ok(format($$ select public.set_delegation(%L, pg_temp.mt(), pg_temp.mt() + 3, %L) $$, :mia::uuid, :ada::uuid),
  '42501', 'not_allowed', 'set: a manager cannot set it for someone else');

-- Before the range: Nora is booked for later and sees nothing yet.
create temp table later as
  select public.set_delegation(:nora, pg_temp.mt() + 4, pg_temp.mt() + 6) as id;
grant select on later to authenticated;
select ok((select id from later) is not null, 'set: a later delegation is accepted');
select pg_temp.act_as(:nora);
select is(public.can_view_user(:erin), false, 'before the range: the delegate sees nothing');
select is(public.can_decide_timesheet(:erin), false, 'before the range: and cannot decide');

-- The inclusive range: it may start today and end on the 90th day.
select pg_temp.act_as(:max);
select lives_ok(format($$ select public.end_delegation(%L) $$, (select id from later)), 'end: an upcoming delegation is cancelled');
create temp table now_dl as select public.set_delegation(:mia, pg_temp.mt(), pg_temp.mt() + 3) as id;
grant select on now_dl to authenticated;
select ok((select id from now_dl) is not null, 'set: a manager names a delegate from today');
select is(
  (select (manager_id = :max::uuid, delegate_id = :mia::uuid, starts_on = pg_temp.mt(),
           ends_on = pg_temp.mt() + 3, created_by = :max::uuid, ended_at is null)::text
   from public.delegations where id = (select id from now_dl)),
  '(t,t,t,t,t,t)', 'set: the row holds both sides, the inclusive dates and who set it');
select throws_ok(format($$ select public.set_delegation(%L, pg_temp.mt() + 3, pg_temp.mt() + 5) $$, :nora::uuid),
  '55000', 'delegation_overlaps', 'overlap: the last day is shared with the live delegation');
select throws_ok(format($$ select public.set_delegation(%L, pg_temp.mt(), pg_temp.mt() + 1) $$, :nora::uuid),
  '55000', 'delegation_overlaps', 'overlap: inside the live delegation');
select lives_ok(format($$ select public.set_delegation(%L, pg_temp.mt() + 4, pg_temp.mt() + 7) $$, :nora::uuid),
  'overlap: the day after is fine');
select lives_ok(format($$ select public.end_delegation(%L) $$,
  (select id from public.delegations where delegate_id = :nora::uuid and ended_at is null)),
  'end: the later one is cancelled again');

select pg_temp.act_as_postgres();
select is(pg_temp.audited('delegation.set', :max), 3, 'audit: each delegation set is logged against the manager');
select is((select actor_id from public.audit_log where action = 'delegation.set' order by id desc limit 1), :max::uuid,
  'audit: with the actor');
select is(
  (select metadata - 'delegation_id' from public.audit_log where action = 'delegation.set' order by id desc limit 1),
  jsonb_build_object('delegate_id', :nora::uuid, 'starts_on', pg_temp.mt() + 4, 'ends_on', pg_temp.mt() + 7),
  'audit: with the delegate and the dates');
select is(pg_temp.audited('delegation.ended', :max), 2, 'audit: each end is logged');
select is(pg_temp.notified(:mia, 'delegation.assigned'), 1, 'notify: the delegate is told');
select is(pg_temp.notified(:nora, 'delegation.ended'), 2, 'notify: and told when it is ended');

-- Who sees what ---------------------------------------------------------------------------

select pg_temp.act_as(:max);
select is((select count(*)::int from public.delegations), 3, 'RLS: the manager reads their delegations');
select is((select count(*)::int from public.my_delegations()), 1, 'my_delegations: only current and upcoming ones');
select is((select delegate_name from public.my_delegations()), 'Mia Manager', 'my_delegations: with the delegate''s name');
select is((select array_agg(full_name order by full_name) from public.delegate_candidates()),
  array['Ada Admin', 'Ann Admin', 'Mia Manager', 'Nora Manager'],
  'candidates: active non-employees of the org, not yourself');
select pg_temp.act_as(:mia);
select is((select count(*)::int from public.delegations), 1, 'RLS: the delegate reads theirs');
select is((select manager_name from public.my_delegations()), 'Max Manager', 'my_delegations: the delegate sees the manager''s name');
select pg_temp.act_as(:erin);
select is((select count(*)::int from public.delegations), 0, 'RLS: the manager''s reports read none');
select is((select count(*)::int from public.my_delegations()), 0, 'my_delegations: nothing for them either');
select pg_temp.act_as(:lucas);
select is((select count(*)::int from public.delegations), 0, 'RLS: nor does a peer');

-- During the range -------------------------------------------------------------------------

select pg_temp.act_as(:mia);
select is(public.can_view_user(:erin), true, 'during: the delegate sees the manager''s report');
select is(public.can_view_user(:lucas), true, 'during: and the other one');
select is(public.can_approve_for(:erin), true, 'during: can_approve_for honours it');
select is(public.can_decide_timesheet(:erin), true, 'during: so does can_decide_timesheet');
select is(public.can_reopen_timesheet(:erin), true, 'during: and can_reopen_timesheet');
select isnt((select count(*)::int from public.users), 1, 'during: the delegate''s user list includes the reports');
select pg_temp.act_as(:nora);
select is(public.can_view_user(:erin), false, 'during: another manager still sees nothing');
select is(public.can_decide_timesheet(:erin), false, 'during: or decides');

-- The week: Erin submits, Mia (delegate) works it ------------------------------------------------

select pg_temp.act_as(:erin);
create temp table ts as select public.ensure_timesheet(:erin, '2026-03-16') as id;
grant select on ts to authenticated;
select is(public.submit_timesheet((select id from ts)), 'submitted', 'Erin submits her week');
create temp table pend as
  select public.request_manual_entry('2026-03-17 15:00:00-07', '2026-03-17 16:00:00-07', null, 'Client visit') as id;
grant select on pend to authenticated;

select pg_temp.act_as(:mia);
select lives_ok(format($$ select public.return_timesheet(%L, 'Add Wednesday') $$, (select id from ts)),
  'during: the delegate returns the week');
select pg_temp.act_as(:erin);
select is(public.submit_timesheet((select id from ts)), 'submitted', 'Erin submits again');
select pg_temp.act_as(:mia);
select throws_ok(format($$ select public.approve_timesheet(%L) $$, (select id from ts)),
  '55000', 'pending_entries', 'during: approval waits for the manual entry');
select lives_ok(format($$ select public.decide_manual_entry(%L, true) $$, (select id from pend)),
  'during: the delegate decides the manual entry');
select throws_ok(format($$ select public.approve_timesheet(%L) $$, (select id from ts)),
  '55000', 'undecided_flagged', 'during: and the flagged segment');
select lives_ok(format($$ select public.edit_segment(%L, 'keep', '2026-03-16 11:00:00-07', '2026-03-16 11:20:00-07') $$,
  (select id from ts)), 'during: the delegate keeps the flagged time');
select lives_ok(format($$ select public.adjust_time(%L, '2026-03-18 14:00:00-07', '2026-03-18 15:00:00-07', null, 'Called in') $$,
  (select id from ts)), 'during: the delegate adds time on the employee''s behalf');
select lives_ok(format($$ select public.approve_timesheet(%L) $$, (select id from ts)), 'during: the delegate approves');
select is(
  (select (status, approver_id = :mia::uuid)::text from public.timesheets where id = (select id from ts)),
  '(approved,t)', 'during: recorded as approved by the delegate');
select lives_ok(format($$ select public.reopen_timesheet(%L, 'Forgot a call') $$, (select id from ts)),
  'during: the delegate reopens it');
select is((select status from public.timesheets where id = (select id from ts)), 'submitted', 'during: back to submitted');
select pg_temp.act_as(:erin);
select is((select count(*)::int from public.notifications where kind = 'timesheet.reopened'), 1,
  'during: Erin is told of the reopen');

-- After the range ----------------------------------------------------------------------------

select pg_temp.act_as_postgres();
update public.delegations set starts_on = pg_temp.mt() - 20, ends_on = pg_temp.mt() - 10
where id = (select id from now_dl);
select pg_temp.act_as(:mia);
select is(public.can_view_user(:erin), false, 'after: the delegate sees nothing');
select is(public.can_approve_for(:erin), false, 'after: cannot approve');
select is(public.can_decide_timesheet(:erin), false, 'after: cannot decide');
select throws_ok(format($$ select public.approve_timesheet(%L) $$, (select id from ts)),
  '42501', 'timesheet_not_found', 'after: the timesheet is gone from their view');
select throws_ok(format($$ select public.decide_manual_entry(%L, true) $$, (select id from pend)),
  '42501', 'entry_not_found', 'after: so are the manual entries');
select pg_temp.act_as(:max);
select throws_ok(format($$ select public.end_delegation(%L) $$, (select id from now_dl)),
  '55000', 'delegation_not_active', 'after: an expired delegation cannot be ended');
select is((select count(*)::int from public.my_delegations()), 0, 'after: it is no longer listed');

-- Ending, and owners and admins on a manager's behalf ----------------------------------------------

create temp table second as select public.set_delegation(:mia, pg_temp.mt(), pg_temp.mt() + 1) as id;
grant select on second to authenticated;
select pg_temp.act_as(:mia);
select is(public.can_view_user(:erin), true, 'a new delegation after the expired one works');
select pg_temp.act_as(:lucas);
select throws_ok(format($$ select public.end_delegation(%L) $$, (select id from second)),
  '42501', 'delegation_not_found', 'end: a report cannot end it');
select pg_temp.act_as(:nora);
select throws_ok(format($$ select public.end_delegation(%L) $$, (select id from second)),
  '42501', 'delegation_not_found', 'end: nor a peer');
select pg_temp.act_as(:mia);
select throws_ok(format($$ select public.end_delegation(%L) $$, (select id from second)),
  '42501', 'delegation_not_found', 'end: nor the delegate');
select pg_temp.act_as(:max);
select lives_ok(format($$ select public.end_delegation(%L) $$, (select id from second)), 'end: the manager ends it');
select pg_temp.act_as(:mia);
select is(public.can_view_user(:erin), false, 'end: the delegate loses access at once');
select pg_temp.act_as(:max);
select throws_ok(format($$ select public.end_delegation(%L) $$, (select id from second)),
  '55000', 'delegation_not_active', 'end: not twice');
select lives_ok(format($$ select public.set_delegation(%L, pg_temp.mt(), pg_temp.mt() + 1) $$, :nora::uuid),
  'end: an ended delegation frees the slot');

-- Ann (admin) sets and ends one for Max; Max's live one is ended first.
select lives_ok(format($$ select public.end_delegation(%L) $$,
  (select id from public.delegations where delegate_id = :nora::uuid and ended_at is null)), 'end: Max clears the way');
select pg_temp.act_as(:ann);
select lives_ok(format($$ select public.set_delegation(%L, pg_temp.mt(), pg_temp.mt() + 2, %L) $$, :mia::uuid, :max::uuid),
  'an admin sets a delegation for a manager');
select is(
  (select (actor_id = :ann::uuid, target_user_id = :max::uuid)::text from public.audit_log
   where action = 'delegation.set' order by id desc limit 1),
  '(t,t)', 'audit: the admin is the actor, the manager the subject');
select throws_ok(format($$ select public.set_delegation(%L, pg_temp.mt(), pg_temp.mt() + 2, %L) $$, :mia::uuid, :erin::uuid),
  '22023', 'not_a_manager', 'an admin cannot delegate for an employee');
select lives_ok(format($$ select public.end_delegation(%L) $$,
  (select id from public.delegations
   where delegate_id = :mia::uuid and ended_at is null and ends_on >= pg_temp.mt())), 'an admin ends it');

-- A delegate who is no longer a manager, or active, loses it.
select pg_temp.act_as(:max);
select lives_ok(format($$ select public.set_delegation(%L, pg_temp.mt(), pg_temp.mt() + 5) $$, :mia::uuid), 'Mia is named again');
select pg_temp.act_as_postgres();
update public.users set role = 'employee' where id = :mia;
select pg_temp.act_as(:mia);
select is(public.can_view_user(:erin), false, 'a delegate made an employee loses it');
select pg_temp.act_as_postgres();
update public.users set role = 'manager' where id = :mia;
select pg_temp.act_as(:mia);
select is(public.can_view_user(:erin), true, 'and gets it back with the role');

-- Manager change moves pending work (TS-15) -------------------------------------------------------

-- Erin's week is submitted and she has one pending entry; Mia is Max's live delegate.
select pg_temp.act_as(:erin);
create temp table pend2 as
  select public.request_manual_entry('2026-03-19 14:00:00-07', '2026-03-19 15:00:00-07', null, 'Site visit') as id;
grant select on pend2 to authenticated;

select pg_temp.act_as(:ada);
select lives_ok(
  $$ select public.update_member('00000000-0000-4000-8000-0000000000c1', 'Erin Employee', 'employee',
       '00000000-0000-4000-8000-0000000000b3', 'US', 'CA', 'America/Los_Angeles') $$,
  'Ada moves Erin to Nora');
select pg_temp.act_as_postgres();
select is(
  (select metadata - 'from' from public.audit_log where action = 'timesheet.reassigned' and target_user_id = :erin::uuid),
  jsonb_build_object('to', :nora::uuid, 'timesheets', 1, 'manual_entries', 1),
  'audit: the move is logged with how many timesheets and entries');
select is((select metadata ->> 'from' from public.audit_log where action = 'timesheet.reassigned'), :max::text,
  'audit: from the old manager');
select is((select actor_id from public.audit_log where action = 'timesheet.reassigned'), :ada::uuid, 'audit: by whoever made the change');
select is(pg_temp.audited('member.manager_changed', :erin), 1, 'audit: next to the reporting-line change');
select is(pg_temp.notified(:nora, 'timesheet.reassigned'), 1, 'notify: the new manager is told');

select pg_temp.act_as(:max);
select is(public.can_view_user(:erin), false, 'moved: the old manager loses sight');
select throws_ok(format($$ select public.approve_timesheet(%L) $$, (select id from ts)),
  '42501', 'timesheet_not_found', 'moved: and cannot approve the week');
select throws_ok(format($$ select public.decide_manual_entry(%L, true) $$, (select id from pend2)),
  '42501', 'entry_not_found', 'moved: or decide the pending entry');
select pg_temp.act_as(:mia);
select is(public.can_view_user(:erin), false, 'moved: the old manager''s delegate loses it too');
select throws_ok(format($$ select public.approve_timesheet(%L) $$, (select id from ts)),
  '42501', 'timesheet_not_found', 'moved: and cannot approve');
select pg_temp.act_as(:nora);
select is((select count(*)::int from public.timesheets where id = (select id from ts)), 1, 'moved: the new manager sees the week');
select lives_ok(format($$ select public.decide_manual_entry(%L, true) $$, (select id from pend2)),
  'moved: and decides the pending entry');
select lives_ok(format($$ select public.approve_timesheet(%L) $$, (select id from ts)),
  'moved: and approves the submitted week');
select is((select approver_id from public.timesheets where id = (select id from ts)), :nora::uuid, 'moved: as the approver');

-- A change with nothing pending is not logged as a move.
select pg_temp.act_as(:ada);
select lives_ok(
  $$ select public.update_member('00000000-0000-4000-8000-0000000000c2', 'Lucas Martin', 'employee',
       '00000000-0000-4000-8000-0000000000b3', 'US', 'TX', 'America/Chicago') $$,
  'Ada moves Lucas to Nora');
select pg_temp.act_as_postgres();
select is(pg_temp.audited('timesheet.reassigned', :lucas), 0, 'audit: nothing pending, no move logged');
select is(pg_temp.audited('member.manager_changed', :lucas), 1, 'audit: the reporting-line change still is');

-- The owner reopens their own auto-approved week (TS-16/18) ----------------------------------------------

select pg_temp.act_as(:ada);
create temp table own as select public.ensure_timesheet(:ada, '2026-03-16') as id;
grant select on own to authenticated;
select is(public.submit_timesheet((select id from own)), 'approved', 'owner: the week is approved on submit');
select is(public.can_decide_timesheet(:ada), false, 'owner: not a decider of their own week');
select is(public.can_reopen_timesheet(:ada), true, 'owner: but may reopen it');
select throws_ok(format($$ select public.reopen_timesheet(%L, '   ') $$, (select id from own)),
  '22023', 'invalid_reason', 'owner: a reason is required');
select lives_ok(format($$ select public.reopen_timesheet(%L, 'Missed Friday') $$, (select id from own)),
  'owner: reopens their own auto-approved week');
select is(
  (select (status, submitted_at is null, approved_at is null, approver_id is null)::text
   from public.timesheets where id = (select id from own)),
  '(draft,t,t,t)', 'owner: it goes back to draft');
select throws_ok(format($$ select public.reopen_timesheet(%L, 'Again') $$, (select id from own)),
  '55000', 'not_approved', 'owner: only an approved week');
select is(public.submit_timesheet((select id from own)), 'approved', 'owner: submits it again');
select pg_temp.act_as_postgres();
select is(
  (select (actor_id = :ada::uuid, metadata ->> 'reason', (metadata ->> 'own_week')::boolean)::text
   from public.audit_log where action = 'timesheet.reopened' and target_user_id = :ada::uuid),
  '(t,"Missed Friday",t)', 'owner: audit-logged with the reason');
select is(pg_temp.notified(:ada, 'timesheet.reopened'), 0, 'owner: nobody is notified of their own reopen');

-- Others still cannot: not an admin who is not the manager, not the owner on someone else's week.
select pg_temp.act_as(:ann);
select is(public.can_reopen_timesheet(:erin), false, 'an admin cannot reopen a report''s week');
select throws_ok(format($$ select public.reopen_timesheet(%L, 'Because') $$, (select id from ts)),
  '42501', 'not_the_manager', 'an admin who is not the manager cannot reopen');
select pg_temp.act_as(:ada);
select is(public.can_reopen_timesheet(:erin), false, 'the owner cannot reopen someone else''s week');
select throws_ok(format($$ select public.reopen_timesheet(%L, 'Because') $$, (select id from ts)),
  '42501', 'not_the_manager', 'the owner who is not the manager cannot reopen');
select pg_temp.act_as(:max);
select is(public.can_reopen_timesheet(:max), false, 'a manager cannot reopen their own week');

select * from finish();
rollback;
