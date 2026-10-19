-- Sync protocol, server side (#23; STS-01, NFR-REL-01). LLD sections 02-04.
--
-- agent_events takes ≤ 100 events (≤ 256 KB) per call, validates each against the
-- agent-event JSON Schema generated from packages/contracts, deduplicates on the
-- device's event id, enforces the shift state machine, stores the raw event and
-- projects it into clock_sessions / breaks / pauses / checkin_events / presence.
-- agent_heartbeat records last_seen. Presence *status* rules come with #30.

create extension if not exists pg_jsonschema with schema extensions;

-- Contract schemas ------------------------------------------------------------

-- JSON Schemas generated from packages/contracts, written by generated migrations
-- (`pnpm contracts:migration`). CI checks they match the Zod source.
create table internal.contract_schemas (
  name text primary key,
  schema jsonb not null,
  updated_at timestamptz not null default now()
);

-- Shift tables ------------------------------------------------------------------

create table public.clock_sessions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  user_id uuid not null references public.users (id) on delete cascade,
  device_id uuid not null references public.devices (id) on delete cascade,
  -- FK to projects comes with #38.
  project_id uuid,
  start_at timestamptz not null,
  end_at timestamptz,
  -- manual | auto (forgotten clock-out, SHF-04)
  end_reason text,
  start_event_id uuid not null,
  end_event_id uuid,
  constraint clock_sessions_end_after_start check (end_at is null or end_at >= start_at)
);

-- At most one open clock session per user.
create unique index clock_sessions_one_open_idx on public.clock_sessions (user_id) where end_at is null;
create index clock_sessions_user_start_idx on public.clock_sessions (user_id, start_at);

create table public.breaks (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  user_id uuid not null references public.users (id) on delete cascade,
  clock_session_id uuid not null references public.clock_sessions (id) on delete cascade,
  start_at timestamptz not null,
  end_at timestamptz,
  planned_min int check (planned_min in (15, 30, 60)),
  constraint breaks_end_after_start check (end_at is null or end_at >= start_at)
);

create unique index breaks_one_open_idx on public.breaks (user_id) where end_at is null;
create index breaks_session_idx on public.breaks (clock_session_id);

