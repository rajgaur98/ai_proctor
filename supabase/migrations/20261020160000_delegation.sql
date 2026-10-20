-- #44: approval delegation and manager reassignment (TS-14, TS-15, AUD-01).
--
-- A manager hands approval to a delegate for a date range (e.g. while on leave). The
-- delegate sees and decides for the manager's direct reports during the range: the same
-- rule in can_view_user, can_approve_for and is_entry_decider, which every approval path
-- (timesheets, manual entries, shifts) goes through, now all asking
-- internal.is_active_delegate. A range is inclusive dates in the manager's time zone.
-- Ending a delegation keeps the row (ended_at) so the history stays. Setting and ending
-- are audit-logged and tell the delegate.
--
-- TS-15: approval is looked up from users.manager_id when someone decides, and
-- timesheets.approver_id is only the person who approved, so a manager change moves
-- pending (submitted) timesheets and pending manual entries to the new manager with
-- nothing to rewrite; update_member audits the move and tells the new manager.
--
-- TS-16/18: the owner at the top of the org auto-approves their own weeks and has no
-- manager to reopen them, so they may reopen their own auto-approved week (reason
-- required, audit-logged). It goes back to draft, to edit and submit again.

-- Delegations ----------------------------------------------------------------------------

alter table public.delegations
  add column ended_at timestamptz,
  add column created_by uuid references public.users (id) on delete set null;

-- The one definition of "active delegate": the delegation is not ended, its range holds
-- the manager's local today, and the delegate is an active non-employee. Callers still
-- check their own viewer (active, same org).
create function internal.is_active_delegate(p_manager_id uuid, p_delegate_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.delegations d
    join public.users m on m.id = d.manager_id
    join public.users g on g.id = d.delegate_id
    where d.manager_id = p_manager_id
      and d.delegate_id = p_delegate_id
      and d.ended_at is null
      and g.active
      and g.role <> 'employee'
      and (now() at time zone m.timezone)::date between d.starts_on and d.ends_on
  );
$$;

revoke all on function internal.is_active_delegate(uuid, uuid) from public, anon, authenticated;

-- Access checks, one delegation rule ---------------------------------------------------------

-- NFR-SEC-05: owners and admins only get their org-wide view with an MFA-verified session
-- when the org requires it (latest definition: create_org_and_admin_mfa).
create or replace function public.can_view_user(target uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.users viewer
    join public.users employee on employee.id = target
    join public.orgs o on o.id = viewer.org_id
    where viewer.id = auth.uid()
      and viewer.active
      and viewer.org_id = employee.org_id
      and viewer.org_id = internal.jwt_org_id()
      and (
        viewer.id = employee.id
        or (viewer.role in ('owner', 'admin')
            and (not coalesce((o.policy ->> 'require_admin_mfa')::boolean, false)
                 or auth.jwt() ->> 'aal' = 'aal2'))
        or employee.manager_id = viewer.id
        or internal.is_active_delegate(employee.manager_id, viewer.id)
      )
  );
$$;

create or replace function public.can_approve_for(target uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.users viewer
    join public.users employee on employee.id = target
    where viewer.id = auth.uid()
      and viewer.active
      and viewer.org_id = employee.org_id
      and viewer.org_id = internal.jwt_org_id()
      and viewer.role not in ('owner', 'admin')
      and viewer.id <> employee.id
      and (
        employee.manager_id = viewer.id
        or internal.is_active_delegate(employee.manager_id, viewer.id)
      )
  );
$$;

create or replace function internal.is_entry_decider(p_decider public.users, p_employee_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.users e
    where e.id = p_employee_id
      and e.org_id = p_decider.org_id
      and e.id <> p_decider.id
      and p_decider.active
      and (
        e.manager_id = p_decider.id
        or internal.is_active_delegate(e.manager_id, p_decider.id)
      )
  );
$$;

-- Setting and ending ----------------------------------------------------------------------

