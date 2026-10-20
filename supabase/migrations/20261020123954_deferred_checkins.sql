-- Deferred check-ins (#102; CHK-03, DSH-03, CHK-24).
--
-- The agent records one `deferred` check-in when a due check-in is held for a call,
-- a screen share or a presentation: scheduled_at is the time it was due, the reason
-- is `deferral_reason`, and nothing was shown, answered or captured. The check-in
-- that follows once the hold ends is a separate row with the same scheduled_at.
--
-- A deferral is neither a pass nor a miss. It never changes presence's last check-in
-- (so Away after a miss stays Away until a pass, STS rule 7), and it doesn't count
-- as "shown" on the live grid (response rate excludes deferrals).

alter table public.checkin_events
  add column deferral_reason text check (deferral_reason in ('call', 'screen_share', 'presenting'));

-- Only a deferred check-in has a reason, and it always has one.
alter table public.checkin_events
  add constraint checkin_events_deferral_reason_matches
  check ((outcome = 'deferred') = (deferral_reason is not null));

-- Nothing was shown or answered. Captures are already limited to a pass by
-- checkin_events_miss_has_no_captures (and by the storage policy, which needs a
-- recorded pass).
alter table public.checkin_events
  add constraint checkin_events_deferred_not_shown
  check (outcome <> 'deferred' or (shown_at is null and responded_at is null and response_ms is null));

-- Live grid: a deferral wasn't shown, so it isn't counted (same columns as before).
create or replace view public.team_live
with (security_invoker = on)
as
select
  u.id as user_id,
  u.org_id,
  u.full_name,
  u.role,
  u.manager_id,
  u.timezone,
  p.status,
  p.since,
  p.last_checkin_at,
  p.last_checkin_outcome,
  p.project_id,
  -- Today, in the employee's own time zone.
  coalesce(today.shown, 0) as checkins_shown_today,
  coalesce(today.passed, 0) as checkins_passed_today,
  exists (
    select 1 from public.shifts s
    where s.user_id = u.id
      and extract(isodow from now() at time zone s.timezone)::int = any (s.days)
  ) as scheduled_today
from public.users u
join public.presence p on p.user_id = u.id
left join lateral (
  select
    count(*) filter (where c.outcome <> 'deferred')::int as shown,
    count(*) filter (where c.outcome = 'pass')::int as passed
  from public.checkin_events c
  where c.user_id = u.id
    and c.scheduled_at >= (date_trunc('day', now() at time zone u.timezone) at time zone u.timezone)
) today on true
where u.active;

-- Event projection: the same as breaks_and_pause_caps' version, except the checkin
-- branch stores deferral_reason and leaves presence alone for a deferral.

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
begin
  insert into public.presence (user_id, org_id) values (p_device.user_id, p_device.org_id)
  on conflict (user_id) do nothing;

  case p_type
  when 'clock_in' then
    if s.state <> 'off_shift' then return 'already_clocked_in'; end if;
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
      null;
    end case;
  end case;

  update public.presence set last_contact_at = now() where user_id = p_device.user_id;
  perform internal.refresh_presence(p_device.user_id, p_at);
  return null;
end;
$$;

revoke all on function internal.apply_event(public.devices, uuid, text, timestamptz, jsonb)
  from public, anon, authenticated;
