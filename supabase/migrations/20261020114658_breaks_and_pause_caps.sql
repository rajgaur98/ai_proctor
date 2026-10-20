-- Breaks and pauses on the server (#35, #36; BRK-02, BRK-03, BRK-05, BRK-06).
--
-- Org policy keys read here (all optional, in orgs.policy):
--   breaks_paid           boolean, default false (breaks are unpaid)
--   break_daily_max_min   int, absent = no daily max on breaks
--   pause_max_min         int, default 15 (per pause)
--   pause_daily_max_min   int, default 60 (per local day)
-- Going over a cap is allowed; the excess is stored on the row as over_cap_s
-- when the break or pause ends, and shown as flagged time later. Nothing is
-- ever deducted automatically.
--
-- Day = the employee's local calendar day (users.timezone) the break or pause
-- started on.
--
-- Pause arithmetic. For a pause of d seconds with per-pause cap P, daily cap D
-- and C seconds already counted as worked by the person's earlier pauses that
-- day (C = sum of duration - over_cap_s):
--   counted  = min(d, P, max(0, D - C))
--   over_cap = d - counted
-- That is the seconds past P plus the seconds that push the day past D, with no
-- second counted twice. Example (P 15, D 60): four 15-minute pauses count in
-- full; a fifth of 10 minutes is 600 s over. With 50 minutes already counted, a
-- 20-minute pause counts 10 minutes and is 600 s over (300 past P, 300 past D).
-- A pause that is extended is a new pause, so it sees the earlier one in C.
--
-- Break arithmetic: with daily max M and T seconds of earlier breaks that day,
-- over_cap = min(d, max(0, T + d - M)). No M, no flag.

alter table public.breaks
  add column over_cap_s int not null default 0 check (over_cap_s >= 0);

alter table public.pauses
  add column private_reason text check (char_length(private_reason) <= 200);

-- BRK-03: the optional reason on a pause is the employee's own. Managers and
-- admins can read the pauses row (RLS, can_view_user) but not this column:
-- authenticated gets SELECT on every column except private_reason, and the
-- employee reads their own reasons through public.my_pauses. Consequence: API
-- callers must list pauses columns explicitly (select=* is denied). The agent
-- and apply_event write it as the table owner.
revoke select on public.pauses from anon, authenticated;
grant select (id, org_id, user_id, clock_session_id, start_at, end_at, planned_min, over_cap_s)
  on public.pauses to authenticated;

create view public.my_pauses as
select p.id, p.org_id, p.user_id, p.clock_session_id, p.start_at, p.end_at, p.planned_min,
       p.over_cap_s, p.private_reason
from public.pauses p
where p.user_id = (select auth.uid())
  and p.org_id = (select internal.jwt_org_id());

revoke all on public.my_pauses from public, anon, authenticated;
grant select on public.my_pauses to authenticated;

-- Policy with defaults ------------------------------------------------------------

create function internal.break_pause_policy(p_org_id uuid)
returns table (
  breaks_paid boolean,
  break_daily_max_min int,
  pause_max_min int,
  pause_daily_max_min int
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    coalesce((o.policy ->> 'breaks_paid')::boolean, false),
    (o.policy ->> 'break_daily_max_min')::int,
    coalesce((o.policy ->> 'pause_max_min')::int, 15),
    coalesce((o.policy ->> 'pause_daily_max_min')::int, 60)
  from (select 1) one
  left join public.orgs o on o.id = p_org_id;
$$;

revoke all on function internal.break_pause_policy(uuid) from public, anon, authenticated;

-- Closing a break or pause ----------------------------------------------------------

create function internal.close_break(p_break_id uuid, p_end_at timestamptz)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_break public.breaks;
  v_tz text;
  v_end timestamptz;
  v_max_min int;
  v_d int;
  v_prior int;
begin
  select * into v_break from public.breaks where id = p_break_id and end_at is null;
  if not found then return; end if;
  select u.timezone into v_tz from public.users u where u.id = v_break.user_id;
  select pol.break_daily_max_min into v_max_min from internal.break_pause_policy(v_break.org_id) pol;

  v_end := greatest(v_break.start_at, p_end_at);
  v_d := floor(extract(epoch from v_end - v_break.start_at))::int;

  select coalesce(sum(floor(extract(epoch from b.end_at - b.start_at))), 0)::int into v_prior
  from public.breaks b
  where b.user_id = v_break.user_id and b.id <> v_break.id and b.end_at is not null
    and (b.start_at at time zone v_tz)::date = (v_break.start_at at time zone v_tz)::date;

  update public.breaks
  set end_at = v_end,
      over_cap_s = case when v_max_min is null then 0
                        else least(v_d, greatest(0, v_prior + v_d - v_max_min * 60)) end
  where id = v_break.id;
end;
$$;

revoke all on function internal.close_break(uuid, timestamptz) from public, anon, authenticated;

create function internal.close_pause(p_pause_id uuid, p_end_at timestamptz)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_pause public.pauses;
  v_tz text;
  v_end timestamptz;
  v_per int;
  v_daily int;
  v_d int;
  v_counted_before int;
  v_counted int;
begin
  select * into v_pause from public.pauses where id = p_pause_id and end_at is null;
  if not found then return; end if;
  select u.timezone into v_tz from public.users u where u.id = v_pause.user_id;
  select pol.pause_max_min * 60, pol.pause_daily_max_min * 60 into v_per, v_daily
  from internal.break_pause_policy(v_pause.org_id) pol;

  v_end := greatest(v_pause.start_at, p_end_at);
  v_d := floor(extract(epoch from v_end - v_pause.start_at))::int;

  select coalesce(sum(floor(extract(epoch from p.end_at - p.start_at)) - p.over_cap_s), 0)::int
  into v_counted_before
  from public.pauses p
  where p.user_id = v_pause.user_id and p.id <> v_pause.id and p.end_at is not null
    and (p.start_at at time zone v_tz)::date = (v_pause.start_at at time zone v_tz)::date;

  v_counted := least(v_d, v_per, greatest(0, v_daily - v_counted_before));

  update public.pauses set end_at = v_end, over_cap_s = v_d - v_counted where id = v_pause.id;
end;
$$;

revoke all on function internal.close_pause(uuid, timestamptz) from public, anon, authenticated;

-- Event projection (replaces activity_samples' version: closes breaks and pauses through
-- close_break/close_pause, and keeps the pause reason) ----------------------------------

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
        outcome, response_ms, wrong_clicks, idle_s_at_show, device_state, object_keys,
        flags, capture_errors
      )
      values (
        p_event_id, p_device.org_id, p_device.user_id, p_device.id,
        internal.allowed_project(p_device.user_id, p_payload ->> 'project_id'),
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
