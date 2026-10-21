-- #147: delegation clean-up and history (TS-14, ORG-07, AUD-01).
--
-- A manager or delegate who is deactivated, or made an employee, can no longer act on a
-- delegation (internal.is_active_delegate already refuses them), but the row would stay
-- live, listed as current and blocking the manager's dates. Now deactivating them (set_user_active)
-- or demoting them to employee (update_member) ends every live delegation they are part
-- of, as the manager or as the delegate, in the same transaction: ended_at is set, the
-- end is audit-logged (delegation.ended with the reason 'deactivated' or 'demoted', by the
-- admin who did it) and the other side is told. "Live" is not ended and not over in the
-- manager's local today, so an upcoming delegation is cancelled too. This is done inside
-- those two RPCs rather than in a trigger on users: they know the acting admin (the audit
-- actor), the reason, and the one place each change happens, and a trigger could not tell
-- who did it.
--
-- Admins: set_delegation / end_delegation already work for any manager; the candidates list
-- now takes the manager so an admin gets the right people. delegation_history lists
-- upcoming, current, completed and ended delegations of one person (the caller, or any
-- member for an owner or admin), with who ended them and why.

alter table public.delegations
  add column end_reason text check (end_reason in ('manual', 'deactivated', 'demoted'));

-- Ending ---------------------------------------------------------------------------------

-- Ends every live delegation where p_user_id is the manager or the delegate, on behalf of
-- p_actor_id. Returns how many it ended. The caller has already checked who may do this.
create function internal.end_delegations_of(
  p_org_id uuid,
  p_actor_id uuid,
  p_user_id uuid,
  p_reason text
)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_d record;
  v_name text;
  v_count int := 0;
begin
  select u.full_name into v_name from public.users u where u.id = p_user_id;
  for v_d in
    select d.id, d.manager_id, d.delegate_id, d.starts_on, d.ends_on
    from public.delegations d
    join public.users m on m.id = d.manager_id
    where d.org_id = p_org_id
      and (d.manager_id = p_user_id or d.delegate_id = p_user_id)
      and d.ended_at is null
      and d.ends_on >= (now() at time zone m.timezone)::date
    order by d.starts_on, d.id
    for update of d
  loop
    update public.delegations set ended_at = now(), end_reason = p_reason where id = v_d.id;

    perform internal.audit(p_org_id, p_actor_id, 'delegation.ended', v_d.manager_id,
      jsonb_build_object('delegation_id', v_d.id, 'delegate_id', v_d.delegate_id,
        'starts_on', v_d.starts_on, 'ends_on', v_d.ends_on, 'reason', p_reason));
    -- The other side: the delegate when the manager went, the manager when the delegate did.
    perform internal.notify(p_org_id,
      case when v_d.manager_id = p_user_id then v_d.delegate_id else v_d.manager_id end,
      'delegation.ended',
      jsonb_build_object('delegation_id', v_d.id, 'manager_id', v_d.manager_id,
        'delegate_id', v_d.delegate_id, 'starts_on', v_d.starts_on, 'ends_on', v_d.ends_on,
        'reason', p_reason,
        'for', case when v_d.manager_id = p_user_id then 'delegate' else 'manager' end,
        'name', v_name));
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

revoke all on function internal.end_delegations_of(uuid, uuid, uuid, text)
  from public, anon, authenticated;

-- TS-14: a manager (or an owner or admin) ends a delegation now; records that it was done by
-- hand (end_reason 'manual').
-- (Latest definition before this: delegation.)
create or replace function public.end_delegation(p_id uuid)
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

  update public.delegations set ended_at = now(), end_reason = 'manual' where id = v_d.id;

  perform internal.audit(v_d.org_id, v_me.id, 'delegation.ended', v_d.manager_id,
    jsonb_build_object('delegation_id', v_d.id, 'delegate_id', v_d.delegate_id,
      'starts_on', v_d.starts_on, 'ends_on', v_d.ends_on));
  perform internal.notify(v_d.org_id, v_d.delegate_id, 'delegation.ended',
    jsonb_build_object('delegation_id', v_d.id, 'manager_id', v_d.manager_id,
      'starts_on', v_d.starts_on, 'ends_on', v_d.ends_on));
end;
$$;

