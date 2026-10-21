-- Reports count late clock-ins from the late_clock_ins table (#238, SHF-06), not from the
-- current shifts. #67 records each late clock-in when the clock session is written (shift
-- start, clock-in, grace that applied then), so editing a shift or the late_clock_in_min
-- policy no longer rewrites the counts of past days. A person's count is the rows whose
-- shift day (the shift's own local date) is in the report's span. Rows for sessions that
-- already existed were backfilled by #67's migration.
--
-- `late_grace_min` in the response is still the org's current grace, for the dashboard's
-- label; it is no longer used to count.
--
-- The rest is the latest definition, from 20261022130000_anticheat_report_rows.sql (#63),
-- unchanged. Same signature, so a replace.

create or replace function public.report_rows(
  p_from date,
  p_to date,
  p_user_ids uuid[] default null,
  p_manager_id uuid default null,
  p_team_id uuid default null
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

  -- Over the ceiling the caller narrows to a team (p_team_id) or to names rather than
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
      and (p_team_id is null or u.team_id = p_team_id)
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
    select u.id, u.full_name, u.manager_id, u.team_id, u.active,
      p_from::timestamp at time zone u.timezone as from_at,
      (p_to + 1)::timestamp at time zone u.timezone as to_at
    from public.users u
    where u.org_id = v_me.org_id
      and public.can_view_user(u.id)
      and (coalesce(cardinality(p_user_ids), 0) = 0 or u.id = any (p_user_ids))
      and (u.id <> v_me.id or u.id = any (coalesce(p_user_ids, '{}'::uuid[])))
      and (p_manager_id is null or u.manager_id = p_manager_id)
      and (p_team_id is null or u.team_id = p_team_id)
  ),
  r as (
    select p.full_name, p.id as user_id, chk.pass_ms,
      jsonb_build_object(
        'user_id', p.id,
        'full_name', p.full_name,
        'manager_id', p.manager_id,
        'team_id', p.team_id,
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
        'late_clock_ins', late.n,
        -- DSH-08 (#63): the person's anti-cheat flags on these days, and how many of
        -- them nobody has reviewed yet ("needs review").
        'anomaly_flags', flg.total,
        'needs_review', flg.unreviewed
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
      from public.late_clock_ins l
      where l.user_id = p.id and l.day between p_from and p_to
    ) late
    cross join lateral (
      select count(*)::int as total,
        count(*) filter (where f.reviewed_at is null)::int as unreviewed
      from public.anticheat_flags f
      where f.user_id = p.id and f.day between p_from and p_to
    ) flg
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

revoke all on function public.report_rows(date, date, uuid[], uuid, uuid) from public, anon;
grant execute on function public.report_rows(date, date, uuid[], uuid, uuid) to authenticated;
