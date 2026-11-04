-- #305: Insights (INS-01..06). Plain totals and trends of presence and time data for a
-- date range, each against the previous range of the same length. Not AI and never a
-- score: no composite number, no ranking, no top or bottom list (PRD §1.4, INS-03).
--
-- public.insights(from, to, team, people) -----------------------------------------------
-- One call returns everything the Insights page (and an employee's own Insights in My
-- data, INS-05) shows: the team's totals for the range and for the previous range, a
-- series by day (by 7-day bucket from `from` when the range is longer than 62 days), one
-- row per person sorted by name, hours by client, project and task (totals and series),
-- the billable share per team against the team's optional target, the person-days with
-- anti-cheat flags or Tamper (for links to the day view), and the people the person
-- filter offers. Callable with a signed-in person's token (PostgREST RPC), so the MCP
-- server (#307) can expose it as it is.
--
-- Who is in it is report_rows' choice exactly (latest: 20261022160000_report_late_clock_ins):
-- people the caller can view (can_view_user: their reports, their delegators' reports,
-- everyone for owners and admins), narrowed to a team and to named people; the caller
-- only when named (My data passes their own id); deactivated people only when they have
-- segments or shown check-ins in the range. The same 1000-person ceiling
-- (too_many_people), range limits (invalid_range) and access check (forbidden).
--
-- The numbers (INS-04): computed from the same rows with report_rows' rules, raw seconds
-- summed per person over the range and rounded once per person (as report_rows does), so
-- a person's row equals their report row and the totals equal the Reports tab's team
-- totals for the same filters; the projects match report_task_rows (DSH-10). pgTAP
-- (insights.test.sql) checks both. The series rounds per bucket, for the charts only.
--   Time (TS-02): worked, flagged, excluded, break, pause, manual as report_rows. Pause
--     over cap is the pause_over_cap segments (BRK-06); days over the daily pause or
--     break cap compare a person-day's pause or break time with pause_daily_max_min /
--     break_daily_max_min (off when null). Billable: counted, not excluded time whose
--     task is billable, else whose project is (TS-29); Unassigned has no project (PRJ-03).
--   Overtime (TS-19): a person-day's worked seconds above overtime_daily_hours, and a
--     person-week's (the org's week, cut to the range) above overtime_weekly_hours; 0
--     when the threshold is off. Only shown, never deducted.
--   Check-ins (CHK-24): shown (not deferred), passed, missed, failed, response rate
--     (passed / shown) and the median response of the passes, by the person's local day
--     of coalesce(shown_at, scheduled_at). Misses by reason (CHK-23): missed_reason_kind,
--     or none. Deferred (CHK-03): for a call, or for presenting / sharing the screen.
--   Attendance (SHF-06, LV-04): each occurrence of a person's current shifts (active
--     people) whose local start date is in the range and whose start has passed. One
--     that starts on approved leave or a holiday that applies (internal.on_leave_at) is
--     not counted, only reported as a leave shift day. The rest are shift days once the
--     late grace has passed: attended when a clock session overlaps it, else "no
--     clock-in"; late clock-ins are the late_clock_ins rows (as Reports), on time the
--     attended shift days of a person-day without one. Scheduled hours are the counted
--     occurrences' length up to now.
--   Needs review (ANT-08): anti-cheat flags by day (and those not reviewed yet), and
--     Tamper periods (status_periods) by their local start day.
-- Everything is aggregated through two composite types and four internal functions, so
-- the weekly email (below) adds up exactly what the page shows.
--
-- Billable target per team (INS-02) ---------------------------------------------------------
-- teams.billable_target_pct: off (null) unless an owner or admin sets one (1..100) with
-- set_team_billable_target (audit-logged as team.billable_target_changed). The page shows
-- each team's billable share next to its target; nobody is scored against it.
--
-- Weekly insights email (INS-06) ------------------------------------------------------------
-- Optional, alongside the daily digest (ALR-03): notification_prefs.weekly_insights, off
-- unless the person turns it on (set_weekly_insights). weekly_insights_eval runs every 15
-- minutes (pg_cron job `weekly_insights`); each active person with direct reports who
-- turned it on gets one email per org week, from 09:00 local on the first day of the week
-- (reminder_send_at, before 18:00), about the week before against the week before that:
-- their direct reports' totals only, no per-person lines and no names. It waits up to two
-- hours for days still queued for a rebuild (as the digest). weekly_insights_sent keeps
-- (recipient, week) so a week goes once; a week with nothing in it sends nothing. The
-- payload lists the reports' ids, so a person's data deletion removes the emails about
-- them (trigger users_weekly_insights_cleanup); the recipient's own go by address.
--
-- Nothing existing is redefined here. report_rows and report_task_rows are the reference
-- the tests compare with; on_leave_at's rule is repeated inline (see insights_days);
-- week_start and reminder_send_at are called, not changed.

-- Billable target per team ------------------------------------------------------------------

alter table public.teams add column billable_target_pct smallint
  constraint teams_billable_target_pct_range check (billable_target_pct between 1 and 100);

create function public.set_team_billable_target(p_team_id uuid, p_target_pct int)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me public.users := internal.current_app_user();
  v_team public.teams;
begin
  v_team := internal.require_team_admin(p_team_id);
  if p_target_pct is not null and p_target_pct not between 1 and 100 then
    raise exception 'invalid_target' using errcode = '22023';
  end if;
  if v_team.billable_target_pct is not distinct from p_target_pct then
    return;
  end if;
  update public.teams set billable_target_pct = p_target_pct where id = v_team.id;
  perform internal.audit(v_team.org_id, v_me.id, 'team.billable_target_changed', null,
    jsonb_build_object('team_id', v_team.id, 'name', v_team.name,
      'from', v_team.billable_target_pct, 'to', p_target_pct));
end;
$$;

revoke all on function public.set_team_billable_target(uuid, int) from public, anon;
grant execute on function public.set_team_billable_target(uuid, int) to authenticated;

