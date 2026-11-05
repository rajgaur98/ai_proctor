-- #344: shift history (SHF-01, 20261105950000) in the day view and in late clock-in alerts.
--
-- Day view ---------------------------------------------------------------------------------
-- public.day_shifts(person, day): the shifts that applied to the person on that local day
-- and the day before (a shift past midnight that started the day before runs into it), one
-- row per occurrence date, from public.shift_history with the rule internal.shift_occurrences
-- uses (the version with valid_from <= day < valid_to, on its weekdays). The day page and
-- My data draw a past day from it, so editing a shift today leaves earlier days showing the
-- shift they had; today keeps reading public.shifts (the shift editor's own query). Readable
-- by whoever can see the person (can_view_user), like their shifts.
--
-- Late clock-in alerts (ALR-01) --------------------------------------------------------------
-- internal.alert_eval looks at the occurrences that started today and yesterday (in the
-- shift's own zone). Today's stays on public.shifts (the live "now" check); yesterday's (a
-- night shift still running after midnight) is now the shift that applied yesterday, from
-- the history, so editing a shift after midnight doesn't change last night's.
--
-- Neither changes how a person-day is computed (insights_days_live), so the Insights cache
-- (20261105960000) is left as it is.
--
-- Redefined here, copied from its latest definition with only this change:
--   alert_eval (20261105110000_time_off): yesterday's occurrences from shift_history

create function public.day_shifts(p_user_id uuid, p_day date)
returns table (day date, days int[], start_time time, end_time time, timezone text)
language sql
stable
security definer
set search_path = ''
as $$
  select d.day, s.days, s.start_time, s.end_time, s.timezone
  from public.shift_history s
  cross join lateral (values (p_day - 1), (p_day)) d (day)
  where public.can_view_user(p_user_id)
    and s.user_id = p_user_id
    and s.valid_from <= d.day
    and (s.valid_to is null or s.valid_to > d.day)
    and extract(isodow from d.day)::int = any (s.days)
  order by d.day, s.start_time;
$$;

revoke all on function public.day_shifts(uuid, date) from public, anon;
grant execute on function public.day_shifts(uuid, date) to authenticated;

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
      -- LV-04: no offline alert for an Offline period that began on leave.
      and not internal.on_leave_at(p.user_id, p.since)
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
  -- (a shift past midnight belongs to the day it starts on). Today's is the current
  -- shift; yesterday's is the shift that applied that day (shift history, SHF-01).
  for r in
    select u.id as user_id, g.grace, s.start_at
    from public.users u
    join public.orgs o on o.id = u.org_id
    cross join lateral (
      select (p_now at time zone c.timezone)::date as day, c.days, c.start_time, c.end_time,
             c.timezone
      from public.shifts c
      where c.user_id = u.id
      union all
      select y.day, h.days, h.start_time, h.end_time, h.timezone
      from public.shift_history h
      cross join lateral (select (p_now at time zone h.timezone)::date - 1 as day) y
      where h.user_id = u.id
        and h.valid_from <= y.day
        and (h.valid_to is null or h.valid_to > y.day)
    ) sh
    cross join lateral (
      select internal.alert_policy_int(o.policy, 'late_clock_in_min', 15, 5, 60) as grace
    ) g
    cross join lateral (
      select ((sh.day + sh.start_time) at time zone sh.timezone) as start_at,
             (((sh.day + case when sh.end_time < sh.start_time then 1 else 0 end) + sh.end_time)
                at time zone sh.timezone) as end_at
    ) s
    where u.active
      and internal.alert_enabled(o.policy, 'late_clock_in')
      and extract(isodow from sh.day)::int = any (sh.days)
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
      -- LV-04: a shift that starts on leave or a holiday is not late.
      and not internal.on_leave_at(u.id, s.start_at)
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
