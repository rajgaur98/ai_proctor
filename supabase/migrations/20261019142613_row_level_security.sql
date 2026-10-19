-- Row-level security (#31; NFR-SEC-04, TS-12). LLD section 07.
--
-- Reads go straight to tables through RLS; writes only through SECURITY DEFINER
-- functions, so every policy here is SELECT-only. Every policy starts from the
-- org_id in the caller's JWT (added by the access-token hook) and then asks
-- can_view_user(), which backs every read policy and the capture-url check:
--   same org → self → owner/admin (view only) → direct manager → active delegate.
-- There is no skip-level access. Approval uses can_approve_for(), which leaves
-- owners and admins out (TS-12).

-- Delegations (set by set_delegation, #44) ------------------------------------------

create table public.delegations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  manager_id uuid not null references public.users (id) on delete cascade,
  delegate_id uuid not null references public.users (id) on delete cascade,
  starts_on date not null,
  ends_on date not null,
  created_at timestamptz not null default now(),
  constraint delegations_dates check (ends_on >= starts_on and ends_on - starts_on <= 90),
  constraint delegations_not_self check (delegate_id <> manager_id)
);

create index delegations_manager_idx on public.delegations (manager_id, starts_on, ends_on);
create index delegations_delegate_idx on public.delegations (delegate_id);
alter table public.delegations enable row level security;

-- Claims ---------------------------------------------------------------------------

-- The org in the caller's JWT; null for tokens minted before the hook added it,
-- which then see nothing until they refresh.
create function internal.jwt_org_id()
returns uuid
language sql
stable
set search_path = ''
as $$
  select nullif(auth.jwt() ->> 'org_id', '')::uuid;
$$;

revoke all on function internal.jwt_org_id() from public, anon, authenticated;
grant execute on function internal.jwt_org_id() to authenticated;

-- Access checks --------------------------------------------------------------------

create function public.can_view_user(target uuid)
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
      and (
        viewer.id = employee.id
        or viewer.role in ('owner', 'admin')
        or employee.manager_id = viewer.id
        or exists (
          select 1 from public.delegations d
          where d.manager_id = employee.manager_id
            and d.delegate_id = viewer.id
            and current_date between d.starts_on and d.ends_on
        )
      )
  );
$$;

-- TS-12: only the direct manager or their active delegate approves; owners and
-- admins never do.
create function public.can_approve_for(target uuid)
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
        or exists (
          select 1 from public.delegations d
          where d.manager_id = employee.manager_id
            and d.delegate_id = viewer.id
            and current_date between d.starts_on and d.ends_on
        )
      )
  );
$$;

revoke all on function public.can_view_user(uuid) from public, anon;
revoke all on function public.can_approve_for(uuid) from public, anon;
grant execute on function public.can_view_user(uuid) to authenticated;
grant execute on function public.can_approve_for(uuid) to authenticated;

-- Policies -------------------------------------------------------------------------

create policy "Members read their own org"
on public.orgs for select to authenticated
using (id = (select internal.jwt_org_id()));

create policy "Users visible per can_view_user"
on public.users for select to authenticated
using (org_id = (select internal.jwt_org_id()) and public.can_view_user(id));

create policy "Delegations visible to both sides and admins"
on public.delegations for select to authenticated
using (
  org_id = (select internal.jwt_org_id())
  and (manager_id = (select auth.uid()) or delegate_id = (select auth.uid())
       or public.can_view_user(manager_id) and exists (
         select 1 from public.users me where me.id = (select auth.uid()) and me.role in ('owner', 'admin')))
);

-- Per-employee tables: same org, then can_view_user(user_id).
do $$
declare
  t text;
begin
  foreach t in array array[
    'devices', 'shifts', 'agent_events_raw', 'checkin_events', 'presence', 'last_seen',
    'clock_sessions', 'breaks', 'pauses'
  ] loop
    execute format(
      'create policy %I on public.%I for select to authenticated
       using (org_id = (select internal.jwt_org_id()) and public.can_view_user(user_id))',
      'Visible per can_view_user', t
    );
  end loop;
end;
$$;

-- device_sessions, agent_event_rejections, internal.* and partitions.* stay
-- without policies: no API role reads them.

-- Access-token hook: add org_id and the app role -----------------------------------

create or replace function internal.custom_access_token_hook(event jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_claims jsonb := event -> 'claims';
  v_user_id uuid := (event ->> 'user_id')::uuid;
  v_session_id uuid := nullif(event -> 'claims' ->> 'session_id', '')::uuid;
  v_user public.users;
  v_device public.devices;
begin
  select * into v_user from public.users u where u.id = v_user_id;
  -- No users row yet (an invitee mid-onboarding) is allowed; inactive is not.
  if found then
    if not v_user.active then
      return jsonb_build_object('error', jsonb_build_object('http_code', 403, 'message', 'user_inactive'));
    end if;
    v_claims := v_claims
      || jsonb_build_object('org_id', v_user.org_id::text, 'app_role', v_user.role::text);
  end if;

  select d.* into v_device
  from public.device_sessions ds
  join public.devices d on d.id = ds.device_id
  where ds.session_id = v_session_id;

  if found then
    if v_device.revoked_at is not null then
      return jsonb_build_object('error', jsonb_build_object('http_code', 403, 'message', 'device_revoked'));
    end if;
    v_claims := jsonb_set(v_claims, '{device_id}', to_jsonb(v_device.id::text));
  end if;

  return jsonb_build_object('claims', v_claims);
end;
$$;
