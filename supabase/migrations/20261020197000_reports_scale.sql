-- #156: reports for large orgs (DSH-07, NFR-PERF-03: pages load in < 2 s p95 for orgs up
-- to 500 users). scripts/it-reports-scale.sql measures report_rows on a synthetic org;
-- with a year of history for 500 people it was slow in three places, all fixed here:
--   * a person's check-ins were found by user_id and then filtered by "shown, or else
--     scheduled" time, so every check-in they ever had was read: an index on that
--     expression (user_id, coalesce(shown_at, scheduled_at)) serves the span directly;
--   * the team median read checkin_events a second time, by a scan of the whole table;
--     it now comes from the response times the people's rows were built from;
--   * "was not clocked in when the shift began" read the person's whole session
--     history for every shift occurrence: an index on when a session ended (open ones
--     as infinity) bounds it to the sessions after the shift began.
-- And report_rows has a ceiling of 1000 people (too_many_people, SQLSTATE 54000): the
-- whole report is one response the dashboard sorts, pages and adds up, so it must not
-- grow without limit, and a report that silently left people out would have wrong
-- totals. Above it, the caller picks a team (p_manager_id) or names (p_user_ids).
--
-- The rest of report_rows is the definition from 20261020162000_reports.sql, unchanged.

create index checkin_events_user_effective_idx
  on public.checkin_events (user_id, (coalesce(shown_at, scheduled_at)));

create index clock_sessions_user_end_idx
  on public.clock_sessions (user_id, (coalesce(end_at, 'infinity'::timestamptz)));

create or replace function public.report_rows(
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
  -- The most people one report holds. The whole report is one response the dashboard
  -- sorts, pages and adds up itself, so it has a ceiling; the PRD's pilot orgs are ~500.
  c_max_people constant int := 1000;
  v_people int;
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

  -- Over the ceiling the caller narrows to a team (p_manager_id) or to names rather than
  -- get a report whose totals leave people out. Counted the way the report picks people,
  -- cheaply: deactivated people count only when they have data in the span.
  select count(*)::int into v_people
  from (
    select 1
    from public.users u
    where u.org_id = v_me.org_id
      and public.can_view_user(u.id)
      and (coalesce(cardinality(p_user_ids), 0) = 0 or u.id = any (p_user_ids))
      and (u.id <> v_me.id or u.id = any (coalesce(p_user_ids, '{}'::uuid[])))
      and (p_manager_id is null or u.manager_id = p_manager_id)
      and (u.active
           or exists (select 1 from public.time_segments t
                      where t.user_id = u.id and t.day between p_from and p_to)
           or exists (select 1 from public.checkin_events c
                      where c.user_id = u.id
                        and coalesce(c.shown_at, c.scheduled_at) >= p_from::timestamp at time zone u.timezone
                        and coalesce(c.shown_at, c.scheduled_at) < (p_to + 1)::timestamp at time zone u.timezone))
    limit c_max_people + 1
  ) c;
  if v_people > c_max_people then
    raise exception 'too_many_people' using errcode = '54000',
      detail = format('A report holds up to %s people; choose a team.', c_max_people);
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
    select p.full_name, p.id as user_id, chk.pass_ms,
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
          filter (where c.outcome::text = 'pass' and c.response_ms is not null) as median_response_ms,
        array_agg(c.response_ms) filter (where c.outcome::text = 'pass' and c.response_ms is not null) as pass_ms
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
    -- their medians: the response times each person's row was built from, taken together
    -- (not read again from checkin_events).
    (select percentile_cont(0.5) within group (order by ms)
     from r r2 cross join lateral unnest(r2.pass_ms) as ms)
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