create table public.pauses (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  user_id uuid not null references public.users (id) on delete cascade,
  clock_session_id uuid not null references public.clock_sessions (id) on delete cascade,
  start_at timestamptz not null,
  end_at timestamptz,
  planned_min int not null check (planned_min in (5, 10, 15)),
  -- Seconds over the per-pause / per-day caps; computed on the server (#36).
  over_cap_s int not null default 0 check (over_cap_s >= 0),
  constraint pauses_end_after_start check (end_at is null or end_at >= start_at)
);

create unique index pauses_one_open_idx on public.pauses (user_id) where end_at is null;
create index pauses_session_idx on public.pauses (clock_session_id);

alter table public.clock_sessions enable row level security;
alter table public.breaks enable row level security;
alter table public.pauses enable row level security;

-- Sync bookkeeping --------------------------------------------------------------

-- Highest seq up to which every event from this device has been processed
-- (accepted, duplicate or rejected); the agent can forget everything at or below it.
alter table public.devices add column acked_seq bigint not null default 0;

create index agent_events_raw_device_seq_idx on public.agent_events_raw (device_id, seq);

-- Rejected events are terminal (the agent never retries them), so they count toward
-- acked_seq and resends are reported as duplicates.
create table public.agent_event_rejections (
  device_id uuid not null references public.devices (id) on delete cascade,
  event_id uuid,
  seq bigint,
  type text,
  reason text not null,
  received_at timestamptz not null default now()
);

create index agent_event_rejections_device_seq_idx on public.agent_event_rejections (device_id, seq);
create index agent_event_rejections_event_idx on public.agent_event_rejections (event_id);
alter table public.agent_event_rejections enable row level security;

-- CAP-08: why a capture failed, per kind ({"screen": "...", "webcam": "..."}).
alter table public.checkin_events add column capture_errors jsonb;

-- Latest heartbeat contents (STS-01): idle seconds, lock, call, permissions, health.
alter table public.last_seen add column state jsonb not null default '{}'::jsonb;

-- Shift state ---------------------------------------------------------------------

create type internal.shift_state as (
  state text, -- off_shift | working | on_break | paused
  clock_session_id uuid,
  break_id uuid,
  pause_id uuid
);

create function internal.shift_state(p_user_id uuid)
returns internal.shift_state
language sql
stable
security definer
set search_path = ''
as $$
  select
    case
      when cs.id is null then 'off_shift'
      when b.id is not null then 'on_break'
      when p.id is not null then 'paused'
      else 'working'
    end,
    cs.id, b.id, p.id
  from (select 1) one
  left join public.clock_sessions cs on cs.user_id = p_user_id and cs.end_at is null
  left join public.breaks b on b.clock_session_id = cs.id and b.end_at is null
  left join public.pauses p on p.clock_session_id = cs.id and p.end_at is null;
$$;

-- Applies one valid, non-duplicate event to the projections. Returns null when
-- accepted, or the rejection reason. LLD section 02: illegal transitions from the
-- user's current server-side state are rejected.
create function internal.apply_event(
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
    update public.presence set project_id = nullif(p_payload ->> 'project_id', '')::uuid
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
    -- Check-ins only run while working (SHF-05); a break or pause cancels them.
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
      -- e.g. a miss that lists captures
      return 'invalid_checkin';
    end;
    update public.presence
    set last_checkin_at = p_at, last_checkin_outcome = (p_payload ->> 'outcome')::public.checkin_outcome
    where user_id = p_device.user_id;

  when 'permission_change' then
    -- Accepted in any state: a lost permission is Tamper while clocked in.
    null;

  else
    -- idle, lock/unlock, sleep/wake, call, app_session: stored raw; projected into
    -- status_periods / activity_sessions by #25 and #30. Only while clocked in.
    if s.state = 'off_shift' then return 'not_clocked_in'; end if;
  end case;

  return null;
end;
$$;

revoke all on function internal.shift_state(uuid) from public, anon, authenticated;
revoke all on function internal.apply_event(public.devices, uuid, text, timestamptz, jsonb)
  from public, anon, authenticated;

-- agent_events ------------------------------------------------------------------

create function public.agent_events(device_id uuid, events jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_device public.devices := internal.require_active_device(agent_events.device_id);
  v_schema json := (select cs.schema::json from internal.contract_schemas cs where cs.name = 'agent_event');
  v_now timestamptz := now();
  v_accepted jsonb := '[]'::jsonb;
  v_duplicates jsonb := '[]'::jsonb;
  v_rejected jsonb := '[]'::jsonb;
  v_event jsonb;
  v_id uuid;
  v_seq bigint;
  v_at timestamptz;
  v_reason text;
  v_acked bigint;
begin
  if v_schema is null then
    raise exception 'contract_schema_missing';
  end if;
  if jsonb_typeof(events) is distinct from 'array' then
    raise exception 'events_not_array' using errcode = '22023';
  end if;
  if jsonb_array_length(events) > 100 then
    raise exception 'batch_too_many_events' using errcode = '22023';
  end if;
  if octet_length(events::text) > 262144 then
    raise exception 'batch_too_large' using errcode = '22023';
  end if;

  -- In seq order, so events that share a timestamp apply in device order.
  for v_event in
    select e.value from jsonb_array_elements(events) e
    order by case when jsonb_typeof(e.value -> 'seq') = 'number' then (e.value ->> 'seq')::numeric end
  loop
    v_id := null;
    v_seq := null;
    if not extensions.jsonb_matches_schema(v_schema, v_event) then
      begin
        v_id := (v_event ->> 'id')::uuid;
        v_seq := (v_event ->> 'seq')::bigint;
      exception when others then null;
      end;
      v_reason := 'invalid_event';
    else
      v_id := (v_event ->> 'id')::uuid;
      v_seq := (v_event ->> 'seq')::bigint;
      v_at := (v_event ->> 'at')::timestamptz;

      if exists (select 1 from public.agent_events_raw r where r.id = v_id and r.device_id = v_device.id)
        or exists (select 1 from public.agent_event_rejections x where x.event_id = v_id and x.device_id = v_device.id)
      then
        v_duplicates := v_duplicates || to_jsonb(v_id);
        continue;
      end if;

      if v_at < v_now - interval '7 days' or v_at > v_now + interval '5 minutes' then
        v_reason := 'at_out_of_range';
      else
        v_reason := internal.apply_event(v_device, v_id, v_event ->> 'type', v_at, v_event -> 'payload');
      end if;

      if v_reason is null then
        perform internal.ensure_weekly_partitions('public.agent_events_raw', v_at, v_at);
        insert into public.agent_events_raw (id, org_id, device_id, user_id, seq, type, at, received_at, payload)
        values (v_id, v_device.org_id, v_device.id, v_device.user_id, v_seq, v_event ->> 'type', v_at,
                v_now, v_event -> 'payload');
        v_accepted := v_accepted || to_jsonb(v_id);
        continue;
      end if;
    end if;

    insert into public.agent_event_rejections (device_id, event_id, seq, type, reason)
    values (v_device.id, v_id, v_seq, v_event ->> 'type', v_reason);
    v_rejected := v_rejected || jsonb_build_object('id', v_id, 'seq', v_seq, 'reason', v_reason);
  end loop;

  -- Advance the contiguous cursor past everything processed so far.
  v_acked := v_device.acked_seq;
  loop
    exit when not (
      exists (select 1 from public.agent_events_raw r where r.device_id = v_device.id and r.seq = v_acked + 1)
      or exists (select 1 from public.agent_event_rejections x where x.device_id = v_device.id and x.seq = v_acked + 1)
    );
    v_acked := v_acked + 1;
  end loop;
  update public.devices d set acked_seq = v_acked where d.id = v_device.id;

  return jsonb_build_object(
    'accepted', v_accepted,
    'duplicates', v_duplicates,
    'rejected', v_rejected,
    'acked_seq', v_acked,
    'server_time', v_now
  );
end;
$$;

-- agent_heartbeat ---------------------------------------------------------------

-- Every 60 s while clocked in (STS-01). Returns the server time for clock-offset
-- correction, the org policy version (the agent refetches when it changes), and
-- commands for the agent (none yet; reack_notice comes with #48, update with #57).
create function public.agent_heartbeat(
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
begin
  if idle_s < 0 or length(coalesce(agent_version, '')) not between 1 and 64 then
    raise exception 'invalid_heartbeat' using errcode = '22023';
  end if;

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

  update public.devices d set agent_version = agent_heartbeat.agent_version where d.id = v_device.id;

  return jsonb_build_object(
    'server_time', v_now,
    'policy_version', (select o.policy_version from public.orgs o where o.id = v_device.org_id),
    'commands', '[]'::jsonb
  );
end;
$$;

revoke all on function public.agent_events(uuid, jsonb) from public, anon;
revoke all on function public.agent_heartbeat(uuid, timestamptz, int, boolean, boolean, text, jsonb)
  from public, anon;
grant execute on function public.agent_events(uuid, jsonb) to authenticated;
grant execute on function public.agent_heartbeat(uuid, timestamptz, int, boolean, boolean, text, jsonb)
  to authenticated;