-- Per person-day ------------------------------------------------------------------------------

-- One person's numbers on one of their local days; seconds raw (numeric), not rounded.
create type internal.insights_day as (
  user_id uuid,
  day date,
  seg_n int,
  worked_s numeric,
  flagged_s numeric,
  excluded_s numeric,
  break_s numeric,
  pause_s numeric,
  pause_over_cap_s numeric,
  manual_s numeric,
  billable_s numeric,
  unassigned_s numeric,
  shown int,
  passed int,
  missed int,
  failed int,
  deferred int,
  deferred_call int,
  deferred_presenting int,
  miss_meeting int,
  miss_phone_call int,
  miss_break int,
  miss_away int,
  miss_other int,
  miss_none int,
  pass_ms int[],
  late int,
  shift_days int,
  on_time int,
  no_clock_in int,
  leave_shift_days int,
  scheduled_s numeric,
  flags int,
  unreviewed int,
  tamper int
);

-- The person-days of p_user_ids between p_from and p_to that have anything (segments,
-- check-ins, late clock-ins, shift occurrences, flags or Tamper). p_now decides which
-- shift occurrences have started (and are due).
create function internal.insights_days(
  p_user_ids uuid[],
  p_from date,
  p_to date,
  p_now timestamptz
)
returns setof internal.insights_day
language sql
stable
security definer
set search_path = ''
as $$
  with u as (
    select u.id, u.org_id, u.active, u.timezone, u.work_country, u.work_state,
      p_from::timestamp at time zone u.timezone as from_at,
      (p_to + 1)::timestamp at time zone u.timezone as to_at,
      greatest(5, least(60, coalesce((o.policy ->> 'late_clock_in_min')::int, 15))) as grace_min
    from public.users u
    join public.orgs o on o.id = u.org_id
    where u.id = any (p_user_ids)
  ),
  seg as (
    select t.user_id, t.day, count(*)::int as n,
      coalesce(sum(extract(epoch from t.end_at - t.start_at))
        filter (where t.counted and not t.excluded), 0) as worked_s,
      coalesce(sum(extract(epoch from t.end_at - t.start_at))
        filter (where t.flagged and not t.excluded), 0) as flagged_s,
      coalesce(sum(extract(epoch from t.end_at - t.start_at))
        filter (where t.excluded), 0) as excluded_s,
      coalesce(sum(extract(epoch from t.end_at - t.start_at))
        filter (where t.type = 'break'), 0) as break_s,
      coalesce(sum(extract(epoch from t.end_at - t.start_at))
        filter (where t.type in ('pause', 'pause_over_cap')), 0) as pause_s,
      coalesce(sum(extract(epoch from t.end_at - t.start_at))
        filter (where t.type = 'pause_over_cap'), 0) as pause_over_cap_s,
      coalesce(sum(extract(epoch from t.end_at - t.start_at))
        filter (where t.type = 'manual' and t.counted and not t.excluded), 0) as manual_s,
      coalesce(sum(extract(epoch from t.end_at - t.start_at))
        filter (where t.counted and not t.excluded
                  and coalesce(tk.billable, pr.billable, false)), 0) as billable_s,
      coalesce(sum(extract(epoch from t.end_at - t.start_at))
        filter (where t.counted and not t.excluded and t.project_id is null), 0) as unassigned_s
    from public.time_segments t
    left join public.projects pr on pr.id = t.project_id
    left join public.project_tasks tk on tk.id = t.task_id
    where t.user_id = any (p_user_ids) and t.day between p_from and p_to
    group by t.user_id, t.day
  ),
  chk as (
    select c.user_id, (coalesce(c.shown_at, c.scheduled_at) at time zone u.timezone)::date as day,
      count(*) filter (where c.outcome::text <> 'deferred')::int as shown,
      count(*) filter (where c.outcome::text = 'pass')::int as passed,
      count(*) filter (where c.outcome::text = 'miss')::int as missed,
      count(*) filter (where c.outcome::text = 'failed')::int as failed,
      count(*) filter (where c.outcome::text = 'deferred')::int as deferred,
      count(*) filter (where c.outcome::text = 'deferred' and c.deferral_reason = 'call')::int
        as deferred_call,
      count(*) filter (where c.outcome::text = 'deferred'
                         and c.deferral_reason in ('presenting', 'screen_share'))::int
        as deferred_presenting,
      count(*) filter (where c.outcome::text = 'miss' and c.missed_reason_kind = 'meeting')::int
        as miss_meeting,
      count(*) filter (where c.outcome::text = 'miss' and c.missed_reason_kind = 'phone_call')::int
        as miss_phone_call,
      count(*) filter (where c.outcome::text = 'miss' and c.missed_reason_kind = 'break')::int
        as miss_break,
      count(*) filter (where c.outcome::text = 'miss' and c.missed_reason_kind = 'away')::int
        as miss_away,
      count(*) filter (where c.outcome::text = 'miss' and c.missed_reason_kind = 'other')::int
        as miss_other,
      count(*) filter (where c.outcome::text = 'miss' and c.missed_reason_kind is null)::int
        as miss_none,
      array_agg(c.response_ms::int)
        filter (where c.outcome::text = 'pass' and c.response_ms is not null) as pass_ms
    from u
    join public.checkin_events c on c.user_id = u.id
      and coalesce(c.shown_at, c.scheduled_at) >= u.from_at
      and coalesce(c.shown_at, c.scheduled_at) < u.to_at
    group by 1, 2
  ),
  late as (
    select l.user_id, l.day, count(*)::int as n
    from public.late_clock_ins l
    where l.user_id = any (p_user_ids) and l.day between p_from and p_to
    group by 1, 2
  ),
  -- Occurrences of the active people's shifts that have started, on the shift's own local
  -- date (as late_clock_ins.day). On leave is internal.on_leave_at's rule, written out here:
  -- a security definer function runs once per row (never inlined), which for every shift
  -- of a month of a large org is most of the call's time.
  occ as (
    select s.user_id, d.day, o.starts_at, o.ends_at, u.grace_min,
      exists (
        select 1 from public.leave_requests r
        where r.user_id = s.user_id and r.status = 'approved'
          and r.start_at <= o.starts_at and r.end_at > o.starts_at
      )
      or exists (
        select 1 from public.holidays h
        where h.org_id = u.org_id
          and h.day = (o.starts_at at time zone u.timezone)::date
          and internal.holiday_applies(h.country, h.state, u.work_country, u.work_state)
      ) as on_leave
    from public.shifts s
    join u on u.id = s.user_id and u.active
    cross join lateral generate_series(p_from::timestamp, p_to::timestamp, interval '1 day') g (d)
    cross join lateral (select g.d::date as day) d
    cross join lateral (
      select (d.day + s.start_time) at time zone s.timezone as starts_at,
        ((d.day + case when s.end_time <= s.start_time then 1 else 0 end) + s.end_time)
          at time zone s.timezone as ends_at
    ) o
    where extract(isodow from d.day)::int = any (s.days)
      and o.starts_at <= p_now
  ),
  att as (
    select x.user_id, x.day,
      count(*) filter (where not x.on_leave and x.due)::int as shift_days,
      count(*) filter (where not x.on_leave and x.due and x.attended)::int as attended,
      count(*) filter (where not x.on_leave and x.due and not x.attended)::int as no_clock_in,
      count(*) filter (where x.on_leave)::int as leave_shift_days,
      coalesce(sum(extract(epoch from least(x.ends_at, p_now) - x.starts_at))
        filter (where not x.on_leave), 0) as scheduled_s
    from (
      select o.user_id, o.day, o.on_leave, o.starts_at, o.ends_at,
        o.starts_at + make_interval(mins => o.grace_min) <= p_now as due,
        exists (
          select 1 from public.clock_sessions cs
          where cs.user_id = o.user_id
            and cs.start_at < o.ends_at
            and coalesce(cs.end_at, 'infinity'::timestamptz) > o.starts_at
        ) as attended
      from occ o
    ) x
    group by 1, 2
  ),
  flg as (
    select f.user_id, f.day, count(*)::int as n,
      count(*) filter (where f.reviewed_at is null)::int as unreviewed
    from public.anticheat_flags f
    where f.user_id = any (p_user_ids) and f.day between p_from and p_to
    group by 1, 2
  ),
  tmp as (
    select sp.user_id, (sp.start_at at time zone u.timezone)::date as day, count(*)::int as n
    from u
    join public.status_periods sp on sp.user_id = u.id
      and sp.status = 'tamper'
      and sp.start_at >= u.from_at and sp.start_at < u.to_at
    group by 1, 2
  ),
  k as (
    select user_id, day from seg
    union select user_id, day from chk
    union select user_id, day from late
    union select user_id, day from att
    union select user_id, day from flg
    union select user_id, day from tmp
  )
  select k.user_id, k.day,
    coalesce(seg.n, 0),
    coalesce(seg.worked_s, 0), coalesce(seg.flagged_s, 0), coalesce(seg.excluded_s, 0),
    coalesce(seg.break_s, 0), coalesce(seg.pause_s, 0), coalesce(seg.pause_over_cap_s, 0),
    coalesce(seg.manual_s, 0), coalesce(seg.billable_s, 0), coalesce(seg.unassigned_s, 0),
    coalesce(chk.shown, 0), coalesce(chk.passed, 0), coalesce(chk.missed, 0),
    coalesce(chk.failed, 0), coalesce(chk.deferred, 0), coalesce(chk.deferred_call, 0),
    coalesce(chk.deferred_presenting, 0),
    coalesce(chk.miss_meeting, 0), coalesce(chk.miss_phone_call, 0), coalesce(chk.miss_break, 0),
    coalesce(chk.miss_away, 0), coalesce(chk.miss_other, 0), coalesce(chk.miss_none, 0),
    coalesce(chk.pass_ms, '{}'::int[]),
    coalesce(late.n, 0),
    coalesce(att.shift_days, 0),
    greatest(coalesce(att.attended, 0) - coalesce(late.n, 0), 0),
    coalesce(att.no_clock_in, 0),
    coalesce(att.leave_shift_days, 0),
    coalesce(att.scheduled_s, 0),
    coalesce(flg.n, 0), coalesce(flg.unreviewed, 0),
    coalesce(tmp.n, 0)
  from k
  left join seg on seg.user_id = k.user_id and seg.day = k.day
  left join chk on chk.user_id = k.user_id and chk.day = k.day
  left join late on late.user_id = k.user_id and late.day = k.day
  left join att on att.user_id = k.user_id and att.day = k.day
  left join flg on flg.user_id = k.user_id and flg.day = k.day
  left join tmp on tmp.user_id = k.user_id and tmp.day = k.day;
