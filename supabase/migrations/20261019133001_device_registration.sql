-- Device registration, revocation and deactivation (#17; AGT-02, ORG-07, NFR-SEC-03).
--
-- The agent signs in (#16), then calls register_device, which binds the device to
-- the caller and to the caller's Auth session. The access-token hook then puts
-- `device_id` into every JWT minted for that session, and refuses to mint one for a
-- deactivated user or a revoked device, so revocation also ends token refresh.
-- Agent RPCs check the device on every call (internal.require_active_device), so a
-- revoked agent stops at its next heartbeat (≤ 60 s).

-- Which Auth session belongs to which device.
create table public.device_sessions (
  session_id uuid primary key,
  device_id uuid not null references public.devices (id) on delete cascade,
  user_id uuid not null references public.users (id) on delete cascade,
  org_id uuid not null references public.orgs (id) on delete cascade,
  created_at timestamptz not null default now()
);

create index device_sessions_device_id_idx on public.device_sessions (device_id);
alter table public.device_sessions enable row level security;

-- Helpers (not exposed through the API) ---------------------------------------

-- The caller's users row; raises unless signed in, provisioned and active.
create function internal.current_app_user()
returns public.users
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  me public.users;
begin
  if auth.uid() is null then
    raise exception 'not_signed_in' using errcode = '42501';
  end if;
  select * into me from public.users where id = auth.uid();
  if not found then
    raise exception 'user_not_provisioned' using errcode = '42501';
  end if;
  if not me.active then
    raise exception 'user_inactive' using errcode = '42501';
  end if;
  return me;
end;
$$;

-- Every agent RPC starts with this: the device must belong to the active caller,
-- not be revoked, and match the token's device_id claim when the token has one.
create function internal.require_active_device(p_device_id uuid)
returns public.devices
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  me public.users := internal.current_app_user();
  device public.devices;
  claimed text := auth.jwt() ->> 'device_id';
begin
  select * into device from public.devices where id = p_device_id and user_id = me.id;
  if not found then
    raise exception 'device_not_found' using errcode = '42501';
  end if;
  if device.revoked_at is not null then
    raise exception 'device_revoked' using errcode = '42501';
  end if;
  if claimed is not null and claimed <> p_device_id::text then
    raise exception 'device_mismatch' using errcode = '42501';
  end if;
  return device;
end;
$$;

-- Deletes Auth sessions (and with them their refresh tokens) so the agent cannot
-- refresh; called on revocation and deactivation.
create function internal.end_sessions(p_session_ids uuid[])
returns void
language sql
security definer
set search_path = ''
as $$
  delete from auth.sessions where id = any (p_session_ids);
$$;

-- The caller must be an active owner or admin of `p_org_id`.
create function internal.require_org_admin(p_org_id uuid)
returns public.users
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  me public.users := internal.current_app_user();
begin
  if me.org_id <> p_org_id or me.role not in ('owner', 'admin') then
    raise exception 'admin_only' using errcode = '42501';
  end if;
  return me;
end;
$$;

revoke all on function internal.current_app_user() from public, anon, authenticated;
revoke all on function internal.require_active_device(uuid) from public, anon, authenticated;
revoke all on function internal.end_sessions(uuid[]) from public, anon, authenticated;
revoke all on function internal.require_org_admin(uuid) from public, anon, authenticated;

-- Agent RPC -------------------------------------------------------------------

-- Registers this install for the signed-in user (idempotent per user + hardware
-- hash) and binds the current Auth session to it. Returns the org policy so the
-- agent can start with the right settings.
create function public.register_device(
  platform public.device_platform,
  os_version text,
  agent_version text,
  hardware_hash text,
  out device_id uuid,
  out policy jsonb,
  out policy_version int
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  me public.users := internal.current_app_user();
  v_session_id uuid := nullif(auth.jwt() ->> 'session_id', '')::uuid;
begin
  if length(coalesce(os_version, '')) not between 1 and 64
    or length(coalesce(agent_version, '')) not between 1 and 64
    or length(coalesce(hardware_hash, '')) not between 8 and 128 then
    raise exception 'invalid_device_info' using errcode = '22023';
  end if;

  select d.id into device_id
  from public.devices d
  where d.user_id = me.id and d.hardware_hash = register_device.hardware_hash and d.revoked_at is null;

  if device_id is null then
    insert into public.devices (org_id, user_id, platform, os_version, agent_version, hardware_hash)
    values (me.org_id, me.id, register_device.platform, register_device.os_version,
            register_device.agent_version, register_device.hardware_hash)
    returning id into device_id;
  else
    update public.devices d
    set platform = register_device.platform,
        os_version = register_device.os_version,
        agent_version = register_device.agent_version
    where d.id = device_id;
  end if;

  if v_session_id is not null then
    insert into public.device_sessions (session_id, device_id, user_id, org_id)
    values (v_session_id, device_id, me.id, me.org_id)
    on conflict on constraint device_sessions_pkey
    do update set device_id = excluded.device_id;
  end if;

  select o.policy, o.policy_version into policy, policy_version
  from public.orgs o where o.id = me.org_id;
end;
$$;

-- Admin RPCs ------------------------------------------------------------------

-- Revokes one device. Its sessions end now; its next agent RPC is rejected.
create function public.revoke_device(p_device_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  device public.devices;
begin
  select * into device from public.devices where id = p_device_id;
  if not found then
    raise exception 'device_not_found' using errcode = '42501';
  end if;
  perform internal.require_org_admin(device.org_id);

  update public.devices set revoked_at = coalesce(revoked_at, now()) where id = p_device_id;
  perform internal.end_sessions(array(
    select ds.session_id from public.device_sessions ds where ds.device_id = p_device_id
  ));
  delete from public.device_sessions where device_id = p_device_id;
end;
$$;

-- ORG-07: deactivating a user revokes all their devices and ends all their
-- sessions; their data is kept (retention handles it). Reactivating lets them sign
-- in again; the agent registers a new device.
create function public.set_user_active(p_user_id uuid, p_active boolean)
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
end;
$$;

revoke all on function public.register_device(public.device_platform, text, text, text) from public, anon;
revoke all on function public.revoke_device(uuid) from public, anon;
revoke all on function public.set_user_active(uuid, boolean) from public, anon;
grant execute on function public.register_device(public.device_platform, text, text, text) to authenticated;
grant execute on function public.revoke_device(uuid) to authenticated;
grant execute on function public.set_user_active(uuid, boolean) to authenticated;

-- Auth access-token hook ------------------------------------------------------

-- Runs every time Auth mints an access token (sign-in and refresh). Adds the
-- session's device_id, and refuses tokens for deactivated users and revoked devices.
create function internal.custom_access_token_hook(event jsonb)
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
  v_user_active boolean;
  v_device public.devices;
begin
  select u.active into v_user_active from public.users u where u.id = v_user_id;
  -- No users row yet (an invitee mid-onboarding) is allowed; inactive is not.
  if v_user_active is false then
    return jsonb_build_object('error', jsonb_build_object('http_code', 403, 'message', 'user_inactive'));
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

grant usage on schema internal to supabase_auth_admin;
grant execute on function internal.custom_access_token_hook(jsonb) to supabase_auth_admin;
revoke all on function internal.custom_access_token_hook(jsonb) from public, anon, authenticated;
