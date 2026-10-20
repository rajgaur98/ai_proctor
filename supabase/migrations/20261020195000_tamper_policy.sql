-- #161: Tamper follows what this person is actually collected for (AGT-07, CAP-02,
-- CAP-05, ACT-03, ANT-01, TS-01, ALR-01).
--
-- A missing permission made the status Tamper whenever Screen Recording was off, even
-- when the org's screenshot setting is Off. It now counts only when the capture it
-- belongs to is on, by the person's effective collection (#48: what they acknowledged
-- and the org's current policy, per key):
--   Screen Recording  screenshots is not 'off', or window titles are sampled (activity
--                     sampling and window titles both on: on macOS the titles need
--                     Screen Recording, docs/tech-stack.md)
--   Camera            webcam is on
-- A permission the platform doesn't have ('unsupported') still blocks nothing.
--
-- The agent reports raw states and the server decides, so the raw states are kept
-- (screen_permission, camera_permission) and the verdict is worked out at every
-- refresh: an org that changes a setting while a permission is missing clears (or
-- opens) Tamper at the next heartbeat instead of waiting for the person to change the
-- permission again. This replaces the stored verdict, presence.permission_missing.
--
-- The other paths into Tamper (restart gap, heartbeat gap) are status periods; they
-- already become unverified segments (status_periods feed buildSegments) and Tamper
-- alerts (alert_eval, one per period). The tests in tamper_policy.test.sql pin both.

-- What this person's collection needs from the OS: {"screen": bool, "camera": bool}.
create function internal.capture_needs(p_user_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'screen', c ->> 'screenshots' <> 'off'
      or ((c ->> 'activity_sampling')::boolean and (c ->> 'window_titles')::boolean),
    'camera', (c ->> 'webcam')::boolean
  )
  from (select internal.effective_collection(p_user_id) as c) e;
$$;

-- Whether the raw permission states stop a capture this person's collection includes.
create function internal.capture_blocked(p_user_id uuid, p_screen text, p_camera text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (needs ->> 'screen')::boolean and internal.permission_blocks(p_screen)
      or (needs ->> 'camera')::boolean and internal.permission_blocks(p_camera),
    false)
  from (select internal.capture_needs(p_user_id) as needs) n;
$$;

revoke all on function internal.capture_needs(uuid) from public, anon, authenticated;
revoke all on function internal.capture_blocked(uuid, text, text) from public, anon, authenticated;

-- Raw states, last reported by a permission_change event (null: none yet).
alter table public.presence
  add column screen_permission text,
  add column camera_permission text;
update public.presence set screen_permission = 'denied' where permission_missing;
alter table public.presence drop column permission_missing;

