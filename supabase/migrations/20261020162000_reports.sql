-- #47: reports (DSH-07): hours, check-in rates and break totals per employee.
--
-- report_rows returns one row of raw aggregates per employee for a span of
-- employee-local days. The dashboard adds up the team and formats; nothing here is
-- rounded for display (TS-05/06). Time comes from time_segments with the rules the
-- timesheet totals and the CSV export use (packages/core exportRows.ts, summary.ts):
--   worked    counted and not excluded
--   flagged   flagged and not excluded
--   excluded  excluded
--   break     any break
--   manual    manual-type time that is worked
-- plus pause, which is all pause time (within the cap or over it, excluded or not):
-- how long the person paused, not how it was treated. Whole-second sums, rounded the
-- same way as timesheet_totals, so worked and flagged equal its numbers exactly.
--
-- Check-ins (CHK, DSH-07) are the person's checkin_events whose card was shown (or,
-- failing that, scheduled) in the span, by the employee's local day. "Shown" is every
-- outcome but deferred: a deferred check-in (CHK-03) was not shown and is not a miss,
-- so it is out of the rate. The outcome enum has no deferred value yet; the comparison
-- is on the text so it keeps working when it arrives. Response rate is passed / shown
-- (null when none were shown); the median response time is of passed check-ins.
--
-- Late clock-ins (SHF-06): per shift occurrence that starts in the span (in the
-- shift's own time zone), late means the person clocked in more than the grace after
-- the shift began and had not been clocked in at that point. Someone who never
-- clocked in is a no-show, not a late clock-in. Org policy key (optional, in
-- orgs.policy): late_clock_in_min, int, default 15, kept within 5..60 (PRD section 6).
--
-- The result also carries late_grace_min (the grace in force) and team_median_response_ms
-- (the median over all the people's passed check-ins together; null when none).
--
-- Who is in it: people the caller may view (can_view_user), active ones plus anyone
-- who has data in the span (deactivated users keep their data, ORG-07). The caller's
-- own row is not part of their team view unless they name themselves in p_user_ids.
-- Filters (empty means no filter): p_user_ids names people (one the caller may not
-- view is refused: forbidden); p_manager_id is one manager's direct reports, the team
-- filter until teams exist (ORG-08).

create function public.report_rows(
  p_from date,
  p_to date,
  p_user_ids uuid[] default null,
  p_manager_id uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_me public.users := internal.current_app_user();
  v_grace_min int;
  v_rows jsonb;
  v_team_median float8;
begin
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 365 then
    raise exception 'invalid_range' using errcode = '22023';
  end if;
  if coalesce(cardinality(p_user_ids), 0) > 0
     and exists (select 1 from unnest(p_user_ids) u where u is null or not public.can_view_user(u)) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select greatest(5, least(60, coalesce((o.policy ->> 'late_clock_in_min')::int, 15)))
  into v_grace_min
  from public.orgs o
  where o.id = v_me.org_id;

  with p as (
    select u.id, u.full_name, u.manager_id, u.active,
      p_from::timestamp at time zone u.timezone as from_at,
      (p_to + 1)::timestamp at time zone u.timezone as to_at
    from public.users u
    where u.org_id = v_me.org_id
      and public.can_view_user(u.id)
      and (coalesce(cardinality(p_user_ids), 0) = 0 or u.id = any (p_user_ids))
      and (u.id <> v_me.id or u.id = any (coalesce(p_user_ids, '{}'::uuid[])))
      and (p_manager_id is null or u.manager_id = p_manager_id)
  ),
  r as (
    select p.full_name, p.id as user_id,
      jsonb_build_object(
        'user_id', p.id,
        'full_name', p.full_name,
        'manager_id', p.manager_id,
        'worked_s', seg.worked_s,
        'flagged_s', seg.flagged_s,
        'excluded_s', seg.excluded_s,
        'break_s', seg.break_s,
        'pause_s', seg.pause_s,
        'manual_s', seg.manual_s,
        'checkins_shown', chk.shown,
        'checkins_passed', chk.passed,
        'checkins_missed', chk.missed,
        'checkins_failed', chk.failed,
        'response_rate', case when chk.shown > 0 then chk.passed::float8 / chk.shown end,
        'median_response_ms', chk.median_response_ms,
        'late_clock_ins', late.n
      ) as row
    from p
    cross join lateral (
      select
        count(*) as n,
        coalesce(round(sum(extract(epoch from t.end_at - t.start_at))
          filter (where t.counted and not t.excluded)), 0)::bigint as worked_s,
        coalesce(round(sum(extract(epoch from t.end_at - t.start_at))
          filter (where t.flagged and not t.excluded)), 0)::bigint as flagged_s,
        coalesce(round(sum(extract(epoch from t.end_at - t.start_at))
          filter (where t.excluded)), 0)::bigint as excluded_s,
        coalesce(round(sum(extract(epoch from t.end_at - t.start_at))
          filter (where t.type = 'break')), 0)::bigint as break_s,
        coalesce(round(sum(extract(epoch from t.end_at - t.start_at))
          filter (where t.type in ('pause', 'pause_over_cap'))), 0)::bigint as pause_s,
        coalesce(round(sum(extract(epoch from t.end_at - t.start_at))
          filter (where t.type = 'manual' and t.counted and not t.excluded)), 0)::bigint as manual_s
      from public.time_segments t
      where t.user_id = p.id and t.day between p_from and p_to
    ) seg
    cross join lateral (
      select
        count(*) filter (where c.outcome::text <> 'deferred')::int as shown,
        count(*) filter (where c.outcome::text = 'pass')::int as passed,
        count(*) filter (where c.outcome::text = 'miss')::int as missed,
        count(*) filter (where c.outcome::text = 'failed')::int as failed,
        percentile_cont(0.5) within group (order by c.response_ms)
          filter (where c.outcome::text = 'pass' and c.response_ms is not null) as median_response_ms
      from public.checkin_events c
      where c.user_id = p.id
        and coalesce(c.shown_at, c.scheduled_at) >= p.from_at
        and coalesce(c.shown_at, c.scheduled_at) < p.to_at
    ) chk
    cross join lateral (
      select count(*)::int as n
      from (
        select
          ((p_from + g.n) + s.start_time) at time zone s.timezone as starts_at,
          ((p_from + g.n + case when s.end_time <= s.start_time then 1 else 0 end) + s.end_time)
            at time zone s.timezone as ends_at
        from public.shifts s
        cross join generate_series(0, p_to - p_from) as g (n)
        where s.user_id = p.id and extract(isodow from p_from + g.n)::int = any (s.days)
      ) o
      where exists (
          select 1 from public.clock_sessions cs
          where cs.user_id = p.id
            and cs.start_at > o.starts_at + make_interval(mins => v_grace_min)
            and cs.start_at < o.ends_at)
        and not exists (
          select 1 from public.clock_sessions cs
          where cs.user_id = p.id
            and cs.start_at <= o.starts_at + make_interval(mins => v_grace_min)
            and coalesce(cs.end_at, 'infinity'::timestamptz) > o.starts_at)
    ) late
    where p.active or seg.n > 0 or chk.shown > 0
  )
  select coalesce(jsonb_agg(r.row order by r.full_name, r.user_id), '[]'::jsonb),
    -- The team's median is over every passed check-in of these people, not a median of
    -- their medians. People left out above have no check-ins in the span.
    (select percentile_cont(0.5) within group (order by c.response_ms)
     from public.checkin_events c
     join p on p.id = c.user_id
     where c.outcome::text = 'pass' and c.response_ms is not null
       and coalesce(c.shown_at, c.scheduled_at) >= p.from_at
       and coalesce(c.shown_at, c.scheduled_at) < p.to_at)
  into v_rows, v_team_median
  from r;

  return jsonb_build_object(
    'row_count', jsonb_array_length(v_rows),
    'late_grace_min', v_grace_min,
    'team_median_response_ms', v_team_median,
    'rows', v_rows
  );
end;
$$;

revoke all on function public.report_rows(date, date, uuid[], uuid) from public, anon;
grant execute on function public.report_rows(date, date, uuid[], uuid) to authenticated;