-- TS-14: a manager (or an owner or admin, for any manager) names a delegate for the
-- inclusive dates p_starts_on..p_ends_on, in the manager's time zone: today or later,
-- at most 90 days, and not overlapping another live delegation of that manager. The
-- delegate is an active owner, admin or manager of the org, never the manager
-- themselves. p_manager_id defaults to the caller. Returns the delegation id.
create function public.set_delegation(
  p_delegate_id uuid,
  p_starts_on date,
  p_ends_on date,
  p_manager_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me public.users := internal.current_app_user();
  v_manager public.users;
  v_delegate public.users;
  v_id uuid;
begin
  select * into v_manager from public.users u
  where u.id = coalesce(p_manager_id, v_me.id) and u.org_id = v_me.org_id;
  if not found then
    raise exception 'manager_not_found' using errcode = '42501';
  end if;
  if v_manager.id <> v_me.id and v_me.role not in ('owner', 'admin') then
    raise exception 'not_allowed' using errcode = '42501';
  end if;
  if v_manager.role = 'employee' or not v_manager.active then
    raise exception 'not_a_manager' using errcode = '22023';
  end if;

  select * into v_delegate from public.users u
  where u.id = p_delegate_id and u.org_id = v_manager.org_id and u.active;
  if not found then
    raise exception 'delegate_not_found' using errcode = '22023';
  end if;
  if v_delegate.id = v_manager.id then
    raise exception 'cannot_delegate_to_self' using errcode = '22023';
  end if;
  if v_delegate.role = 'employee' then
    raise exception 'delegate_must_be_manager' using errcode = '22023';
  end if;

  if p_starts_on is null or p_ends_on is null or p_ends_on < p_starts_on
    or p_ends_on - p_starts_on > 90
    or p_starts_on < (now() at time zone v_manager.timezone)::date
  then
    raise exception 'invalid_range' using errcode = '22023';
  end if;

  -- One writer per manager, so two requests cannot both pass the overlap check.
  perform 1 from public.users u where u.id = v_manager.id for update;
  if exists (
    select 1 from public.delegations d
    where d.manager_id = v_manager.id and d.ended_at is null
      and d.ends_on >= p_starts_on and d.starts_on <= p_ends_on
  ) then
    raise exception 'delegation_overlaps' using errcode = '55000';
  end if;

  insert into public.delegations (org_id, manager_id, delegate_id, starts_on, ends_on, created_by)
  values (v_manager.org_id, v_manager.id, v_delegate.id, p_starts_on, p_ends_on, v_me.id)
  returning id into v_id;

  perform internal.audit(v_manager.org_id, v_me.id, 'delegation.set', v_manager.id,
    jsonb_build_object('delegation_id', v_id, 'delegate_id', v_delegate.id,
      'starts_on', p_starts_on, 'ends_on', p_ends_on));
  perform internal.notify(v_manager.org_id, v_delegate.id, 'delegation.assigned',
    jsonb_build_object('delegation_id', v_id, 'manager_id', v_manager.id,
      'starts_on', p_starts_on, 'ends_on', p_ends_on));
  return v_id;
end;
$$;

-- TS-14: ends a delegation now (before it starts, it is cancelled). The manager, or an
-- owner or admin, may; one that is over or already ended can't be ended again.
create function public.end_delegation(p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me public.users := internal.current_app_user();
  v_d public.delegations;
  v_manager public.users;
begin
  select * into v_d from public.delegations d where d.id = p_id and d.org_id = v_me.org_id for update;
  if not found or (v_d.manager_id <> v_me.id and v_me.role not in ('owner', 'admin')) then
    raise exception 'delegation_not_found' using errcode = '42501';
  end if;
  select * into v_manager from public.users u where u.id = v_d.manager_id;
  if v_d.ended_at is not null or v_d.ends_on < (now() at time zone v_manager.timezone)::date then
    raise exception 'delegation_not_active' using errcode = '55000';
  end if;

  update public.delegations set ended_at = now() where id = v_d.id;

  perform internal.audit(v_d.org_id, v_me.id, 'delegation.ended', v_d.manager_id,
    jsonb_build_object('delegation_id', v_d.id, 'delegate_id', v_d.delegate_id,
      'starts_on', v_d.starts_on, 'ends_on', v_d.ends_on));
  perform internal.notify(v_d.org_id, v_d.delegate_id, 'delegation.ended',
    jsonb_build_object('delegation_id', v_d.id, 'manager_id', v_d.manager_id,
      'starts_on', v_d.starts_on, 'ends_on', v_d.ends_on));
end;
$$;

-- The caller's current and upcoming delegations, given and received, with names (a
-- manager may not be able to read a peer's row, so the names come from here).
create function public.my_delegations()
returns table (
  id uuid,
  manager_id uuid,
  manager_name text,
  delegate_id uuid,
  delegate_name text,
  starts_on date,
  ends_on date
)
language sql
stable
security definer
set search_path = ''
as $$
  select d.id, d.manager_id, m.full_name, d.delegate_id, g.full_name, d.starts_on, d.ends_on
  from public.delegations d
  join public.users m on m.id = d.manager_id
  join public.users g on g.id = d.delegate_id
  where auth.uid() is not null
    and d.org_id = internal.jwt_org_id()
    and (d.manager_id = auth.uid() or d.delegate_id = auth.uid())
    and d.ended_at is null
    and d.ends_on >= (now() at time zone m.timezone)::date
  order by d.starts_on, d.id;
$$;

-- Who the caller may name as a delegate: the active owners, admins and managers of
-- their org, other than themselves. Employees get nothing.
create function public.delegate_candidates()
returns table (id uuid, full_name text, role public.user_role)
language sql
stable
security definer
set search_path = ''
as $$
  select u.id, u.full_name, u.role
  from public.users u
  join public.users me on me.id = auth.uid()
  where me.active and me.role <> 'employee'
    and u.org_id = me.org_id and u.org_id = internal.jwt_org_id()
    and u.active and u.role <> 'employee' and u.id <> me.id
  order by u.full_name, u.id;
$$;

revoke all on function public.set_delegation(uuid, date, date, uuid) from public, anon;
revoke all on function public.end_delegation(uuid) from public, anon;
revoke all on function public.my_delegations() from public, anon;
revoke all on function public.delegate_candidates() from public, anon;
grant execute on function public.set_delegation(uuid, date, date, uuid) to authenticated;
grant execute on function public.end_delegation(uuid) to authenticated;
grant execute on function public.my_delegations() to authenticated;
grant execute on function public.delegate_candidates() to authenticated;

-- Manager change (TS-15) ----------------------------------------------------------------------

-- ORG-03..06: name, role, direct manager, work location and time zone of a member.
-- Ownership can't be given away here, and nobody changes their own role. A change of
-- direct manager also hands the person's submitted timesheets and pending manual
-- entries to the new manager (TS-15): both are decided by whoever manages the person
-- at the time, so there is nothing to move, only the move to audit and announce.
-- (Latest definition before this: org_members_and_audit.)
create or replace function public.update_member(
  p_user_id uuid,
  p_full_name text,
  p_role public.user_role,
  p_manager_id uuid,
  p_work_country text,
  p_work_state text,
  p_timezone text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_target public.users;
  v_me public.users;
  v_sheets int;
  v_entries int;
begin
  select * into v_target from public.users where id = p_user_id;
  if not found then
    raise exception 'user_not_found' using errcode = '42501';
  end if;
  v_me := internal.require_org_admin(v_target.org_id);
  if v_target.role = 'owner' and v_me.role <> 'owner' then
    raise exception 'owner_only' using errcode = '42501';
  end if;
  if p_role is distinct from v_target.role then
    if v_target.id = v_me.id then
      raise exception 'cannot_change_own_role' using errcode = '42501';
    end if;
    if p_role = 'owner' or v_target.role = 'owner' then
      raise exception 'cannot_change_owner' using errcode = '42501';
    end if;
  end if;
  if length(trim(coalesce(p_full_name, ''))) not between 1 and 120 then
    raise exception 'invalid_name' using errcode = '22023';
  end if;
  perform internal.check_member(v_target.org_id, v_target.id, p_role, p_manager_id,
    p_work_country, p_work_state, p_timezone);
  -- People who report to someone made an employee would be left without a manager.
  if p_role = 'employee' and v_target.role <> 'employee'
    and exists (select 1 from public.users where manager_id = v_target.id and active)
  then
    raise exception 'has_reports' using errcode = '22023';
  end if;

  update public.users
  set full_name = trim(p_full_name), role = p_role,
      manager_id = case when p_role = 'owner' then null else p_manager_id end,
      work_country = p_work_country, work_state = p_work_state, timezone = p_timezone
  where id = v_target.id;

  -- AUD-01: role and reporting-line changes; location too (it changes what's
  -- collected, e.g. Illinois).
  if p_role is distinct from v_target.role then
    perform internal.audit(v_target.org_id, v_me.id, 'member.role_changed', v_target.id,
      jsonb_build_object('from', v_target.role, 'to', p_role));
  end if;
  if p_role <> 'owner' and p_manager_id is distinct from v_target.manager_id then
    perform internal.audit(v_target.org_id, v_me.id, 'member.manager_changed', v_target.id,
      jsonb_build_object('from', v_target.manager_id, 'to', p_manager_id));

    -- TS-15: what the new manager now has to decide.
    select count(*)::int into v_sheets from public.timesheets t
    where t.user_id = v_target.id and t.status = 'submitted';
    select count(*)::int into v_entries from public.manual_entries e
    where e.user_id = v_target.id and e.status = 'pending';
    if v_sheets > 0 or v_entries > 0 then
      perform internal.audit(v_target.org_id, v_me.id, 'timesheet.reassigned', v_target.id,
        jsonb_build_object('from', v_target.manager_id, 'to', p_manager_id,
          'timesheets', v_sheets, 'manual_entries', v_entries));
      perform internal.notify(v_target.org_id, p_manager_id, 'timesheet.reassigned',
        jsonb_build_object('user_id', v_target.id, 'from', v_target.manager_id,
          'timesheets', v_sheets, 'manual_entries', v_entries));
    end if;
  end if;
  if (p_work_country, p_work_state) is distinct from (v_target.work_country, v_target.work_state) then
    perform internal.audit(v_target.org_id, v_me.id, 'member.location_changed', v_target.id,
      jsonb_build_object(
        'from', jsonb_build_object('country', v_target.work_country, 'state', v_target.work_state),
        'to', jsonb_build_object('country', p_work_country, 'state', p_work_state)));
  end if;
end;
$$;

-- Reopening ---------------------------------------------------------------------------------

-- True for the owner at the top of the org on their own week when no person approved it
-- (TS-16 auto-approves it): nobody else could reopen it. The caller checks the status.
create function internal.is_own_auto_approved(p_me public.users, p_ts public.timesheets)
returns boolean
language sql
stable
set search_path = ''
as $$
  select p_ts.user_id = p_me.id and p_me.role = 'owner' and p_me.manager_id is null
    and p_ts.approver_id is null;
$$;

revoke all on function internal.is_own_auto_approved(public.users, public.timesheets)
  from public, anon, authenticated;

-- TS-18: the manager (or delegate) reopens an approved week, back to submitted, with a
-- reason. Audit-logged; the employee is notified. Its days are rebuilt again (a
-- locked day's dirty marks were dropped). The owner at the top of the org may reopen
-- their own auto-approved week the same way; it goes back to draft, because there is
-- no one to approve it, and nobody is notified (it is them).
-- (Latest definition before this: weekly_timesheets.)
create or replace function public.reopen_timesheet(p_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me public.users := internal.current_app_user();
  v_ts public.timesheets := internal.load_timesheet(p_id, v_me);
  v_self boolean := internal.is_own_auto_approved(v_me, v_ts);
  v_reason text := trim(coalesce(p_reason, ''));
begin
  if not v_self and not internal.is_entry_decider(v_me, v_ts.user_id) then
    raise exception 'not_the_manager' using errcode = '42501';
  end if;
  if length(v_reason) not between 1 and 500 then
    raise exception 'invalid_reason' using errcode = '22023';
  end if;
  if v_ts.status <> 'approved' then
    raise exception 'not_approved' using errcode = '55000';
  end if;

  update public.timesheets
  set status = case when v_self then 'draft' else 'submitted' end,
      submitted_at = case when v_self then null else submitted_at end,
      approver_id = null, approved_at = null
  where id = v_ts.id;
  perform internal.mark_week_dirty(v_ts.user_id, v_ts.period_start);

  perform internal.audit(v_ts.org_id, v_me.id, 'timesheet.reopened', v_ts.user_id,
    jsonb_build_object('timesheet_id', v_ts.id, 'period_start', v_ts.period_start,
      'reason', v_reason, 'approved_by', v_ts.approver_id, 'own_week', v_self));
  if not v_self then
    perform internal.notify(v_ts.org_id, v_ts.user_id, 'timesheet.reopened',
      jsonb_build_object('timesheet_id', v_ts.id, 'period_start', v_ts.period_start,
        'reason', v_reason, 'by', v_me.id));
  end if;
end;
$$;

-- What the dashboard asks before showing Reopen on a person's approved week: the
-- employee's direct manager or active delegate, or the owner on their own week.
create function public.can_reopen_timesheet(target uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select auth.uid() is not null and (
    public.can_decide_timesheet(target)
    or (
      auth.uid() = target and exists (
        select 1 from public.users u
        where u.id = target and u.active and u.role = 'owner' and u.manager_id is null
          and u.org_id = internal.jwt_org_id()
      )
    )
  );
$$;

revoke all on function public.can_reopen_timesheet(uuid) from public, anon;
grant execute on function public.can_reopen_timesheet(uuid) to authenticated;
