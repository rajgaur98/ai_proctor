-- #25: activity sampling (ACT-01..03). The agent sends one `app_session` per app,
-- window title and browser domain per minute; each becomes one row of
-- activity_samples (PRD data model). Titles are dropped when the org turns window
-- titles off (EU preset) and for excluded apps (CAP-04 / ACT-02), here as well as
-- on the device.

create table public.activity_samples (
  -- The agent event's id: a replayed event can't add the same minute twice.
  id uuid not null,
  org_id uuid not null references public.orgs (id) on delete cascade,
  user_id uuid not null references public.users (id) on delete cascade,
  device_id uuid not null references public.devices (id) on delete cascade,
  minute timestamptz not null,
  app_name text not null,
  window_title text,
  domain text,
  seconds int not null,
  primary key (id, minute),
  constraint activity_samples_minute_check check (minute = date_trunc('minute', minute)),
  constraint activity_samples_seconds_check check (seconds between 1 and 60)
) partition by range (minute);

create index activity_samples_user_minute_idx on public.activity_samples (user_id, minute);
alter table public.activity_samples enable row level security;

create policy "Visible per can_view_user"
on public.activity_samples for select to authenticated
using (org_id = (select internal.jwt_org_id()) and public.can_view_user(user_id));

-- Same window as agent_events_raw: last week through four weeks ahead; the event
-- path adds missing weeks, the weekly job takes over with #51.
select internal.ensure_weekly_partitions(
  'public.activity_samples', now() - interval '7 days', now() + interval '4 weeks'
);

-- Stores one app_session. Returns null when stored, or the rejection reason.
create function internal.record_activity(
  p_device public.devices,
  p_event_id uuid,
  p_payload jsonb
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_start timestamptz := (p_payload ->> 'start')::timestamptz;
  v_end timestamptz := (p_payload ->> 'end')::timestamptz;
  v_minute timestamptz := date_trunc('minute', v_start);
  v_seconds int := round(extract(epoch from v_end - v_start))::int;
  v_policy jsonb := (select o.policy from public.orgs o where o.id = p_device.org_id);
  v_app text := p_payload ->> 'app';
  v_title text := nullif(p_payload ->> 'title', '');
begin
  -- One bucket: inside a single minute, at least a second long.
  if v_end < v_start or v_end > v_minute + interval '1 minute' or v_seconds < 1 then
    return 'invalid_app_session';
  end if;
  if not coalesce((v_policy ->> 'window_titles')::boolean, true)
    or exists (
      select 1 from jsonb_array_elements_text(coalesce(v_policy -> 'excluded_apps', '[]')) e
      where lower(e) = lower(v_app)
    )
  then
    v_title := null;
  end if;
  perform internal.ensure_weekly_partitions('public.activity_samples', v_minute, v_minute);
  insert into public.activity_samples (
    id, org_id, user_id, device_id, minute, app_name, window_title, domain, seconds
  )
  values (
    p_event_id, p_device.org_id, p_device.user_id, p_device.id, v_minute, v_app, v_title,
    nullif(lower(p_payload ->> 'domain'), ''), least(v_seconds, 60)
  )
  on conflict do nothing;
  return null;
end;
$$;

revoke all on function internal.record_activity(public.devices, uuid, jsonb)
  from public, anon, authenticated;

-- Event projection (replaces #30's version: adds app_session) -------------------------

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
    when 'app_session' then
      -- ACT-01: only while working, never on a break or pause.
      if s.state <> 'working' then return 'app_session_while_' || s.state; end if;
      v_reason := internal.record_activity(p_device, p_event_id, p_payload);
      if v_reason is not null then return v_reason; end if;
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