-- ORG-07: deactivating a user revokes their devices, ends their sessions and (#147) ends their
-- live delegations. Audited.
-- (Latest definition before this: org_members_and_audit.)
create or replace function public.set_user_active(p_user_id uuid, p_active boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  target public.users;
  me public.users;
begin
  select * into target from public.users where id = p_user_id;
  if not found then
    raise exception 'user_not_found' using errcode = '42501';
  end if;
  me := internal.require_org_admin(target.org_id);
  if target.id = me.id then
    raise exception 'cannot_change_self' using errcode = '42501';
  end if;
  if target.role = 'owner' and me.role <> 'owner' then
    raise exception 'owner_only' using errcode = '42501';
  end if;

  update public.users set active = p_active where id = p_user_id;
  if not p_active then
    update public.devices set revoked_at = now() where user_id = p_user_id and revoked_at is null;
    perform internal.end_sessions(array(select s.id from auth.sessions s where s.user_id = p_user_id));
    delete from public.device_sessions where user_id = p_user_id;
    perform internal.end_delegations_of(target.org_id, me.id, target.id, 'deactivated');
  end if;
  if p_active is distinct from target.active then
    perform internal.audit(target.org_id, me.id,
      case when p_active then 'member.reactivated' else 'member.deactivated' end, target.id);
  end if;
end;
$$;

-- ORG-03..06: name, role, direct manager, work location and time zone of a member. Made an
-- employee, a person's live delegations end (#147): nothing to approve for, nobody to
-- approve as. (Latest definition before this: delegation.)
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
    if p_role = 'employee' then
      perform internal.end_delegations_of(v_target.org_id, v_me.id, v_target.id, 'demoted');
    end if;
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

-- Reading ---------------------------------------------------------------------------------

-- Who the caller may name as a delegate for p_manager_id (default: themselves): the active
-- owners, admins and managers of the org, other than that manager. For someone else's
-- delegation the caller must be an owner or admin. Employees get nothing.
-- (Replaces delegation's no-argument version, which is dropped.)
drop function public.delegate_candidates();
create function public.delegate_candidates(p_manager_id uuid default null)
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
    and (p_manager_id is null or p_manager_id = me.id or me.role in ('owner', 'admin'))
    and u.org_id = me.org_id and u.org_id = internal.jwt_org_id()
    and u.active and u.role <> 'employee' and u.id <> coalesce(p_manager_id, me.id)
  order by u.full_name, u.id;
$$;

-- The delegations a person is part of, newest first, upcoming, current, completed and ended
-- early alike, with names (a manager may not be able to read a peer's row). p_manager_id
-- defaults to the caller; for anyone else the caller must be an owner or admin of the same
-- org. Both sides are listed: those the person gave as manager and those they received as
-- delegate. status: 'upcoming' / 'active' / 'completed' (ran its course) / 'ended' (ended
-- early, see ended_at and end_reason), judged on the manager's local today. end_reason is
-- null for ones ended before it was recorded.
create function public.delegation_history(p_manager_id uuid default null)
returns table (
  id uuid,
  manager_id uuid,
  manager_name text,
  delegate_id uuid,
  delegate_name text,
  starts_on date,
  ends_on date,
  status text,
  ended_at timestamptz,
  end_reason text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_me public.users := internal.current_app_user();
  v_who uuid := coalesce(p_manager_id, v_me.id);
begin
  if v_who <> v_me.id and v_me.role not in ('owner', 'admin') then
    raise exception 'not_allowed' using errcode = '42501';
  end if;
  if not exists (select 1 from public.users u where u.id = v_who and u.org_id = v_me.org_id) then
    raise exception 'manager_not_found' using errcode = '42501';
  end if;
  return query
  select d.id, d.manager_id, m.full_name, d.delegate_id, g.full_name, d.starts_on, d.ends_on,
    case
      when d.ended_at is not null then 'ended'
      when d.ends_on < (now() at time zone m.timezone)::date then 'completed'
      when d.starts_on > (now() at time zone m.timezone)::date then 'upcoming'
      else 'active'
    end,
    d.ended_at, d.end_reason
  from public.delegations d
  join public.users m on m.id = d.manager_id
  join public.users g on g.id = d.delegate_id
  where d.org_id = v_me.org_id
    and (d.manager_id = v_who or d.delegate_id = v_who)
  order by d.starts_on desc, d.created_at desc, d.id;
end;
$$;

revoke all on function public.delegate_candidates(uuid) from public, anon;
revoke all on function public.delegation_history(uuid) from public, anon;
grant execute on function public.delegate_candidates(uuid) to authenticated;
grant execute on function public.delegation_history(uuid) to authenticated;
