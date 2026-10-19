-- #28: org members (ORG-03..06) and the audit log (AUD-01).
--
-- Admins invite people through the `invite-users` Edge Function (Auth's invite
-- email needs the service role); it calls add_invited_member. Role, reporting
-- line and work location changes go through update_member. Every change is
-- written to audit_log, which nobody can edit.

-- Audit log ----------------------------------------------------------------------------

create table public.audit_log (
  id bigint generated always as identity primary key,
  org_id uuid not null references public.orgs (id) on delete cascade,
  actor_id uuid references public.users (id) on delete set null,
  -- e.g. member.invited, member.role_changed, member.manager_changed
  action text not null check (action ~ '^[a-z_]+\.[a-z_]+$'),
  target_user_id uuid references public.users (id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  at timestamptz not null default now()
);

create index audit_log_org_at_idx on public.audit_log (org_id, at desc);
create index audit_log_target_idx on public.audit_log (target_user_id, at desc);
alter table public.audit_log enable row level security;

-- Owners and admins read their org's log (with MFA when the org requires it, as
-- for everything org-wide). No insert/update/delete policies: only the functions
-- below write, and only by appending.
create policy "Org admins read the audit log"
on public.audit_log for select to authenticated
using (
  org_id = (select internal.jwt_org_id())
  and exists (
    select 1 from public.users me
    join public.orgs o on o.id = me.org_id
    where me.id = (select auth.uid()) and me.active and me.org_id = audit_log.org_id
      and me.role in ('owner', 'admin')
      and (not coalesce((o.policy ->> 'require_admin_mfa')::boolean, false)
           or coalesce((select auth.jwt() ->> 'aal'), '') = 'aal2')
  )
);

create function internal.audit_log_is_append_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'audit_log_is_append_only' using errcode = '42501';
end;
$$;

create trigger audit_log_no_update
before update on public.audit_log
for each row execute function internal.audit_log_is_append_only();

create function internal.audit(
  p_org_id uuid,
  p_actor_id uuid,
  p_action text,
  p_target_user_id uuid,
  p_metadata jsonb default '{}'::jsonb
)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.audit_log (org_id, actor_id, action, target_user_id, metadata)
  values (p_org_id, p_actor_id, p_action, p_target_user_id, coalesce(p_metadata, '{}'::jsonb));
$$;

revoke all on function internal.audit_log_is_append_only() from public, anon, authenticated;
revoke all on function internal.audit(uuid, uuid, text, uuid, jsonb) from public, anon, authenticated;

-- Member rules -----------------------------------------------------------------------

-- ORG-05/06 checks shared by invite and update. Raises on the first problem.
create function internal.check_member(
  p_org_id uuid,
  p_user_id uuid,
  p_role public.user_role,
  p_manager_id uuid,
  p_work_country text,
  p_work_state text,
  p_timezone text
)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_manager public.users;
  v_up uuid;
  v_steps int := 0;
begin
  if p_work_country is null or p_work_country !~ '^[A-Z]{2}$' then
    raise exception 'invalid_country' using errcode = '22023';
  end if;
  -- State matters for US law (e.g. Illinois, CAP-07); only US has one.
  if p_work_country = 'US' and (p_work_state is null or p_work_state !~ '^[A-Z]{2}$') then
    raise exception 'us_state_required' using errcode = '22023';
  end if;
  if p_work_country <> 'US' and p_work_state is not null then
    raise exception 'state_only_for_us' using errcode = '22023';
  end if;
  if not exists (select 1 from pg_timezone_names where name = p_timezone) then
    raise exception 'invalid_timezone' using errcode = '22023';
  end if;

  -- ORG-05: everyone but the owner has exactly one direct manager.
  if p_role = 'owner' then
    return;
  end if;
  if p_manager_id is null then
    raise exception 'manager_required' using errcode = '22023';
  end if;
  if p_manager_id = p_user_id then
    raise exception 'cannot_manage_self' using errcode = '22023';
  end if;
  select * into v_manager from public.users where id = p_manager_id;
  if not found or v_manager.org_id <> p_org_id or not v_manager.active then
    raise exception 'manager_not_found' using errcode = '22023';
  end if;
  if v_manager.role = 'employee' then
    raise exception 'manager_must_be_manager_or_admin' using errcode = '22023';
  end if;
  -- No loops: walking up from the new manager must not reach this person.
  v_up := v_manager.manager_id;
  while v_up is not null and v_steps < 1000 loop
    if v_up = p_user_id then
      raise exception 'reporting_loop' using errcode = '22023';
    end if;
    select manager_id into v_up from public.users where id = v_up;
    v_steps := v_steps + 1;
  end loop;