-- The status inputs (the status engine migration's version; Tamper from the raw
-- permission states and the person's collection) ----------------------------------------

create or replace function internal.status_input(p_user_id uuid, p_now timestamptz)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'clocked_in', (s).state <> 'off_shift',
    'tamper', internal.capture_blocked(p_user_id, p.screen_permission, p.camera_permission),
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

-- Event projection: permission_change keeps the raw states (the watchdog migration's
-- version; only that block changes) -------------------------------------------------------

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
  v_reason text;
  v_project uuid;
  v_from timestamptz;
begin
  insert into public.presence (user_id, org_id) values (p_device.user_id, p_device.org_id)
  on conflict (user_id) do nothing;

  case p_type
  when 'clock_in' then
    if s.state <> 'off_shift' then return 'already_clocked_in'; end if;
    -- AGT-04: nothing is collected before the person has acknowledged a notice.
    if not exists (select 1 from public.notice_acks a where a.user_id = p_device.user_id) then
      return 'notice_not_acknowledged';
    end if;
    -- PRJ-03: a project the person can't log to is recorded as Unassigned.
    v_project := internal.allowed_project(p_device.user_id, p_payload ->> 'project_id');
    insert into public.clock_sessions (org_id, user_id, device_id, project_id, start_at, start_event_id)
    values (p_device.org_id, p_device.user_id, p_device.id, v_project, p_at, p_event_id);
    -- A new shift starts clean.
    update public.presence
    set project_id = v_project,
        locked = false, idle = false, call_sources = '{}', last_checkin_outcome = null
    where user_id = p_device.user_id;

  when 'clock_out' then
    if s.state = 'off_shift' then return 'not_clocked_in'; end if;
    perform internal.close_break(s.break_id, p_at);
    perform internal.close_pause(s.pause_id, p_at);
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
    perform internal.close_break(s.break_id, p_at);

  when 'pause_start' then
    if s.state = 'off_shift' then return 'not_clocked_in'; end if;
    if s.state = 'on_break' then return 'on_break'; end if;
    if s.state = 'paused' then return 'already_paused'; end if;
    insert into public.pauses (org_id, user_id, clock_session_id, start_at, planned_min, private_reason)
    values (p_device.org_id, p_device.user_id, s.clock_session_id, p_at,
            (p_payload ->> 'planned_min')::int, nullif(btrim(p_payload ->> 'reason'), ''));

  when 'pause_end' then
    if s.state <> 'paused' then return 'not_paused'; end if;
    perform internal.close_pause(s.pause_id, p_at);

  when 'project_switch' then
    if s.state = 'off_shift' then return 'not_clocked_in'; end if;
    v_project := internal.allowed_project(p_device.user_id, p_payload ->> 'project_id');
    if v_project is null and nullif(p_payload ->> 'project_id', '') is not null then
      return 'project_not_allowed';
    end if;
    update public.presence set project_id = v_project where user_id = p_device.user_id;

  when 'checkin' then
    if s.state <> 'working' then return 'checkin_while_' || s.state; end if;
    begin
      insert into public.checkin_events (
        id, org_id, user_id, device_id, project_id, scheduled_at, shown_at, responded_at,
        outcome, deferral_reason, response_ms, wrong_clicks, idle_s_at_show, device_state,
        object_keys, flags, capture_errors
      )
      values (
        p_event_id, p_device.org_id, p_device.user_id, p_device.id,
        internal.allowed_project(p_device.user_id, p_payload ->> 'project_id'),
        (p_payload ->> 'scheduled_at')::timestamptz,
        (p_payload ->> 'shown_at')::timestamptz,
        (p_payload ->> 'responded_at')::timestamptz,
        (p_payload ->> 'outcome')::public.checkin_outcome,
        p_payload ->> 'deferral_reason',
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
    -- A deferral is neither a pass nor a miss: "most recent check-in" (STS rule 7)
    -- stays what it was.
    if p_payload ->> 'outcome' <> 'deferred' then
      update public.presence
      set last_checkin_at = p_at, last_checkin_outcome = (p_payload ->> 'outcome')::public.checkin_outcome
      where user_id = p_device.user_id;
    end if;

  when 'app_session' then
    -- Judged by its own time, not the current state: the agent sends the last
    -- minute's bucket after the break or clock-out that ended it.
    v_reason := internal.record_activity(p_device, p_event_id, p_payload);
    if v_reason is not null then return v_reason; end if;

  when 'permission_change' then
    -- The raw states; whether they are Tamper depends on what this person is
    -- collected for, worked out at every refresh (STS rule 2, AGT-07).
    update public.presence p
    set screen_permission = p_payload ->> 'screen', camera_permission = p_payload ->> 'camera'
    where p.user_id = p_device.user_id;

  when 'agent_restart' then
    -- ANT-01: the agent came back after a run that ended during a shift. If that
    -- run was killed (it never exited normally and the device did not restart),
    -- the time since it was last seen alive is Tamper, from the clock-in at the
    -- earliest. A normal exit or a reboot is on record but is not Tamper. Not
    -- clocked in: nothing to explain.
    if s.state <> 'off_shift' and p_payload ->> 'reason' = 'killed' then
      v_from := greatest(
        (p_payload ->> 'last_alive_at')::timestamptz,
        (select cs.start_at from public.clock_sessions cs where cs.id = s.clock_session_id)
      );
      if v_from < p_at then
        perform internal.record_tamper_gap(p_device.user_id, p_device.org_id, v_from, p_at);
      end if;
    end if;

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
      null;
    end case;
  end case;

  update public.presence set last_contact_at = now() where user_id = p_device.user_id;
  perform internal.refresh_presence(p_device.user_id, p_at);
  return null;
end;
$$;

-- Explicit grants, as for the other internal functions.
revoke all on function internal.apply_event(public.devices, uuid, text, timestamptz, jsonb)
  from public, anon, authenticated;
