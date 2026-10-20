-- #58: watchdog and tamper (ANT-01, AGT-07, STS rule 2).
--
-- Already in place: permission_change events set presence.permission_missing, which
-- makes the status Tamper while clocked in (status engine, #30); a heartbeat that
-- arrives after an unexplained gap during clock-in records the gap as Tamper.
-- This adds:
--   * `agent_restart` events. The watchdog starts a killed agent again within
--     seconds; the new run says when the old one was last seen alive and how it
--     ended. A kill during a shift is Tamper for that gap (needs review, never a
--     penalty: ANT-08). An agent that was running but offline never restarts, so
--     offline is not mistaken for a kill. A normal exit or a reboot is on record
--     but is not Tamper.
--   * A permission that does not exist on the platform ('unsupported') is not a
--     blocked capture: only denied, not determined and restricted are.

-- A permission state that stops capture.
create function internal.permission_blocks(p_state text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_state in ('denied', 'not_determined', 'restricted');
$$;

-- Records Tamper from p_from to p_to for a clocked-in user. Tamper outranks Offline
-- (STS), so Offline that began inside the gap is the same silence and goes. The
-- caller refreshes the presence afterwards, which opens the period that follows.
create function internal.record_tamper_gap(
  p_user_id uuid,
  p_org_id uuid,
  p_from timestamptz,
  p_to timestamptz
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.status_periods
  where user_id = p_user_id and status = 'offline' and start_at >= p_from and start_at < p_to;
  -- The period open now began inside the gap (the clock-in itself, say): the gap
  -- replaces it. One that began earlier ends where the gap starts.
  delete from public.status_periods
  where user_id = p_user_id and end_at is null and start_at >= p_from;
  update public.status_periods set end_at = p_from
  where user_id = p_user_id and end_at is null;
  insert into public.status_periods (org_id, user_id, status, start_at, end_at)
  values (p_org_id, p_user_id, 'tamper', p_from, p_to);
  -- Not Tamper, so the refresh opens whatever the status is now, at p_to, even when
  -- that is Tamper again (a permission still missing).
  update public.presence set status = 'offline', since = p_to where user_id = p_user_id;
end;
$$;

revoke all on function internal.permission_blocks(text) from public, anon, authenticated;
revoke all on function internal.record_tamper_gap(uuid, uuid, timestamptz, timestamptz)
  from public, anon, authenticated;

-- Event projection: permission_change counts only states that block capture, and
-- agent_restart (replaces the monitoring notice migration's version) --------------------

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
    -- Tamper while a capture permission is missing (STS rule 2, AGT-07). Camera
    -- only counts when this person's collection includes the webcam. A permission
    -- that doesn't exist on this platform ('unsupported') is nothing to fix.
    update public.presence p
    set permission_missing = internal.permission_blocks(p_payload ->> 'screen')
      or (internal.permission_blocks(p_payload ->> 'camera')
          and (internal.effective_collection(p_device.user_id) ->> 'webcam')::boolean)
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