end;
$$;

revoke all on function internal.check_member(uuid, uuid, public.user_role, uuid, text, text, text)
  from public, anon, authenticated;

-- Invite (service role only, from the invite-users Edge Function) -----------------------

-- Adds the users row for an Auth user the Edge Function just invited. The inviter
-- is checked again here: an active owner or admin of the org. With a null
-- p_user_id it only checks, so the function can refuse before any email goes out.
create function public.add_invited_member(
  p_inviter_id uuid,
  p_user_id uuid,
  p_email text,
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
  v_inviter public.users;
begin
  select * into v_inviter from public.users where id = p_inviter_id;
  if not found or not v_inviter.active or v_inviter.role not in ('owner', 'admin') then
    raise exception 'admin_only' using errcode = '42501';
  end if;
  if p_role = 'owner' then
    raise exception 'cannot_invite_owner' using errcode = '22023';
  end if;
  if length(trim(coalesce(p_full_name, ''))) not between 1 and 120 then
    raise exception 'invalid_name' using errcode = '22023';
  end if;
  if exists (select 1 from public.users where id = p_user_id or email = lower(trim(p_email))) then
    raise exception 'already_a_member' using errcode = '23505';
  end if;
  perform internal.check_member(v_inviter.org_id, p_user_id, p_role, p_manager_id,
    p_work_country, p_work_state, p_timezone);
  if p_user_id is null then
    return;
  end if;

  insert into public.users (id, org_id, full_name, email, role, manager_id, work_country,
    work_state, timezone)
  values (p_user_id, v_inviter.org_id, trim(p_full_name), lower(trim(p_email)), p_role,
    p_manager_id, p_work_country, p_work_state, p_timezone);
  insert into public.presence (user_id, org_id) values (p_user_id, v_inviter.org_id)
  on conflict (user_id) do nothing;
  perform internal.audit(v_inviter.org_id, v_inviter.id, 'member.invited', p_user_id,
    jsonb_build_object('role', p_role, 'manager_id', p_manager_id));
end;
$$;

revoke all on function public.add_invited_member(uuid, uuid, text, text, public.user_role, uuid, text, text, text)
  from public, anon, authenticated;
grant execute on function public.add_invited_member(uuid, uuid, text, text, public.user_role, uuid, text, text, text)
  to service_role;

-- Update (admins, from the dashboard) ----------------------------------------------------

-- ORG-03..06: name, role, direct manager, work location and time zone of a member.
-- Ownership can't be given away here, and nobody changes their own role.
create function public.update_member(
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
  end if;
  if (p_work_country, p_work_state) is distinct from (v_target.work_country, v_target.work_state) then
    perform internal.audit(v_target.org_id, v_me.id, 'member.location_changed', v_target.id,
      jsonb_build_object(
        'from', jsonb_build_object('country', v_target.work_country, 'state', v_target.work_state),
        'to', jsonb_build_object('country', p_work_country, 'state', p_work_state)));
  end if;
end;
$$;

revoke all on function public.update_member(uuid, text, public.user_role, uuid, text, text, text)
  from public, anon;
grant execute on function public.update_member(uuid, text, public.user_role, uuid, text, text, text)
  to authenticated;

-- Deactivation (#17) is audited too (replaces #17's version).
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
  end if;
  if p_active is distinct from target.active then
    perform internal.audit(target.org_id, me.id,
      case when p_active then 'member.reactivated' else 'member.deactivated' end, target.id);
  end if;
end;
$$;
