-- #160: why a status is Tamper (AGT-07, ANT-01, ANT-08, DSH-03).
--
-- Every Tamper looked the same on the dashboard ("Capture blocked"), including a
-- killed agent or a heartbeat gap. The status stays one value (the rules and
-- internal.compute_status are unchanged); the reason is extra detail kept on the
-- Tamper status period, on presence while the status is Tamper, and in the Tamper
-- alert:
--   capture_blocked  a capture permission is missing (permission_change)
--   agent_stopped    the agent was killed and the watchdog restarted it
--   no_heartbeat     the agent went silent while clocked in with nothing to explain it
-- All of it is "needs review", never a penalty (ANT-08).

create type public.tamper_reason as enum ('capture_blocked', 'agent_stopped', 'no_heartbeat');

alter table public.status_periods
  add column reason public.tamper_reason,
  add constraint status_periods_reason_only_tamper check (reason is null or status = 'tamper');

-- Tamper periods recorded before this have no recorded cause; they stay what the
-- dashboard always called them.
update public.status_periods set reason = 'capture_blocked' where status = 'tamper' and reason is null;

alter table public.presence add column tamper_reason public.tamper_reason;
update public.presence set tamper_reason = 'capture_blocked' where status = 'tamper';
alter table public.presence
  add constraint presence_tamper_reason_only_tamper check (tamper_reason is null or status = 'tamper');

-- Live grid: the reason joins the row (appended; the other columns are as before).
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
  ) as scheduled_today,
  p.tamper_reason
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

-- A refresh that opens Tamper records why. The status rules only produce Tamper from
-- a missing capture permission; the gap paths (killed restart, heartbeat gap) write
-- their own period with their own reason.
create or replace function internal.refresh_presence(p_user_id uuid, p_at timestamptz default now())
returns public.presence_status
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old public.presence_status;
  v_new public.presence_status;
  v_org uuid;
  v_reason public.tamper_reason;
begin
  select status, org_id into v_old, v_org from public.presence where user_id = p_user_id for update;
  if not found then
    return null;
  end if;
  v_new := internal.compute_status(internal.status_input(p_user_id, now()));
  if v_new is distinct from v_old then
    v_reason := case when v_new = 'tamper' then 'capture_blocked' end;
    update public.presence set status = v_new, since = p_at, tamper_reason = v_reason
    where user_id = p_user_id;
    update public.status_periods set end_at = greatest(start_at, p_at)
    where user_id = p_user_id and end_at is null;
    insert into public.status_periods (org_id, user_id, status, reason, start_at)
    values (v_org, p_user_id, v_new, v_reason, p_at);
  end if;
  return v_new;
end;
$$;

-- The killed-restart gap: takes the reason (agent_stopped when apply_event calls it
-- with four arguments, as before).
drop function internal.record_tamper_gap(uuid, uuid, timestamptz, timestamptz);