$$;

-- Per person ------------------------------------------------------------------------------------

-- One person's numbers for a range: whole seconds, each rounded once from the raw sum.
create type internal.insights_person as (
  user_id uuid,
  full_name text,
  team_id uuid,
  active boolean,
  worked_s bigint,
  flagged_s bigint,
  excluded_s bigint,
  break_s bigint,
  pause_s bigint,
  pause_over_cap_s bigint,
  manual_s bigint,
  billable_s bigint,
  unassigned_s bigint,
  scheduled_s bigint,
  shift_days int,
  on_time int,
  late_clock_ins int,
  no_clock_in int,
  leave_shift_days int,
  checkins_shown int,
  checkins_passed int,
  checkins_missed int,
  checkins_failed int,
  checkins_deferred int,
  deferred_call int,
  deferred_presenting int,
  miss_meeting int,
  miss_phone_call int,
  miss_break int,
  miss_away int,
  miss_other int,
  miss_none int,
  pass_ms int[],
  median_response_ms float8,
  pause_days_over_cap int,
  break_days_over_cap int,
  overtime_daily_s bigint,
  overtime_days int,
  overtime_weekly_s bigint,
  overtime_weeks int,
  anomaly_flags int,
  needs_review int,
  tamper int
);

-- The people of p_user_ids for a range, by name, from their person-days (p_days, from
-- insights_days for the same people and range): active people, and deactivated ones with
-- segments or shown check-ins, as report_rows picks them.
create function internal.insights_people(
  p_org_id uuid,
  p_user_ids uuid[],
  p_days internal.insights_day[],
  p_from date,
  p_to date
)
returns setof internal.insights_person
language sql
stable
security definer
set search_path = ''
as $$
  with lim as (
    select
      (x.p ->> 'pause_daily_max_min')::numeric * 60 as pause_cap_s,
      (x.p ->> 'break_daily_max_min')::numeric * 60 as break_cap_s,
      round((x.p ->> 'overtime_daily_hours')::numeric * 3600) as ot_day_s,
      round((x.p ->> 'overtime_weekly_hours')::numeric * 3600) as ot_week_s,
      coalesce(array_position(
        array['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'],
        lower(x.p ->> 'week_start')), 1) as wk
    from (select internal.policy_defaults() || o.policy as p from public.orgs o where o.id = p_org_id) x
  ),
  d as (
    select * from unnest(p_days) d where d.user_id = any (p_user_ids) and d.day between p_from and p_to
  ),
  per as (
    select d.user_id,
      sum(d.seg_n)::int as seg_n,
      round(sum(d.worked_s))::bigint as worked_s,
      round(sum(d.flagged_s))::bigint as flagged_s,
      round(sum(d.excluded_s))::bigint as excluded_s,
      round(sum(d.break_s))::bigint as break_s,
      round(sum(d.pause_s))::bigint as pause_s,
      round(sum(d.pause_over_cap_s))::bigint as pause_over_cap_s,
      round(sum(d.manual_s))::bigint as manual_s,
      round(sum(d.billable_s))::bigint as billable_s,
      round(sum(d.unassigned_s))::bigint as unassigned_s,
      round(sum(d.scheduled_s))::bigint as scheduled_s,
      sum(d.shift_days)::int as shift_days,
      sum(d.on_time)::int as on_time,
      sum(d.late)::int as late,
      sum(d.no_clock_in)::int as no_clock_in,
      sum(d.leave_shift_days)::int as leave_shift_days,
      sum(d.shown)::int as shown,
      sum(d.passed)::int as passed,
      sum(d.missed)::int as missed,
      sum(d.failed)::int as failed,
      sum(d.deferred)::int as deferred,
      sum(d.deferred_call)::int as deferred_call,
      sum(d.deferred_presenting)::int as deferred_presenting,
      sum(d.miss_meeting)::int as miss_meeting,
      sum(d.miss_phone_call)::int as miss_phone_call,
      sum(d.miss_break)::int as miss_break,
      sum(d.miss_away)::int as miss_away,
      sum(d.miss_other)::int as miss_other,
      sum(d.miss_none)::int as miss_none,
      count(*) filter (where l.pause_cap_s is not null and d.pause_s > l.pause_cap_s)::int
        as pause_days_over_cap,
      count(*) filter (where l.break_cap_s is not null and d.break_s > l.break_cap_s)::int
        as break_days_over_cap,
      coalesce(sum(round(d.worked_s) - l.ot_day_s)
        filter (where round(d.worked_s) > l.ot_day_s), 0)::bigint as overtime_daily_s,
      count(*) filter (where round(d.worked_s) > l.ot_day_s)::int as overtime_days,
      sum(d.flags)::int as flags,
      sum(d.unreviewed)::int as unreviewed,
      sum(d.tamper)::int as tamper
    from d cross join lim l
    group by d.user_id
  ),
  weeks as (
    select w.user_id,
      coalesce(sum(round(w.s) - l.ot_week_s) filter (where round(w.s) > l.ot_week_s), 0)::bigint
        as overtime_weekly_s,
      count(*) filter (where round(w.s) > l.ot_week_s)::int as overtime_weeks
    from (
      select d.user_id, d.day - ((extract(isodow from d.day)::int - l.wk + 7) % 7) as week,
        sum(d.worked_s) as s
      from d cross join lim l
      group by 1, 2
    ) w
    cross join lim l
    group by w.user_id
  ),
  ms as (
    select d.user_id, array_agg(m order by m) as pass_ms,
      percentile_cont(0.5) within group (order by m) as median
    from d cross join lateral unnest(d.pass_ms) as m
    group by d.user_id
  )
  select u.id, u.full_name, u.team_id, u.active,
    coalesce(per.worked_s, 0), coalesce(per.flagged_s, 0), coalesce(per.excluded_s, 0),
    coalesce(per.break_s, 0), coalesce(per.pause_s, 0), coalesce(per.pause_over_cap_s, 0),
    coalesce(per.manual_s, 0), coalesce(per.billable_s, 0), coalesce(per.unassigned_s, 0),
    coalesce(per.scheduled_s, 0),
    coalesce(per.shift_days, 0), coalesce(per.on_time, 0), coalesce(per.late, 0),
    coalesce(per.no_clock_in, 0), coalesce(per.leave_shift_days, 0),
    coalesce(per.shown, 0), coalesce(per.passed, 0), coalesce(per.missed, 0),
    coalesce(per.failed, 0), coalesce(per.deferred, 0), coalesce(per.deferred_call, 0),
    coalesce(per.deferred_presenting, 0),
    coalesce(per.miss_meeting, 0), coalesce(per.miss_phone_call, 0), coalesce(per.miss_break, 0),
    coalesce(per.miss_away, 0), coalesce(per.miss_other, 0), coalesce(per.miss_none, 0),
    coalesce(ms.pass_ms, '{}'::int[]), ms.median,
    coalesce(per.pause_days_over_cap, 0), coalesce(per.break_days_over_cap, 0),
    coalesce(per.overtime_daily_s, 0), coalesce(per.overtime_days, 0),
    coalesce(weeks.overtime_weekly_s, 0), coalesce(weeks.overtime_weeks, 0),
    coalesce(per.flags, 0), coalesce(per.unreviewed, 0), coalesce(per.tamper, 0)
  from public.users u
  left join per on per.user_id = u.id
  left join weeks on weeks.user_id = u.id
  left join ms on ms.user_id = u.id
  where u.id = any (p_user_ids)
    and u.org_id = p_org_id
    and (u.active or coalesce(per.seg_n, 0) > 0 or coalesce(per.shown, 0) > 0)
  order by u.full_name, u.id;
