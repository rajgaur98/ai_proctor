-- Status engine and offline sweep (#30; STS-02, STS-03, NFR-PERF-03).
--
-- presence.status is computed on the server from raw state, by the same priority
-- rules as packages/core/src/status.ts (shared vectors in
-- packages/core/vectors/status.json keep them identical). Every agent event and
-- heartbeat refreshes it; every change is also recorded in status_periods (the
-- day timeline, #33). offline_sweep runs every minute. A heartbeat that arrives
-- after an unexplained gap during clock-in records that gap as Tamper.

create extension if not exists pg_cron;

-- Raw per-user flags, kept up to date by events and heartbeats.
alter table public.presence
  add column locked boolean not null default false,
  add column idle boolean not null default false,
  add column call_sources text[] not null default '{}',
  add column permission_missing boolean not null default false,
  -- Last time the server heard from the agent (heartbeat or accepted event).
  add column last_contact_at timestamptz;

create table public.status_periods (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  user_id uuid not null references public.users (id) on delete cascade,
  status public.presence_status not null,
  start_at timestamptz not null,
  end_at timestamptz,
  constraint status_periods_end_after_start check (end_at is null or end_at >= start_at)
);

create index status_periods_user_start_idx on public.status_periods (user_id, start_at);
create unique index status_periods_one_open_idx on public.status_periods (user_id) where end_at is null;
alter table public.status_periods enable row level security;

create policy "Visible per can_view_user"
on public.status_periods for select to authenticated
using (org_id = (select internal.jwt_org_id()) and public.can_view_user(user_id));

-- Rules ------------------------------------------------------------------------------

-- Mirror of computeStatus() in packages/core/src/status.ts. Keep in step with the
-- shared vectors (supabase/tests/database/status_vectors.test.sql).
create function internal.compute_status(s jsonb)
returns public.presence_status
language sql
immutable
set search_path = ''
as $$
  select case
    when not coalesce((s ->> 'clocked_in')::boolean, false) then 'off_shift'
    when coalesce((s ->> 'tamper')::boolean, false) then 'tamper'
    when coalesce((s ->> 'offline')::boolean, false) then 'offline'
    when coalesce((s ->> 'on_break')::boolean, false) then 'on_break'
    when coalesce((s ->> 'paused')::boolean, false) then 'paused'
    when coalesce((s ->> 'locked')::boolean, false) then 'away_locked'
    when s ->> 'last_checkin' in ('miss', 'failed') then 'away'
    when coalesce((s ->> 'in_call')::boolean, false) then 'in_meeting'
    when coalesce((s ->> 'idle')::boolean, false) then 'idle'
    else 'active'
  end::public.presence_status;
$$;

-- No heartbeat or event for this long while clocked in = Offline (STS rule 3).
create function internal.offline_after() returns interval
language sql immutable set search_path = '' as $$ select interval '3 minutes' $$;

-- The status inputs for one user right now.
create function internal.status_input(p_user_id uuid, p_now timestamptz)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'clocked_in', (s).state <> 'off_shift',
    'tamper', p.permission_missing,
    'offline', coalesce(p.last_contact_at, '-infinity'::timestamptz) < p_now - internal.offline_after(),
    'on_break', (s).state = 'on_break',
    'paused', (s).state = 'paused',
    'locked', p.locked,
    'last_checkin', p.last_checkin_outcome,
    'in_call', cardinality(p.call_sources) > 0,
    'idle', p.idle
  )
  from public.presence p
  cross join lateral (select internal.shift_state(p_user_id) as s) st
  where p.user_id = p_user_id;
$$;

-- Recomputes presence.status; on a change, closes the open status period and opens
-- a new one at `p_at`.
create function internal.refresh_presence(p_user_id uuid, p_at timestamptz default now())
returns public.presence_status
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old public.presence_status;
  v_new public.presence_status;
  v_org uuid;
begin
  select status, org_id into v_old, v_org from public.presence where user_id = p_user_id for update;
  if not found then
    return null;
  end if;
  v_new := internal.compute_status(internal.status_input(p_user_id, now()));
  if v_new is distinct from v_old then
    update public.presence set status = v_new, since = p_at where user_id = p_user_id;
    update public.status_periods set end_at = greatest(start_at, p_at)
    where user_id = p_user_id and end_at is null;
    insert into public.status_periods (org_id, user_id, status, start_at)
    values (v_org, p_user_id, v_new, p_at);
  end if;
  return v_new;
end;
$$;

-- Event projection (replaces #23's version: adds the raw flags and the refresh) -------

create or replace function internal.apply_event(
  p_device public.devices,
  p_event_id uuid,
  p_type text,
  p_at timestamptz,
  p_payload jsonb
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  s internal.shift_state := internal.shift_state(p_device.user_id);
begin
  insert into public.presence (user_id, org_id) values (p_device.user_id, p_device.org_id)
  on conflict (user_id) do nothing;

  case p_type
  when 'clock_in' then
    if s.state <> 'off_shift' then return 'already_clocked_in'; end if;
    insert into public.clock_sessions (org_id, user_id, device_id, project_id, start_at, start_event_id)
    values (p_device.org_id, p_device.user_id, p_device.id,
            nullif(p_payload ->> 'project_id', '')::uuid, p_at, p_event_id);
    -- A new shift starts clean.
    update public.presence
    set project_id = nullif(p_payload ->> 'project_id', '')::uuid,
        locked = false, idle = false, call_sources = '{}', last_checkin_outcome = null
    where user_id = p_device.user_id;

  when 'clock_out' then
    if s.state = 'off_shift' then return 'not_clocked_in'; end if;
    update public.breaks set end_at = greatest(start_at, p_at) where id = s.break_id;
    update public.pauses set end_at = greatest(start_at, p_at) where id = s.pause_id;
    update public.clock_sessions
    set end_at = greatest(start_at, p_at), end_reason = p_payload ->> 'reason', end_event_id = p_event_id
    where id = s.clock_session_id;

  when 'break_start' then
    if s.state = 'off_shift' then return 'not_clocked_in'; end if;
    if s.state = 'on_break' then return 'already_on_break'; end if;
    if s.state = 'paused' then return 'paused'; end if;
    insert into public.breaks (org_id, user_id, clock_session_id, start_at, planned_min)
    values (p_device.org_id, p_device.user_id, s.clock_session_id, p_at,
            (p_payload ->> 'planned_min')::int);

  when 'break_end' then
    if s.state <> 'on_break' then return 'not_on_break'; end if;
    update public.breaks set end_at = greatest(start_at, p_at) where id = s.break_id;

  when 'pause_start' then
    if s.state = 'off_shift' then return 'not_clocked_in'; end if;
    if s.state = 'on_break' then return 'on_break'; end if;
    if s.state = 'paused' then return 'already_paused'; end if;
    insert into public.pauses (org_id, user_id, clock_session_id, start_at, planned_min)
    values (p_device.org_id, p_device.user_id, s.clock_session_id, p_at,
            (p_payload ->> 'planned_min')::int);

  when 'pause_end' then
    if s.state <> 'paused' then return 'not_paused'; end if;
    update public.pauses set end_at = greatest(start_at, p_at) where id = s.pause_id;

  when 'project_switch' then
    if s.state = 'off_shift' then return 'not_clocked_in'; end if;
    update public.presence set project_id = nullif(p_payload ->> 'project_id', '')::uuid
    where user_id = p_device.user_id;

  when 'checkin' then
    if s.state <> 'working' then return 'checkin_while_' || s.state; end if;
    begin
      insert into public.checkin_events (
        id, org_id, user_id, device_id, project_id, scheduled_at, shown_at, responded_at,
        outcome, response_ms, wrong_clicks, idle_s_at_show, device_state, object_keys,
        flags, capture_errors
      )
      values (
        p_event_id, p_device.org_id, p_device.user_id, p_device.id,
        nullif(p_payload ->> 'project_id', '')::uuid,
        (p_payload ->> 'scheduled_at')::timestamptz,
        (p_payload ->> 'shown_at')::timestamptz,
        (p_payload ->> 'responded_at')::timestamptz,
        (p_payload ->> 'outcome')::public.checkin_outcome,
        (p_payload ->> 'response_ms')::int,
        (p_payload ->> 'wrong_clicks')::int,
        (p_payload ->> 'idle_s_at_show')::int,
        p_payload ->> 'device_state',
        array(select jsonb_array_elements_text(p_payload -> 'object_keys')),
        array(select jsonb_array_elements_text(p_payload -> 'flags')),
        p_payload -> 'capture_errors'
      );
    exception when check_violation then
      return 'invalid_checkin';
    end;
    update public.presence
    set last_checkin_at = p_at, last_checkin_outcome = (p_payload ->> 'outcome')::public.checkin_outcome
    where user_id = p_device.user_id;

  when 'permission_change' then
    -- Tamper while a capture permission is missing (STS rule 2). Camera only
    -- counts when the org has the webcam on.
    update public.presence p
    set permission_missing = (p_payload ->> 'screen') <> 'granted'
      or ((p_payload ->> 'camera') <> 'granted'
          and coalesce((select (o.policy ->> 'webcam')::boolean from public.orgs o where o.id = p.org_id), true))
    where p.user_id = p_device.user_id;

  else
    if s.state = 'off_shift' then return 'not_clocked_in'; end if;
    case p_type
    when 'lock', 'sleep' then
      update public.presence set locked = true where user_id = p_device.user_id;
    when 'unlock', 'wake' then
      update public.presence set locked = false where user_id = p_device.user_id;
    when 'idle_start' then
      update public.presence set idle = true where user_id = p_device.user_id;
    when 'idle_end' then
      update public.presence set idle = false where user_id = p_device.user_id;
    when 'call_start' then
      update public.presence
      set call_sources = array(select distinct unnest(call_sources || array[p_payload ->> 'source']))
      where user_id = p_device.user_id;
    when 'call_end' then
      update public.presence set call_sources = array_remove(call_sources, p_payload ->> 'source')
      where user_id = p_device.user_id;
    else
      -- app_session: activity_sessions projection comes with #25.
      null;
    end case;
  end case;

  update public.presence set last_contact_at = now() where user_id = p_device.user_id;
  perform internal.refresh_presence(p_device.user_id, p_at);
  return null;
end;
$$;

-- Heartbeat (replaces #23's version: flags, heartbeat-gap Tamper, refresh) -----------

create or replace function public.agent_heartbeat(
  device_id uuid,
  sent_at timestamptz,
  idle_s int,
  locked boolean,
  in_call boolean,
  agent_version text,
  permissions jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_device public.devices := internal.require_active_device(agent_heartbeat.device_id);
  v_now timestamptz := now();
  v_prev timestamptz;
  v_was_locked boolean;
  v_idle_threshold int;
begin
  if idle_s < 0 or length(coalesce(agent_version, '')) not between 1 and 64 then
    raise exception 'invalid_heartbeat' using errcode = '22023';
  end if;

  insert into public.presence (user_id, org_id) values (v_device.user_id, v_device.org_id)
  on conflict (user_id) do nothing;
  select p.last_contact_at, p.locked into v_prev, v_was_locked
  from public.presence p where p.user_id = v_device.user_id;

  -- STS rule 2: the agent went silent during clock-in with nothing to explain it
  -- (no queued events from the gap, not locked or asleep) → it was killed or
  -- blocked. Offline work is not Tamper: its events arrive with times in the gap.
  if v_prev is not null
    and v_now - v_prev > internal.offline_after()
    and (internal.shift_state(v_device.user_id)).state <> 'off_shift'
    and not v_was_locked
    and not exists (
      select 1 from public.agent_events_raw r
      where r.user_id = v_device.user_id and r.at > v_prev and r.at < v_now
    )
  then
    update public.status_periods set end_at = greatest(start_at, v_prev)
    where user_id = v_device.user_id and end_at is null;
    insert into public.status_periods (org_id, user_id, status, start_at, end_at)
    values (v_device.org_id, v_device.user_id, 'tamper', v_prev, v_now);
    -- The refresh below then opens the current status at v_now.
    update public.presence set status = 'tamper', since = v_prev where user_id = v_device.user_id;
  end if;

  v_idle_threshold := coalesce(
    (select (o.policy ->> 'idle_threshold_min')::int from public.orgs o where o.id = v_device.org_id), 10
  ) * 60;

  insert into public.last_seen (user_id, org_id, device_id, at, state)
  values (
    v_device.user_id, v_device.org_id, v_device.id, v_now,
    jsonb_build_object(
      'sent_at', sent_at, 'idle_s', idle_s, 'locked', locked, 'in_call', in_call,
      'permissions', coalesce(permissions, '{}'::jsonb)
    )
  )
  on conflict (user_id) do update
  set device_id = excluded.device_id, at = excluded.at, state = excluded.state;

  update public.presence p
  set last_contact_at = v_now,
      locked = agent_heartbeat.locked,
      idle = agent_heartbeat.idle_s >= v_idle_threshold
  where p.user_id = v_device.user_id;

  update public.devices d set agent_version = agent_heartbeat.agent_version where d.id = v_device.id;

  perform internal.refresh_presence(v_device.user_id, v_now);

  return jsonb_build_object(
    'server_time', v_now,
    'policy_version', (select o.policy_version from public.orgs o where o.id = v_device.org_id),
    'commands', '[]'::jsonb
  );
end;
$$;

-- Offline sweep ------------------------------------------------------------------------

-- Every minute (LLD pg_cron table): clocked-in users not heard from for 3 minutes
-- become Offline, starting at the moment the 3 minutes ran out.
create function internal.offline_sweep()
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
  n int := 0;
begin
  for r in
    select p.user_id, p.last_contact_at
    from public.presence p
    where p.status not in ('off_shift', 'offline')
      and p.last_contact_at < now() - internal.offline_after()
  loop
    if internal.refresh_presence(r.user_id, r.last_contact_at + internal.offline_after()) = 'offline' then
      n := n + 1;
    end if;
  end loop;
  return n;
end;
$$;

revoke all on function internal.compute_status(jsonb) from public, anon, authenticated;
revoke all on function internal.offline_after() from public, anon, authenticated;
revoke all on function internal.status_input(uuid, timestamptz) from public, anon, authenticated;
revoke all on function internal.refresh_presence(uuid, timestamptz) from public, anon, authenticated;
revoke all on function internal.offline_sweep() from public, anon, authenticated;

select cron.schedule('offline_sweep', '* * * * *', 'select internal.offline_sweep()');