create function internal.record_tamper_gap(
  p_user_id uuid,
  p_org_id uuid,
  p_from timestamptz,
  p_to timestamptz,
  p_reason public.tamper_reason default 'agent_stopped'
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
  insert into public.status_periods (org_id, user_id, status, reason, start_at, end_at)
  values (p_org_id, p_user_id, 'tamper', p_reason, p_from, p_to);
  -- Not Tamper, so the refresh opens whatever the status is now, at p_to, even when
  -- that is Tamper again (a permission still missing).
  update public.presence set status = 'offline', since = p_to, tamper_reason = null
  where user_id = p_user_id;
end;
$$;

revoke all on function internal.record_tamper_gap(uuid, uuid, timestamptz, timestamptz, public.tamper_reason)
  from public, anon, authenticated;

-- Heartbeat (the status engine migration's version; the gap period gets the reason) --------

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
    insert into public.status_periods (org_id, user_id, status, reason, start_at, end_at)
    values (v_device.org_id, v_device.user_id, 'tamper', 'no_heartbeat', v_prev, v_now);
    -- Not Tamper, so the refresh below opens whatever the status is now at v_now,
    -- even when that is Tamper again (a permission still missing).
    update public.presence set status = 'offline', since = v_now, tamper_reason = null
    where user_id = v_device.user_id;
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

-- Tamper alert: the details carry the reason (the alert_eval of the manager alerts
-- migration; only the Tamper block changes) --------------------------------------------

create or replace function internal.alert_eval(p_now timestamptz default now())
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
  v_n int := 0;
  -- Conditions older than this when first seen are not raised.
  v_recent interval := interval '1 hour';
begin
  -- A slow run must not overlap the next one.
  if not pg_try_advisory_xact_lock(hashtext('alert_eval')) then
    return 0;
  end if;

  -- N consecutive misses -------------------------------------------------------------
  for r in
    select u.id as user_id, o.policy,
           run.misses, run.first_miss_id, run.first_miss_at, n.n as threshold
    from public.users u
    join public.orgs o on o.id = u.org_id
    cross join lateral (
      select internal.alert_policy_int(o.policy, 'alert_consecutive_misses', 3, 1, 10) as n
    ) n
    cross join lateral (
      select cs.start_at from public.clock_sessions cs
      where cs.user_id = u.id order by cs.start_at desc limit 1
    ) cs
    cross join lateral (
      with last_ok as (
        select max(c.scheduled_at) as at
        from public.checkin_events c
        where c.user_id = u.id and c.scheduled_at >= cs.start_at and c.outcome <> 'miss'
      ),
      misses as (
        select c.id, c.scheduled_at, c.created_at
        from public.checkin_events c, last_ok
        where c.user_id = u.id and c.scheduled_at >= cs.start_at and c.outcome = 'miss'
          and (last_ok.at is null or c.scheduled_at > last_ok.at)
      )
      select count(*)::int as misses,
             (array_agg(m.id order by m.scheduled_at))[1] as first_miss_id,
             min(m.scheduled_at) as first_miss_at,
             max(m.created_at) as last_seen_at
      from misses m
    ) run
    where u.active
      and internal.alert_enabled(o.policy, 'consecutive_misses')
      and run.misses >= n.n
      and run.last_seen_at > p_now - v_recent
  loop
    v_n := v_n + internal.raise_alert(r.user_id, 'consecutive_misses', r.first_miss_id::text,
      jsonb_build_object('misses', r.misses, 'threshold', r.threshold,
                         'first_miss_at', r.first_miss_at), p_now);
  end loop;

  -- Offline during a shift --------------------------------------------------------------
  for r in
    select p.user_id, p.since, m.minutes
    from public.presence p
    join public.users u on u.id = p.user_id
    join public.orgs o on o.id = u.org_id
    cross join lateral (
      select internal.alert_policy_int(o.policy, 'alert_offline_min', 15, 5, 240) as minutes
    ) m
    where p.status = 'offline' and u.active
      and internal.alert_enabled(o.policy, 'offline')
      and p.since <= p_now - make_interval(mins => m.minutes)
      and exists (
        select 1 from public.clock_sessions cs where cs.user_id = p.user_id and cs.end_at is null
      )
  loop
    v_n := v_n + internal.raise_alert(r.user_id, 'offline',
      (extract(epoch from r.since) * 1000000)::bigint::text,
      jsonb_build_object('since', r.since, 'threshold_min', r.minutes), p_now);
  end loop;

  -- Tamper -----------------------------------------------------------------------------
  for r in
    select sp.id, sp.user_id, sp.start_at, sp.end_at, sp.reason
    from public.status_periods sp
    join public.users u on u.id = sp.user_id
    join public.orgs o on o.id = u.org_id
    where sp.status = 'tamper' and u.active
      and internal.alert_enabled(o.policy, 'tamper')
      and (sp.end_at is null or sp.end_at > p_now - v_recent)
  loop
    v_n := v_n + internal.raise_alert(r.user_id, 'tamper', r.id::text,
      jsonb_build_object('since', r.start_at, 'until', r.end_at, 'reason', r.reason), p_now);
  end loop;

  -- Late clock-in -----------------------------------------------------------------------
  -- Shift occurrences that started today or yesterday in the shift's own time zone
  -- (a shift past midnight belongs to the day it starts on).
  for r in
    select u.id as user_id, g.grace, s.start_at
    from public.users u
    join public.orgs o on o.id = u.org_id
    join public.shifts sh on sh.user_id = u.id
    cross join lateral (
      select internal.alert_policy_int(o.policy, 'late_clock_in_min', 15, 5, 60) as grace
    ) g
    cross join lateral (
      select unnest(array[(p_now at time zone sh.timezone)::date - 1,
                          (p_now at time zone sh.timezone)::date]) as day
    ) d
    cross join lateral (
      select ((d.day + sh.start_time) at time zone sh.timezone) as start_at,
             (((d.day + case when sh.end_time < sh.start_time then 1 else 0 end) + sh.end_time)
                at time zone sh.timezone) as end_at
    ) s
    where u.active
      and internal.alert_enabled(o.policy, 'late_clock_in')
      and extract(isodow from d.day)::int = any (sh.days)
      and p_now >= s.start_at + make_interval(mins => g.grace)
      and p_now < s.end_at
      and exists (
        select 1 from public.devices dv where dv.user_id = u.id and dv.revoked_at is null
      )
      and not exists (
        select 1 from public.clock_sessions cs
        where cs.user_id = u.id
          and cs.start_at <= s.start_at + make_interval(mins => g.grace)
          and (cs.end_at is null or cs.end_at > s.start_at)
      )
  loop
    v_n := v_n + internal.raise_alert(r.user_id, 'late_clock_in',
      (extract(epoch from r.start_at) * 1000000)::bigint::text,
      jsonb_build_object('shift_start', r.start_at, 'grace_min', r.grace), p_now);
  end loop;

  -- Pause time over the daily cap ---------------------------------------------------------
  for r in
    select t.user_id, t.day, t.total_s, pol.pause_daily_max_min as cap_min
    from (
      select p.user_id, p.org_id,
             (p.start_at at time zone u.timezone)::date as day,
             sum(floor(extract(epoch from coalesce(p.end_at, p_now) - p.start_at)))::int as total_s
      from public.pauses p
      join public.users u on u.id = p.user_id
      where u.active
        and exists (
          select 1 from public.pauses recent
          where recent.user_id = p.user_id
            and coalesce(recent.end_at, p_now) > p_now - v_recent
            and (recent.start_at at time zone u.timezone)::date
              = (p.start_at at time zone u.timezone)::date
        )
      group by p.user_id, p.org_id, (p.start_at at time zone u.timezone)::date
    ) t
    join public.orgs o on o.id = t.org_id
    cross join lateral internal.break_pause_policy(t.org_id) pol
    where internal.alert_enabled(o.policy, 'pause_over_cap')
      and t.total_s > pol.pause_daily_max_min * 60
  loop
    v_n := v_n + internal.raise_alert(r.user_id, 'pause_over_cap', r.day::text,
      jsonb_build_object('day', r.day, 'total_s', r.total_s, 'cap_min', r.cap_min), p_now);
  end loop;

  perform internal.queue_alert_emails(p_now);
  return v_n;
end;
$$;

revoke all on function internal.refresh_presence(uuid, timestamptz) from public, anon, authenticated;
revoke all on function internal.alert_eval(timestamptz) from public, anon, authenticated;
