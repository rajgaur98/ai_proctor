-- Anti-cheat extras (#63; ANT-03, ANT-05, ANT-06, ANT-07, DSH-08). The kinds are
-- added in 20261021210301.
--
-- 1. internal.anticheat_from_checkin (from 20261020170000_anticheat.sql) reads the new
--    check-in flags too. Each becomes one "needs review" row per employee, local day and
--    kind, as injected_click already did; nothing reads these rows but the dashboard
--    (ANT-08: never a penalty, never a change to status, segments or timesheets).
--
--      flag on the check-in        kind              details
--      injected_click[:n]          injected_click    {clicks, checkin_ids}   (unchanged)
--      synthetic_click[:n]         synthetic_click   {clicks, checkin_ids}
--      virtual_camera[:name]       virtual_camera    {count, cameras, checkin_ids}
--      duplicate_frame:n           duplicate_frame   {count, min_distance, checkin_ids}
--      virtual_machine             virtual_machine   {count, checkin_ids}
--      remote_session              remote_session    {count, checkin_ids}
--
--    `n` is 1 to 6 digits (a bare click flag counts one; duplicate_frame's distance is
--    0..256, in bits of the agent's 256-bit frame hash); `name` is the camera's name,
--    1 to 24 plain characters. Anything else is ignored, so a malformed flag can never
--    fail the event. A check-in already counted on a row is not counted again. As
--    before, a reviewed row stays reviewed when a later check-in that day adds to it.
--
-- 2. report_rows (latest: 20261020197000_reports_scale.sql) adds per person
--    `anomaly_flags` (their flags on the report's days) and `needs_review` (those not
--    reviewed yet), so reports show anomalies as "needs review" (DSH-08). The rest of
--    the function is unchanged.

-- Adds one check-in's numbers to a flag's details: counts add up, the smallest distance
-- wins, camera names and check-in ids are listed once each.
create function internal.anticheat_merge(p_old jsonb, p_new jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select p_old || p_new || jsonb_strip_nulls(jsonb_build_object(
    'clicks', case when p_new ? 'clicks'
      then coalesce((p_old ->> 'clicks')::int, 0) + (p_new ->> 'clicks')::int end,
    'count', case when p_new ? 'count'
      then coalesce((p_old ->> 'count')::int, 0) + (p_new ->> 'count')::int end,
    'min_distance', case when p_new ? 'min_distance'
      then least((p_old ->> 'min_distance')::int, (p_new ->> 'min_distance')::int) end,
    'cameras', case when p_new ? 'cameras'
      then (select coalesce(jsonb_agg(distinct c.name order by c.name), '[]'::jsonb)
            from jsonb_array_elements_text(coalesce(p_old -> 'cameras', '[]'::jsonb) || (p_new -> 'cameras'))
              as c (name)) end,
    'checkin_ids', coalesce(p_old -> 'checkin_ids', '[]'::jsonb) || coalesce(p_new -> 'checkin_ids', '[]'::jsonb)
  ));
$$;

revoke all on function internal.anticheat_merge(jsonb, jsonb) from public, anon, authenticated;

-- Fires for each new check-in with flags (the trigger from 20261020170000 is unchanged).
create or replace function internal.anticheat_from_checkin()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_day date;
  v_found record;
begin
  select (new.scheduled_at at time zone u.timezone)::date into v_day
  from public.users u where u.id = new.user_id;

  for v_found in
    with parsed as (
      select
        case
          when f ~ '^injected_click(:[0-9]{1,6})?$' then 'injected_click'
          when f ~ '^synthetic_click(:[0-9]{1,6})?$' then 'synthetic_click'
          when f ~ '^virtual_camera(:[A-Za-z0-9 ._-]{1,24})?$' then 'virtual_camera'
          when f ~ '^duplicate_frame:([0-9]{1,2}|1[0-9]{2}|2[0-4][0-9]|25[0-6])$' then 'duplicate_frame'
          when f in ('virtual_machine', 'remote_session') then f
        end as kind,
        substring(f from ':(.*)$') as arg,
        -- The number after the colon, where there is one (never cast otherwise: the
        -- aggregates below see every kind's rows).
        case when f ~ ':[0-9]{1,6}$' then substring(f from ':([0-9]{1,6})$')::int end as n
      from unnest(new.flags) as f
    )
    select p.kind,
      case
        when p.kind in ('injected_click', 'synthetic_click') then
          jsonb_build_object('clicks', sum(coalesce(p.n, 1)))
        when p.kind = 'virtual_camera' then
          jsonb_build_object('count', 1, 'cameras',
            coalesce(jsonb_agg(distinct p.arg) filter (where p.arg is not null), '[]'::jsonb))
        when p.kind = 'duplicate_frame' then
          jsonb_build_object('count', 1, 'min_distance', min(p.n))
        else jsonb_build_object('count', 1)
      end as details
    from parsed p
    where p.kind is not null
    group by p.kind
  loop
    -- Zero clicks (`injected_click:0`) say nothing.
    continue when (v_found.details ->> 'clicks')::int <= 0;

    insert into public.anticheat_flags as a (org_id, user_id, day, kind, details)
    values (new.org_id, new.user_id, v_day, v_found.kind::public.anticheat_kind,
            v_found.details || jsonb_build_object('checkin_ids', jsonb_build_array(new.id)))
    on conflict on constraint anticheat_flags_one_per_day_and_kind do update
    set details = internal.anticheat_merge(a.details, excluded.details)
    where not (a.details -> 'checkin_ids' @> jsonb_build_array(new.id));
  end loop;
  return new;
end;
$$;

revoke all on function internal.anticheat_from_checkin() from public, anon, authenticated;

-- DSH-08: report_rows with each person's anomaly flags ------------------------------------

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

revoke all on function public.report_rows(date, date, uuid[], uuid) from public, anon;
grant execute on function public.report_rows(date, date, uuid[], uuid) to authenticated;
