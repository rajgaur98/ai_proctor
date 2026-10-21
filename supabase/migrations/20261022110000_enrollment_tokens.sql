-- #86 (AGT-01, MDM part): org enrollment tokens for silent installs.
--
-- IT deploys the agent with Intune, Jamf or Kandji and hands it an org enrollment
-- token through MDM configuration (macOS managed preferences, Windows policy
-- registry; docs/deploy/mdm.md). The employee still signs in with a magic link
-- (#16); register_device then checks the token: it must be active and belong to the
-- signed-in person's org, so a managed computer only ever enrolls into its own org
-- and a token never moves anyone into another org.
--
-- Tokens are secrets: only their SHA-256 is stored, the token itself is returned
-- once, by create_enrollment_token. There is no RPC that takes a token before
-- sign-in, so an anonymous caller can't use or probe one.
--
-- Revoking a token stops new enrollments with it. Devices already enrolled keep
-- working (they are revoked one by one, as before).
--
-- Redefines public.register_device (from 20261019133001_device_registration.sql, the
-- only definition so far): one new optional argument, enrollment_token. The old
-- four-argument version is dropped so calls without the token resolve to this one.

create table public.enrollment_tokens (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  -- What the admin calls it, e.g. "Jamf: engineering Macs".
  label text not null check (length(label) between 1 and 80),
  -- SHA-256 of the whole token (`apet_` + 43 base64url characters).
  token_hash bytea not null unique check (length(token_hash) = 32),
  -- `apet_` and the first four characters, so admins can tell tokens apart.
  token_prefix text not null check (token_prefix ~ '^apet_[A-Za-z0-9_-]{4}$'),
  created_by uuid references public.users (id) on delete set null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoked_by uuid references public.users (id) on delete set null,
  -- The last enrollment with this token.
  last_used_at timestamptz
);

create index enrollment_tokens_org_idx on public.enrollment_tokens (org_id, created_at desc);
-- No policies: nobody reads or writes the table through the API; the RPCs below do.
alter table public.enrollment_tokens enable row level security;
revoke all on public.enrollment_tokens from anon, authenticated;

-- Which token enrolled a device (null for a manual install). Kept when the token is
-- revoked; cleared only if the token row is deleted with its org.
alter table public.devices
  add column enrollment_token_id uuid references public.enrollment_tokens (id) on delete set null;
create index devices_enrollment_token_idx on public.devices (enrollment_token_id)
  where enrollment_token_id is not null;

-- Helpers ---------------------------------------------------------------------------

-- The token's hash, or null when it isn't shaped like one of ours (so a typo in an MDM
-- profile and a made-up string get the same answer).
create function internal.enrollment_token_hash(p_token text)
returns bytea
language sql
immutable
set search_path = ''
as $$
  select case
    when p_token ~ '^apet_[A-Za-z0-9_-]{43}$'
      then extensions.digest(convert_to(p_token, 'UTF8'), 'sha256')
  end;
$$;

revoke all on function internal.enrollment_token_hash(text) from public, anon, authenticated;

-- Admin RPCs (owners and admins, with MFA when the org requires it) --------------------

-- Creates a token and returns it. This is the only time the token exists outside the
-- MDM profile: the database keeps its hash.
create function public.create_enrollment_token(p_label text)
returns table (id uuid, label text, token text, token_prefix text, created_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me public.users := internal.require_audit_reader();
  v_label text := trim(coalesce(p_label, ''));
  v_token text;
  v_row public.enrollment_tokens;
begin
  if length(v_label) not between 1 and 80 then
    raise exception 'invalid_label' using errcode = '22023';
  end if;
  -- 32 random bytes as base64url without padding: 43 characters.
  v_token := 'apet_' || translate(encode(extensions.gen_random_bytes(32), 'base64'), '+/=', '-_');

  insert into public.enrollment_tokens (org_id, label, token_hash, token_prefix, created_by)
  values (v_me.org_id, v_label, internal.enrollment_token_hash(v_token), left(v_token, 9), v_me.id)
  returning * into v_row;

  perform internal.audit(v_me.org_id, v_me.id, 'enrollment_token.created', null,
    jsonb_build_object('token_id', v_row.id, 'label', v_row.label, 'prefix', v_row.token_prefix));

  return query select v_row.id, v_row.label, v_token, v_row.token_prefix, v_row.created_at;
end;
$$;

-- Stops new enrollments with the token. Devices it already enrolled are untouched.
create function public.revoke_enrollment_token(p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me public.users := internal.require_audit_reader();
  v_row public.enrollment_tokens;
begin
  select * into v_row from public.enrollment_tokens t
  where t.id = p_id and t.org_id = v_me.org_id
  for update;
  if not found then
    raise exception 'token_not_found' using errcode = '42501';
  end if;
  if v_row.revoked_at is not null then
    return;
  end if;

  update public.enrollment_tokens set revoked_at = now(), revoked_by = v_me.id where id = p_id;
  perform internal.audit(v_me.org_id, v_me.id, 'enrollment_token.revoked', null,
    jsonb_build_object('token_id', v_row.id, 'label', v_row.label, 'prefix', v_row.token_prefix));
end;
$$;

-- The org's tokens, newest first, without their hashes. `devices` counts the devices
-- each one enrolled that are still in use.
create function public.list_enrollment_tokens()
returns table (
  id uuid,
  label text,
  token_prefix text,
  created_at timestamptz,
  created_by_name text,
  revoked_at timestamptz,
  last_used_at timestamptz,
  devices int
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_me public.users := internal.require_audit_reader();
begin
  return query
  select t.id, t.label, t.token_prefix, t.created_at, u.full_name, t.revoked_at, t.last_used_at,
         (select count(*)::int from public.devices d
          where d.enrollment_token_id = t.id and d.revoked_at is null)
  from public.enrollment_tokens t
  left join public.users u on u.id = t.created_by
  where t.org_id = v_me.org_id
  order by t.created_at desc, t.id;
end;
$$;

revoke all on function public.create_enrollment_token(text) from public, anon;
revoke all on function public.revoke_enrollment_token(uuid) from public, anon;
revoke all on function public.list_enrollment_tokens() from public, anon;
grant execute on function public.create_enrollment_token(text) to authenticated;
grant execute on function public.revoke_enrollment_token(uuid) to authenticated;
grant execute on function public.list_enrollment_tokens() to authenticated;

-- register_device, now with the enrollment token --------------------------------------

drop function public.register_device(public.device_platform, text, text, text);

-- Registers this install for the signed-in user (idempotent per user + hardware
-- hash) and binds the current Auth session to it. Returns the org policy so the
-- agent can start with the right settings.
--
-- #86: a managed install passes the token from its MDM configuration. It must be one
-- of ours and belong to the caller's org (enrollment_org_mismatch otherwise, whatever
-- state it is in). A new device also needs it unrevoked (enrollment_token_revoked);
-- a device that is already registered keeps working with a revoked token. The first
-- registration with a token links the device to it and is audit-logged.
create function public.register_device(
  platform public.device_platform,
  os_version text,
  agent_version text,
  hardware_hash text,
  enrollment_token text default null,
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
  v_token_given boolean := nullif(trim(coalesce(register_device.enrollment_token, '')), '') is not null;
  v_token public.enrollment_tokens;
  v_linked uuid;
  -- This call links the device to the token (its enrollment).
  v_enrolls boolean := false;
begin
  if length(coalesce(os_version, '')) not between 1 and 64
    or length(coalesce(agent_version, '')) not between 1 and 64
    or length(coalesce(hardware_hash, '')) not between 8 and 128 then
    raise exception 'invalid_device_info' using errcode = '22023';
  end if;

  if v_token_given then
    select * into v_token from public.enrollment_tokens t
    where t.token_hash = internal.enrollment_token_hash(trim(register_device.enrollment_token));
    if not found then
      raise exception 'enrollment_token_invalid' using errcode = '42501';
    end if;
    if v_token.org_id <> me.org_id then
      raise exception 'enrollment_org_mismatch' using errcode = '42501';
    end if;
  end if;

  select d.id, d.enrollment_token_id into device_id, v_linked
  from public.devices d
  where d.user_id = me.id and d.hardware_hash = register_device.hardware_hash and d.revoked_at is null;

  if device_id is null then
    if v_token_given and v_token.revoked_at is not null then
      raise exception 'enrollment_token_revoked' using errcode = '42501';
    end if;
    v_enrolls := v_token_given;
    insert into public.devices (org_id, user_id, platform, os_version, agent_version, hardware_hash,
                                enrollment_token_id)
    values (me.org_id, me.id, register_device.platform, register_device.os_version,
            register_device.agent_version, register_device.hardware_hash,
            case when v_token_given then v_token.id end)
    returning id into device_id;
  else
    -- A manual install that MDM took over later is linked on its next sign-in,
    -- while the token is active.
    v_enrolls := v_token_given and v_linked is null and v_token.revoked_at is null;
    update public.devices d
    set platform = register_device.platform,
        os_version = register_device.os_version,
        agent_version = register_device.agent_version,
        enrollment_token_id = case when v_enrolls then v_token.id else d.enrollment_token_id end
    where d.id = device_id;
  end if;

  -- The enrollment itself (not every later sign-in) is the token's use.
  if v_enrolls then
    update public.enrollment_tokens set last_used_at = now() where id = v_token.id;
    perform internal.audit(me.org_id, me.id, 'enrollment_token.used', me.id,
      jsonb_build_object('token_id', v_token.id, 'label', v_token.label,
                         'prefix', v_token.token_prefix, 'device_id', device_id));
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

revoke all on function public.register_device(public.device_platform, text, text, text, text)
  from public, anon;
grant execute on function public.register_device(public.device_platform, text, text, text, text)
  to authenticated;