$$;

-- A group's totals from its people: seconds and counts added up from the people's rows
-- (as the Reports tab adds its rows), the response rate as passed over shown, and the
-- median over every pass of every person together (report_rows' team median).
create function internal.insights_totals(p_people internal.insights_person[])
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object(
    'people', count(*)::int,
    'worked_s', coalesce(sum(p.worked_s), 0)::bigint,
    'flagged_s', coalesce(sum(p.flagged_s), 0)::bigint,
    'excluded_s', coalesce(sum(p.excluded_s), 0)::bigint,
    'break_s', coalesce(sum(p.break_s), 0)::bigint,
    'pause_s', coalesce(sum(p.pause_s), 0)::bigint,
    'pause_over_cap_s', coalesce(sum(p.pause_over_cap_s), 0)::bigint,
    'manual_s', coalesce(sum(p.manual_s), 0)::bigint,
    'billable_s', coalesce(sum(p.billable_s), 0)::bigint,
    'unassigned_s', coalesce(sum(p.unassigned_s), 0)::bigint,
    'scheduled_s', coalesce(sum(p.scheduled_s), 0)::bigint,
    'shift_days', coalesce(sum(p.shift_days), 0)::int,
    'on_time', coalesce(sum(p.on_time), 0)::int,
    'late_clock_ins', coalesce(sum(p.late_clock_ins), 0)::int,
    'no_clock_in', coalesce(sum(p.no_clock_in), 0)::int,
    'leave_shift_days', coalesce(sum(p.leave_shift_days), 0)::int,
    'checkins_shown', coalesce(sum(p.checkins_shown), 0)::int,
    'checkins_passed', coalesce(sum(p.checkins_passed), 0)::int,
    'checkins_missed', coalesce(sum(p.checkins_missed), 0)::int,
    'checkins_failed', coalesce(sum(p.checkins_failed), 0)::int,
    'checkins_deferred', coalesce(sum(p.checkins_deferred), 0)::int,
    'deferred_call', coalesce(sum(p.deferred_call), 0)::int,
    'deferred_presenting', coalesce(sum(p.deferred_presenting), 0)::int,
    'miss_meeting', coalesce(sum(p.miss_meeting), 0)::int,
    'miss_phone_call', coalesce(sum(p.miss_phone_call), 0)::int,
    'miss_break', coalesce(sum(p.miss_break), 0)::int,
    'miss_away', coalesce(sum(p.miss_away), 0)::int,
    'miss_other', coalesce(sum(p.miss_other), 0)::int,
    'miss_none', coalesce(sum(p.miss_none), 0)::int,
    'response_rate', case when sum(p.checkins_shown) > 0
      then sum(p.checkins_passed)::float8 / sum(p.checkins_shown) end,
    'median_response_ms', (
      select percentile_cont(0.5) within group (order by m)
      from unnest(p_people) q cross join lateral unnest(q.pass_ms) as m
    ),
    'pause_days_over_cap', coalesce(sum(p.pause_days_over_cap), 0)::int,
    'break_days_over_cap', coalesce(sum(p.break_days_over_cap), 0)::int,
    'overtime_daily_s', coalesce(sum(p.overtime_daily_s), 0)::bigint,
    'overtime_days', coalesce(sum(p.overtime_days), 0)::int,
    'overtime_weekly_s', coalesce(sum(p.overtime_weekly_s), 0)::bigint,
    'overtime_weeks', coalesce(sum(p.overtime_weeks), 0)::int,
    'anomaly_flags', coalesce(sum(p.anomaly_flags), 0)::int,
    'needs_review', coalesce(sum(p.needs_review), 0)::int,
    'tamper', coalesce(sum(p.tamper), 0)::int
  )
  from unnest(p_people) p;
$$;

-- A person's row as the page reads it: their numbers and response rate, without the
-- response times themselves.
create function internal.insights_person_json(p internal.insights_person)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select (to_jsonb(p) - 'pass_ms') || jsonb_build_object('response_rate',
    case when p.checkins_shown > 0 then p.checkins_passed::float8 / p.checkins_shown end);
$$;

revoke all on function internal.insights_days(uuid[], date, date, timestamptz) from public, anon, authenticated;
revoke all on function internal.insights_people(uuid, uuid[], internal.insights_day[], date, date) from public, anon, authenticated;
revoke all on function internal.insights_totals(internal.insights_person[]) from public, anon, authenticated;
revoke all on function internal.insights_person_json(internal.insights_person) from public, anon, authenticated;

-- The page -------------------------------------------------------------------------------------

create function public.insights(
  p_from date,
  p_to date,
  p_team_id uuid default null,
  p_user_ids uuid[] default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_me public.users := internal.current_app_user();
  -- report_rows' ceiling: one response the page adds up itself.
  c_max_people constant int := 1000;
  -- Person-days with flags or Tamper listed for the links (the counts are all of them).
  c_max_review_days constant int := 500;
  v_now timestamptz := now();
  v_len int;
  v_prev_from date;
  v_prev_to date;
  v_step int;
  v_policy jsonb;
  v_ot_day_s numeric;
  v_ids uuid[];
  v_people int;
  v_cur_days internal.insights_day[];
  v_prev_days internal.insights_day[];
  v_cur internal.insights_person[];
  v_prev internal.insights_person[];
  v_keep uuid[];
  v_series jsonb;
  v_projects jsonb;
  v_project_series jsonb;
  v_teams jsonb;
  v_review jsonb;
  v_review_total int;
  v_options jsonb;
begin
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 365 then
    raise exception 'invalid_range' using errcode = '22023';
  end if;
  if coalesce(cardinality(p_user_ids), 0) > 0
     and exists (select 1 from unnest(p_user_ids) u where u is null or not public.can_view_user(u)) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  v_len := p_to - p_from + 1;
  v_prev_to := p_from - 1;
  v_prev_from := p_from - v_len;
  -- By day up to two months, else by 7-day buckets from p_from (the last may be shorter).
  v_step := case when v_len > 62 then 7 else 1 end;

  -- report_rows' choice of people (deactivated ones are dropped per range below).
  select coalesce(array_agg(u.id), '{}'::uuid[])
  into v_ids
  from public.users u
  where u.org_id = v_me.org_id
    and public.can_view_user(u.id)
    and (coalesce(cardinality(p_user_ids), 0) = 0 or u.id = any (p_user_ids))
    and (u.id <> v_me.id or u.id = any (coalesce(p_user_ids, '{}'::uuid[])))
    and (p_team_id is null or u.team_id = p_team_id);

  select count(*)::int into v_people
  from (
    select 1 from public.users u
    where u.id = any (v_ids)
      and (u.active
           or exists (select 1 from public.time_segments t
                      where t.user_id = u.id and t.day between v_prev_from and p_to))
    limit c_max_people + 1
  ) c;
  if v_people > c_max_people then
    raise exception 'too_many_people' using errcode = '54000',
      detail = format('Insights hold up to %s people; choose a team.', c_max_people);
  end if;

  select internal.policy_defaults() || o.policy into v_policy
  from public.orgs o where o.id = v_me.org_id;
  v_ot_day_s := round((v_policy ->> 'overtime_daily_hours')::numeric * 3600);

  v_cur_days := array(select d from internal.insights_days(v_ids, p_from, p_to, v_now) d);
  v_prev_days := array(select d from internal.insights_days(v_ids, v_prev_from, v_prev_to, v_now) d);
  v_cur := array(select p from internal.insights_people(v_me.org_id, v_ids, v_cur_days, p_from, p_to) p);
  v_prev := array(
    select p from internal.insights_people(v_me.org_id, v_ids, v_prev_days, v_prev_from, v_prev_to) p);
  v_keep := array(select p.user_id from unnest(v_cur) p);

  -- The series: every bucket of the range, empty ones too, for the kept people.
  select coalesce(jsonb_agg(jsonb_build_object(
      'bucket', b.bucket,
      'worked_s', coalesce(s.worked_s, 0),
      'flagged_s', coalesce(s.flagged_s, 0),
      'excluded_s', coalesce(s.excluded_s, 0),
      'scheduled_s', coalesce(s.scheduled_s, 0),
      'break_s', coalesce(s.break_s, 0),
      'pause_s', coalesce(s.pause_s, 0),
      'pause_over_cap_s', coalesce(s.pause_over_cap_s, 0),
      'billable_s', coalesce(s.billable_s, 0),
      'unassigned_s', coalesce(s.unassigned_s, 0),
      'overtime_daily_s', coalesce(s.overtime_daily_s, 0),
      'shift_days', coalesce(s.shift_days, 0),
      'on_time', coalesce(s.on_time, 0),
      'late_clock_ins', coalesce(s.late, 0),
      'no_clock_in', coalesce(s.no_clock_in, 0),
      'checkins_shown', coalesce(s.shown, 0),
      'checkins_passed', coalesce(s.passed, 0),
      'checkins_missed', coalesce(s.missed, 0),
      'checkins_failed', coalesce(s.failed, 0),
      'checkins_deferred', coalesce(s.deferred, 0),
      'response_rate', case when s.shown > 0 then s.passed::float8 / s.shown end,
      'median_response_ms', m.median,
      'anomaly_flags', coalesce(s.flags, 0),
      'needs_review', coalesce(s.unreviewed, 0),
      'tamper', coalesce(s.tamper, 0)
    ) order by b.bucket), '[]'::jsonb)
  into v_series
  from (
    select g::date as bucket
    from generate_series(p_from::timestamp, p_to::timestamp, make_interval(days => v_step)) g
  ) b
  left join (
    select p_from + ((d.day - p_from) / v_step) * v_step as bucket,
      round(sum(d.worked_s))::bigint as worked_s,
      round(sum(d.flagged_s))::bigint as flagged_s,
      round(sum(d.excluded_s))::bigint as excluded_s,
      round(sum(d.scheduled_s))::bigint as scheduled_s,
      round(sum(d.break_s))::bigint as break_s,
      round(sum(d.pause_s))::bigint as pause_s,
      round(sum(d.pause_over_cap_s))::bigint as pause_over_cap_s,
      round(sum(d.billable_s))::bigint as billable_s,
      round(sum(d.unassigned_s))::bigint as unassigned_s,
      coalesce(sum(round(d.worked_s) - v_ot_day_s)
        filter (where round(d.worked_s) > v_ot_day_s), 0)::bigint as overtime_daily_s,
      sum(d.shift_days)::int as shift_days,
      sum(d.on_time)::int as on_time,
      sum(d.late)::int as late,
      sum(d.no_clock_in)::int as no_clock_in,
      sum(d.shown)::int as shown,
      sum(d.passed)::int as passed,
      sum(d.missed)::int as missed,
      sum(d.failed)::int as failed,
      sum(d.deferred)::int as deferred,
      sum(d.flags)::int as flags,
      sum(d.unreviewed)::int as unreviewed,
      sum(d.tamper)::int as tamper
    from unnest(v_cur_days) d
    where d.user_id = any (v_keep)
    group by 1
  ) s on s.bucket = b.bucket
  left join (
    select p_from + ((d.day - p_from) / v_step) * v_step as bucket,
      percentile_cont(0.5) within group (order by m) as median
    from unnest(v_cur_days) d cross join lateral unnest(d.pass_ms) as m
    where d.user_id = any (v_keep)
    group by 1
  ) m on m.bucket = b.bucket;

  -- Projects (DSH-10): worked time per project and task, rounded per person, project and
  -- task over the range like report_task_rows, then added up; and per bucket for the chart.
  with seg as (
    select t.user_id, t.project_id, t.task_id,
      p_from + ((t.day - p_from) / v_step) * v_step as bucket,
      sum(extract(epoch from t.end_at - t.start_at)) as s
    from public.time_segments t
    where t.user_id = any (v_keep) and t.day between p_from and p_to
      and t.counted and not t.excluded
    group by 1, 2, 3, 4
  )
  select
    (select coalesce(jsonb_agg(jsonb_build_object(
        'project_id', x.project_id,
        'project_name', pr.name,
        'client_id', pr.client_id,
        'client_name', cl.name,
        'task_id', x.task_id,
        'task_name', tk.name,
        'billable', case when x.project_id is null then false
                         else coalesce(tk.billable, pr.billable, false) end,
        'worked_s', x.worked_s,
        'people', x.people
      ) order by cl.name nulls last, pr.name nulls last, x.project_id nulls last,
                 tk.sort_order nulls first, tk.name nulls first), '[]'::jsonb)
     from (
       select y.project_id, y.task_id, sum(y.s)::bigint as worked_s,
         count(distinct y.user_id)::int as people
       from (
         select seg.user_id, seg.project_id, seg.task_id, round(sum(seg.s)) as s
         from seg group by 1, 2, 3
       ) y
       group by 1, 2
     ) x
     left join public.projects pr on pr.id = x.project_id
     left join public.clients cl on cl.id = pr.client_id
     left join public.project_tasks tk on tk.id = x.task_id),
    (select coalesce(jsonb_agg(jsonb_build_object(
        'bucket', z.bucket, 'project_id', z.project_id, 'task_id', z.task_id,
        'worked_s', z.worked_s) order by z.bucket, z.project_id nulls last, z.task_id nulls last),
        '[]'::jsonb)
     from (
       select seg.bucket, seg.project_id, seg.task_id, round(sum(seg.s))::bigint as worked_s
       from seg group by 1, 2, 3
     ) z)
  into v_projects, v_project_series;

  -- The billable share per team, next to the team's target (INS-02).
  select coalesce(jsonb_agg(jsonb_build_object(
      'team_id', t.id, 'name', t.name, 'billable_target_pct', t.billable_target_pct,
      'people', x.people, 'worked_s', x.worked_s, 'billable_s', x.billable_s
    ) order by t.name, t.id), '[]'::jsonb)
  into v_teams
  from (
    select p.team_id, count(*)::int as people, sum(p.worked_s)::bigint as worked_s,
      sum(p.billable_s)::bigint as billable_s
    from unnest(v_cur) p
    where p.team_id is not null
    group by 1
  ) x
  join public.teams t on t.id = x.team_id;

  -- Needs review (ANT-08): the person-days to open, newest first, then by name.
  select count(*)::int into v_review_total
  from unnest(v_cur_days) d
  where d.user_id = any (v_keep) and (d.flags > 0 or d.tamper > 0);
  select coalesce(jsonb_agg(jsonb_build_object(
      'user_id', r.user_id, 'full_name', r.full_name, 'day', r.day,
      'anomaly_flags', r.flags, 'needs_review', r.unreviewed, 'tamper', r.tamper
    ) order by r.day desc, r.full_name, r.user_id), '[]'::jsonb)
  into v_review
  from (
    select d.user_id, u.full_name, d.day, d.flags, d.unreviewed, d.tamper
    from unnest(v_cur_days) d
    join public.users u on u.id = d.user_id
    where d.user_id = any (v_keep) and (d.flags > 0 or d.tamper > 0)
    order by d.day desc, u.full_name, d.user_id
    limit c_max_review_days
  ) r;

  -- Who the person filter offers: the team's people the caller can see, by name.
  select coalesce(jsonb_agg(jsonb_build_object('user_id', o.id, 'full_name', o.full_name,
      'active', o.active) order by o.full_name, o.id), '[]'::jsonb)
  into v_options
  from (
    select u.id, u.full_name, u.active
    from public.users u
    where u.org_id = v_me.org_id
      and public.can_view_user(u.id)
      and (u.id <> v_me.id or u.id = any (coalesce(p_user_ids, '{}'::uuid[])))
      and (p_team_id is null or u.team_id = p_team_id)
    order by u.full_name, u.id
    limit c_max_people
  ) o;

  return jsonb_build_object(
    'from', p_from,
    'to', p_to,
    'previous_from', v_prev_from,
    'previous_to', v_prev_to,
    'bucket', case when v_step = 7 then 'week' else 'day' end,
    'late_grace_min', greatest(5, least(60, coalesce((v_policy ->> 'late_clock_in_min')::int, 15))),
    'caps', jsonb_build_object(
      'pause_max_min', v_policy -> 'pause_max_min',
      'pause_daily_max_min', v_policy -> 'pause_daily_max_min',
      'break_daily_max_min', v_policy -> 'break_daily_max_min'),
    'overtime', jsonb_build_object(
      'daily_hours', v_policy -> 'overtime_daily_hours',
      'weekly_hours', v_policy -> 'overtime_weekly_hours'),
    'billable_target_pct', (select t.billable_target_pct from public.teams t
                            where t.id = p_team_id and t.org_id = v_me.org_id),
    'totals', internal.insights_totals(v_cur),
    'previous_totals', internal.insights_totals(v_prev),
    'people', coalesce((select jsonb_agg(internal.insights_person_json(p)
                          order by p.full_name, p.user_id) from unnest(v_cur) p), '[]'::jsonb),
    'series', v_series,
    'projects', v_projects,
    'project_series', v_project_series,
    'teams', v_teams,
    'review_days', v_review,
    'review_days_total', v_review_total,
    'people_options', v_options
  );
end;
$$;

revoke all on function public.insights(date, date, uuid, uuid[]) from public, anon;
grant execute on function public.insights(date, date, uuid, uuid[]) to authenticated;

-- Weekly insights email (INS-06) ---------------------------------------------------------------

alter table public.notification_prefs
  add column weekly_insights boolean not null default false;

-- The caller turns their weekly insights email on or off. Returns the new value.
create function public.set_weekly_insights(p_enabled boolean)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me public.users := internal.current_app_user();
begin
  if p_enabled is null then
    raise exception 'invalid_value' using errcode = '22023';
  end if;
  insert into public.notification_prefs (user_id, org_id, weekly_insights, updated_at)
  values (v_me.id, v_me.org_id, p_enabled, now())
  on conflict (user_id) do update
    set weekly_insights = excluded.weekly_insights, updated_at = excluded.updated_at;
  return p_enabled;
end;
$$;

revoke all on function public.set_weekly_insights(boolean) from public, anon;
grant execute on function public.set_weekly_insights(boolean) to authenticated;

create table public.weekly_insights_sent (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  recipient_id uuid not null references public.users (id) on delete cascade,
  -- The first day of the org week it is about.
  week_start date not null,
  -- Null when the week had nothing to report and no email was sent.
  email_id uuid references public.email_outbox (id) on delete set null,
  sent_at timestamptz not null default now(),
  constraint weekly_insights_sent_once unique (recipient_id, week_start)
);

alter table public.weekly_insights_sent enable row level security;
-- Internal bookkeeping: no policies, no grants.
revoke all on public.weekly_insights_sent from anon, authenticated;

-- The evaluation (every 15 minutes). Returns the number of emails queued. `p_now` is for
-- tests; cron uses the default.
create function internal.weekly_insights_eval(p_now timestamptz default now())
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
  v_ids uuid[];
  v_cur internal.insights_person[];
  v_prev internal.insights_person[];
  v_tot jsonb;
  v_email_id uuid;
  v_n int := 0;
begin
  -- A slow run must not overlap the next one.
  if not pg_try_advisory_xact_lock(hashtext('weekly_insights_eval')) then
    return 0;
  end if;

  for r in
    select m.id, m.org_id, m.email, m.full_name, m.timezone, s.send_at,
      w.ws - 7 as week_from, w.ws - 1 as week_to
    from public.users m
    join public.notification_prefs np on np.user_id = m.id and np.weekly_insights
    cross join lateral (select (p_now at time zone m.timezone)::date as today) l
    cross join lateral (select internal.week_start(m.org_id, l.today) as ws) w
    cross join lateral (
      select internal.reminder_send_at(w.ws::timestamp at time zone m.timezone, m.timezone) as send_at
    ) s
    where m.active
      and p_now >= s.send_at
      and (p_now at time zone m.timezone)::time < time '18:00'
      and exists (
        select 1 from public.users e
        where e.manager_id = m.id and e.org_id = m.org_id and e.id <> m.id
      )
      and not exists (
        select 1 from public.weekly_insights_sent x
        where x.recipient_id = m.id and x.week_start = w.ws - 7
      )
  loop
    -- Final numbers first: a report's day still waiting for its rebuild holds the email,
    -- for up to two hours.
    continue when p_now < r.send_at + interval '2 hours' and exists (
      select 1 from public.dirty_days dd
      join public.users e on e.id = dd.user_id
      where e.manager_id = r.id and dd.day between r.week_from and r.week_to
    );

    v_ids := array(
      select e.id from public.users e
      where e.manager_id = r.id and e.org_id = r.org_id and e.id <> r.id
    );
    v_cur := array(select p from internal.insights_people(r.org_id, v_ids,
      array(select d from internal.insights_days(v_ids, r.week_from, r.week_to, p_now) d),
      r.week_from, r.week_to) p);
    v_tot := internal.insights_totals(v_cur);
    v_email_id := null;

    if (v_tot ->> 'worked_s')::bigint > 0 or (v_tot ->> 'checkins_shown')::int > 0
       or (v_tot ->> 'shift_days')::int > 0 or (v_tot ->> 'anomaly_flags')::int > 0
       or (v_tot ->> 'tamper')::int > 0 then
      v_prev := array(select p from internal.insights_people(r.org_id, v_ids,
        array(select d from internal.insights_days(v_ids, r.week_from - 7, r.week_to - 7, p_now) d),
        r.week_from - 7, r.week_to - 7) p);
      insert into public.email_outbox (org_id, to_email, template, payload, batch_key, created_at, send_after)
      values (
        r.org_id, r.email, 'weekly_insights',
        jsonb_build_object(
          'recipient_name', r.full_name,
          'recipient_timezone', r.timezone,
          'week_from', r.week_from,
          'week_to', r.week_to,
          'report_ids', to_jsonb(v_ids),
          'current', v_tot,
          'previous', internal.insights_totals(v_prev)
        ),
        'weekly_insights:' || r.id || ':' || r.week_from, p_now, p_now
      )
      returning id into v_email_id;
      v_n := v_n + 1;
    end if;
    insert into public.weekly_insights_sent (org_id, recipient_id, week_start, email_id, sent_at)
    values (r.org_id, r.id, r.week_from, v_email_id, p_now);
  end loop;

  return v_n;
end;
$$;

-- A person's data deletion removes the weekly emails that added up their numbers (by
-- payload.report_ids); their own (to their address) go with the deletion's other emails.
create function internal.users_weekly_insights_cleanup()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.email_outbox o
  where o.org_id = old.org_id and o.template = 'weekly_insights'
    and o.payload -> 'report_ids' ? old.id::text;
  return old;
end;
$$;

create trigger users_weekly_insights_cleanup
before delete on public.users
for each row execute function internal.users_weekly_insights_cleanup();

revoke all on function internal.weekly_insights_eval(timestamptz) from public, anon, authenticated;
revoke all on function internal.users_weekly_insights_cleanup() from public, anon, authenticated;

select cron.schedule('weekly_insights', '*/15 * * * *', 'select internal.weekly_insights_eval()');
