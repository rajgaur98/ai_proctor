-- #329: Insights, part 2 (INS-02, INS-04, SHF-01, LV-05): leave hours, shift history and one
-- leave rule in the numbers, and ranges up to a year in under 2 s at 500 people.
--
-- Leave hours (LV-05) ----------------------------------------------------------------------
-- Every person-day, person, total and bucket has leave_s: the paid leave and holidays that
-- day counts (internal.leave_days, the timesheet's Leave row and Reports' leave_s), apart
-- from worked time. Rounded once per person-day there, so a person's leave_s equals their
-- report row's and the totals equal the Reports tab's (insights.test.sql checks it).
--
-- Attendance from shift history (SHF-01) ---------------------------------------------------
-- Shift days, scheduled hours and "no clock-in" come from internal.shift_occurrences (the
-- shift that applied each day, 20261105950000), so editing a shift today leaves earlier days
-- as they were. On leave is internal.leave_periods (the one leave rule), taken once per
-- person as a multirange instead of a lookup per occurrence.
--
-- Long ranges: the person-day cache ---------------------------------------------------------
-- A year of a 500-person org is ~130k person-days built from ~650k segments, ~1M check-ins
-- and ~130k shift occurrences, twice (the range and the previous one): seconds of work per
-- call. So the person-day rows of days that are over are kept, computed once:
--   * public.insights_daily: one internal.insights_day row per person and local day (empty
--     days too, as all zeros, so a missing row means "not computed"), for days up to three
--     days before today (UTC): by then every shift occurrence of the day has started and
--     ended and its late grace has passed, so the row no longer depends on the time it is
--     read. public.insights_daily_projects: that day's worked seconds per project and task.
--   * insights_daily_fill (pg_cron `insights_daily_fill`, every 5 minutes) computes the
--     missing rows of the last 800 days (a year and its previous year), a bounded number of
--     person-days per run, and drops rows older than that.
--   * Triggers on everything a row is computed from forget the person-days a change touches
--     (insights_daily_forget): time_segments, checkin_events, late_clock_ins, clock_sessions,
--     shift_history, leave_requests, holidays, anticheat_flags, Tamper status_periods,
--     users (time zone, active, work location), and projects / project_tasks (billable). A
--     change to a day that recent never touches the cache. The next fill recomputes them.
--   * Readers (insights_days, insights_project_days) take the kept rows and compute the rest
--     (the last three days, and any day forgotten and not refilled yet) from the source
--     tables (insights_days_live), so a read is always what the sources say now.
--   * A fill and a change to the same person can't cross: a change takes a shared advisory
--     lock on the person (insights_daily_key) before it forgets; a fill only computes people
--     whose exclusive lock it gets without waiting, and computes them after taking it.
--   Changing how a person-day is computed (insights_days_live) means emptying the cache in
--   the same migration: `truncate public.insights_daily, public.insights_daily_projects`.
--
-- Redefined here, each copied from its latest definition (20261105500000_insights) with only
-- these changes:
--   insights_days        now the reader; the computation moved to insights_days_live
--                        (+ leave_s, shift history, leave_periods)
--   insights_people      now insights_range without the series (new signature, so the old
--                        is dropped): reads insights_days itself, + leave_s
--   insights_totals      + leave_s
--   public.insights      + leave_s in the series; one insights_range call gives the range's
--                        people, series and days to review from one read of the person-days
--                        (no arrays of person-days); work_mem 64MB for a year's medians
--   weekly_insights_eval insights_people's new signature
-- New: insights_range (the per-person numbers, series and review of one range; the per-person
-- part is the old insights_people body), insights_days_live, insights_project_days(_live),
-- insights_daily_cover/_fill/_forget and the cache tables and triggers.

-- Types ------------------------------------------------------------------------------------

alter type internal.insights_day add attribute leave_s numeric;
alter type internal.insights_person add attribute leave_s bigint;

-- The cache ----------------------------------------------------------------------------------

create table public.insights_daily of internal.insights_day (
  user_id with options not null references public.users (id) on delete cascade,
  day with options not null,
  primary key (user_id, day)
);

create index insights_daily_day_idx on public.insights_daily (day);
alter table public.insights_daily enable row level security;
-- Internal: no policies, no grants.
revoke all on public.insights_daily from anon, authenticated;

create table public.insights_daily_projects (
  user_id uuid not null references public.users (id) on delete cascade,
  day date not null,
  project_id uuid,
  task_id uuid,
  worked_s numeric not null
);

create index insights_daily_projects_user_day_idx on public.insights_daily_projects (user_id, day);
create index insights_daily_projects_day_idx on public.insights_daily_projects (day);
alter table public.insights_daily_projects enable row level security;
revoke all on public.insights_daily_projects from anon, authenticated;

-- The last day the cache holds, for a read at p_now: three days before its UTC date.
create function internal.insights_daily_last(p_now timestamptz)
returns date
language sql
immutable
set search_path = ''
as $$
  select (p_now at time zone 'UTC')::date - 3;
$$;

-- The advisory lock key of a person's cached days.
create function internal.insights_daily_key(p_user_id uuid)
returns bigint
language sql
immutable
set search_path = ''
as $$
  select hashtextextended('insights_daily:' || p_user_id::text, 0);
$$;

-- An empty person-day: what the cache keeps for a day with nothing in it.
create function internal.insights_day_empty(p_user_id uuid, p_day date)
returns internal.insights_day
language sql
immutable
set search_path = ''
as $$
  select row(p_user_id, p_day, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, '{}'::int[], 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)::internal.insights_day;
$$;

-- Forgets the people's cached days from p_from to p_to (both included), after taking the
-- people's shared locks so a fill running for them finishes first. Days after the cache's
-- last day are never kept: nothing to do.
create function internal.insights_daily_forget(p_user_ids uuid[], p_from date, p_to date)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_from is null or p_to is null or coalesce(cardinality(p_user_ids), 0) = 0
     or p_from > internal.insights_daily_last(now()) then
    return;
  end if;
  perform pg_advisory_xact_lock_shared(internal.insights_daily_key(i.id))
  from (select distinct unnest(p_user_ids) as id order by 1) i;
  delete from public.insights_daily c
  where c.user_id = any (p_user_ids) and c.day between p_from and p_to;
  delete from public.insights_daily_projects c
  where c.user_id = any (p_user_ids) and c.day between p_from and p_to;
end;
$$;

-- The computation ----------------------------------------------------------------------------

-- The person-days of p_user_ids between p_from and p_to that have anything (segments,
-- check-ins, late clock-ins, shift occurrences, flags, Tamper or leave), from the source
-- tables. p_now decides which shift occurrences have started (and are due).
create function internal.insights_days_live(
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
    select u.id, u.org_id, u.active, u.timezone,
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
  -- The active people's shift occurrences that have started, from the shift that applied
  -- that day, on the shift's own local date (as late_clock_ins.day).
  occ as (
    select o.user_id, o.day, o.starts_at, o.ends_at, u.grace_min
    from internal.shift_occurrences(p_user_ids, p_from, p_to) o
    join u on u.id = o.user_id and u.active
    where o.starts_at <= p_now
  ),
  -- On leave (LV-04) is internal.leave_periods, the rule on_leave_at reads: everyone's
  -- leave around the range at once, one multirange per person.
  lv as (
    select l.user_id, range_agg(tstzrange(l.start_at, l.end_at)) as mr
    from internal.leave_periods(p_user_ids, (p_from - 2)::timestamp at time zone 'UTC',
      (p_to + 3)::timestamp at time zone 'UTC') l
    group by 1
  ),
  -- Each occurrence once (the booleans first, so the lookups run once per occurrence).
  occ_x as materialized (
    select o.user_id, o.day, o.starts_at, o.ends_at,
      coalesce(lv.mr @> o.starts_at, false) as on_leave,
      o.starts_at + make_interval(mins => o.grace_min) <= p_now as due,
      exists (
        select 1 from public.clock_sessions cs
        where cs.user_id = o.user_id
          and cs.start_at < o.ends_at
          and coalesce(cs.end_at, 'infinity'::timestamptz) > o.starts_at
      ) as attended
    from occ o
    left join lv on lv.user_id = o.user_id
  ),
  att as (
    select x.user_id, x.day,
      count(*) filter (where not x.on_leave and x.due)::int as shift_days,
      count(*) filter (where not x.on_leave and x.due and x.attended)::int as attended,
      count(*) filter (where not x.on_leave and x.due and not x.attended)::int as no_clock_in,
      count(*) filter (where x.on_leave)::int as leave_shift_days,
      coalesce(sum(extract(epoch from least(x.ends_at, p_now) - x.starts_at))
        filter (where not x.on_leave), 0) as scheduled_s
    from occ_x x
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
  -- LV-05: the leave seconds of the day (the timesheet's Leave row).
  lvd as (
    select l.user_id, l.day, l.seconds
    from internal.leave_days(p_user_ids, p_from, p_to) l
    where l.seconds > 0
  ),
  k as (
    select user_id, day from seg
    union select user_id, day from chk
    union select user_id, day from late
    union select user_id, day from att
    union select user_id, day from flg
    union select user_id, day from tmp
    union select user_id, day from lvd
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
    coalesce(tmp.n, 0),
    coalesce(lvd.seconds, 0)::numeric
  from k
  left join seg on seg.user_id = k.user_id and seg.day = k.day
  left join chk on chk.user_id = k.user_id and chk.day = k.day
  left join late on late.user_id = k.user_id and late.day = k.day
  left join att on att.user_id = k.user_id and att.day = k.day
  left join flg on flg.user_id = k.user_id and flg.day = k.day
  left join tmp on tmp.user_id = k.user_id and tmp.day = k.day
  left join lvd on lvd.user_id = k.user_id and lvd.day = k.day;
$$;

-- Worked seconds per person, day, project and task, from the segments (DSH-10).
create function internal.insights_project_days_live(p_user_ids uuid[], p_from date, p_to date)
returns table (user_id uuid, day date, project_id uuid, task_id uuid, worked_s numeric)
language sql
stable
security definer
set search_path = ''
as $$
  select t.user_id, t.day, t.project_id, t.task_id, sum(extract(epoch from t.end_at - t.start_at))
  from public.time_segments t
  where t.user_id = any (p_user_ids) and t.day between p_from and p_to
    and t.counted and not t.excluded
  group by 1, 2, 3, 4;
$$;

-- Reading ----------------------------------------------------------------------------------

-- What a read of p_user_ids from p_from to p_to at p_now takes from the cache: the days up
-- to `last`, except for the people in `gap_ids`, whose days from gap_from to gap_to are
-- not all kept (those that are, are read from the cache too).
create function internal.insights_daily_cover(
  p_user_ids uuid[],
  p_from date,
  p_to date,
  p_now timestamptz
)
returns table (last date, gap_ids uuid[], gap_from date, gap_to date)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_last date := least(p_to, internal.insights_daily_last(p_now));
  v_gap uuid[];
  v_from date;
  v_to date;
begin
  if v_last < p_from then
    return query select p_from - 1, '{}'::uuid[], null::date, null::date;
    return;
  end if;
  select coalesce(array_agg(i.id), '{}') into v_gap
  from unnest(p_user_ids) i (id)
  left join (
    select c.user_id, count(*)::int as n from public.insights_daily c
    where c.user_id = any (p_user_ids) and c.day between p_from and v_last
    group by 1
  ) c on c.user_id = i.id
  where coalesce(c.n, 0) < v_last - p_from + 1;
  if cardinality(v_gap) > 0 then
    select min(d.day), max(d.day) into v_from, v_to
    from unnest(v_gap) i (id)
    cross join lateral (
      select g::date as day from generate_series(p_from::timestamp, v_last::timestamp, interval '1 day') g
    ) d
    where not exists (
      select 1 from public.insights_daily c where c.user_id = i.id and c.day = d.day
    );
  end if;
  return query select v_last, v_gap, v_from, v_to;
end;
$$;


-- The person-days of p_user_ids between p_from and p_to that have anything, as
-- insights_days_live returns them: kept days from the cache, the rest computed. Plain SQL
-- (callers are security definer) so it is inlined into the query that reads it.
create or replace function internal.insights_days(
  p_user_ids uuid[],
  p_from date,
  p_to date,
  p_now timestamptz
)
returns setof internal.insights_day
language sql
stable
as $$
  with v as (
    select * from internal.insights_daily_cover(p_user_ids, p_from, p_to, p_now)
  )
  select c.*
  from v
  join public.insights_daily c on c.user_id = any (p_user_ids)
    and c.day between p_from and least(p_to, internal.insights_daily_last(p_now))
  where c.seg_n > 0 or c.shown > 0 or c.deferred > 0 or c.late > 0 or c.shift_days > 0
    or c.leave_shift_days > 0 or c.scheduled_s <> 0 or c.flags > 0 or c.tamper > 0
    or c.leave_s <> 0
  union all
  select l.*
  from v
  cross join lateral internal.insights_days_live(v.gap_ids, v.gap_from, v.gap_to, p_now) l
  where cardinality(v.gap_ids) > 0
    and not exists (
      select 1 from public.insights_daily c where c.user_id = l.user_id and c.day = l.day
    )
  union all
  select l.*
  from v
  cross join lateral internal.insights_days_live(p_user_ids, v.last + 1, p_to, p_now) l
  where v.last < p_to;
$$;

-- Worked seconds per person, day, project and task, the same way.
create function internal.insights_project_days(
  p_user_ids uuid[],
  p_from date,
  p_to date,
  p_now timestamptz
)
returns table (user_id uuid, day date, project_id uuid, task_id uuid, worked_s numeric)
language sql
stable
as $$
  with v as (
    select * from internal.insights_daily_cover(p_user_ids, p_from, p_to, p_now)
  )
  select c.user_id, c.day, c.project_id, c.task_id, c.worked_s
  from v
  join public.insights_daily_projects c on c.user_id = any (p_user_ids)
    and c.day between p_from and least(p_to, internal.insights_daily_last(p_now))
  union all
  select l.*
  from v
  cross join lateral internal.insights_project_days_live(v.gap_ids, v.gap_from, v.gap_to) l
  where cardinality(v.gap_ids) > 0
    and not exists (
      select 1 from public.insights_daily c where c.user_id = l.user_id and c.day = l.day
    )
  union all
  select l.*
  from v
  cross join lateral internal.insights_project_days_live(p_user_ids, v.last + 1, p_to) l
  where v.last < p_to;
$$;

-- Filling ------------------------------------------------------------------------------------

-- Computes the missing cached days of the last 800 days (up to insights_daily_last), at
-- most about p_budget person-days per run, and drops kept days older than that. Returns
-- the number of person-days written.
create function internal.insights_daily_fill(p_budget int default 100000)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_to date := internal.insights_daily_last(now());
  v_from date := internal.insights_daily_last(now()) - 799;
  r record;
  v_ids uuid[] := '{}';
  v_first date;
  v_last date;
  v_cost bigint := 0;
  v_n int;
begin
  -- One fill at a time.
  if not pg_try_advisory_xact_lock(hashtext('insights_daily_fill')) then
    return 0;
  end if;

  delete from public.insights_daily where day < v_from;
  delete from public.insights_daily_projects where day < v_from;

  -- People with days missing, each with their first and last missing day. A person a
  -- change is forgetting right now is left for the next run.
  for r in
    select u.id, m.first_day, m.last_day
    from public.users u
    cross join lateral (
      select count(*)::int as n from public.insights_daily c
      where c.user_id = u.id and c.day between v_from and v_to
    ) c
    cross join lateral (
      select min(g::date) as first_day, max(g::date) as last_day
      from generate_series(v_from::timestamp, v_to::timestamp, interval '1 day') g
      where not exists (
        select 1 from public.insights_daily x where x.user_id = u.id and x.day = g::date
      )
    ) m
    where c.n < v_to - v_from + 1
    order by u.id
  loop
    exit when v_cost >= p_budget;
    continue when not pg_try_advisory_xact_lock(internal.insights_daily_key(r.id));
    v_ids := v_ids || r.id;
    v_first := least(v_first, r.first_day);
    v_last := greatest(v_last, r.last_day);
    v_cost := v_cost + (r.last_day - r.first_day + 1);
  end loop;
  if cardinality(v_ids) = 0 then
    return 0;
  end if;

  -- Computed now, after the locks: every change to these people is committed or waits.
  with keys as (
    select i.id as user_id, g::date as day
    from unnest(v_ids) i (id)
    cross join generate_series(v_first::timestamp, v_last::timestamp, interval '1 day') g
    where not exists (
      select 1 from public.insights_daily x where x.user_id = i.id and x.day = g::date
    )
  ),
  ins as (
    insert into public.insights_daily
    select (coalesce(l, internal.insights_day_empty(k.user_id, k.day))).*
    from keys k
    left join internal.insights_days_live(v_ids, v_first, v_last, now()) l
      on l.user_id = k.user_id and l.day = k.day
    returning user_id, day
  ),
  proj as (
    insert into public.insights_daily_projects (user_id, day, project_id, task_id, worked_s)
    select p.user_id, p.day, p.project_id, p.task_id, p.worked_s
    from internal.insights_project_days_live(v_ids, v_first, v_last) p
    join ins on ins.user_id = p.user_id and ins.day = p.day
  )
  select count(*)::int into v_n from ins;
  return v_n;
end;
$$;

select cron.schedule('insights_daily_fill', '*/5 * * * *', 'select internal.insights_daily_fill()');

-- Forgetting -----------------------------------------------------------------------------------

-- time_segments and checkin_events change many rows at once (a day's rebuild, a sync, a
-- purge): once per statement, per person, from their first to their last day touched.
-- A check-in's local day is within a day of its UTC date.
create function internal.insights_forget_rows()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_users uuid[] := '{}';
  v_days date[] := '{}';
  v_u uuid[];
  v_d date[];
  r record;
begin
  if tg_table_name = 'time_segments' then
    if tg_op in ('INSERT', 'UPDATE') then
      select array_agg(n.user_id), array_agg(n.day) into v_u, v_d from new_rows n;
      v_users := v_users || coalesce(v_u, '{}'); v_days := v_days || coalesce(v_d, '{}');
    end if;
    if tg_op in ('DELETE', 'UPDATE') then
      select array_agg(o.user_id), array_agg(o.day) into v_u, v_d from old_rows o;
      v_users := v_users || coalesce(v_u, '{}'); v_days := v_days || coalesce(v_d, '{}');
    end if;
  else
    if tg_op in ('INSERT', 'UPDATE') then
      select array_agg(n.user_id), array_agg((coalesce(n.shown_at, n.scheduled_at) at time zone 'UTC')::date)
      into v_u, v_d from new_rows n;
      v_users := v_users || coalesce(v_u, '{}'); v_days := v_days || coalesce(v_d, '{}');
    end if;
    if tg_op in ('DELETE', 'UPDATE') then
      select array_agg(o.user_id), array_agg((coalesce(o.shown_at, o.scheduled_at) at time zone 'UTC')::date)
      into v_u, v_d from old_rows o;
      v_users := v_users || coalesce(v_u, '{}'); v_days := v_days || coalesce(v_d, '{}');
    end if;
  end if;

  for r in
    select x.user_id, min(x.day) - 1 as first_day, max(x.day) + 1 as last_day
    from unnest(v_users, v_days) x (user_id, day)
    group by 1
    having min(x.day) - 1 <= internal.insights_daily_last(now())
  loop
    perform internal.insights_daily_forget(array[r.user_id], r.first_day, r.last_day);
  end loop;
  return null;
end;
$$;

create trigger time_segments_insights_insert after insert on public.time_segments
referencing new table as new_rows for each statement execute function internal.insights_forget_rows();
create trigger time_segments_insights_update after update on public.time_segments
referencing old table as old_rows new table as new_rows
for each statement execute function internal.insights_forget_rows();
create trigger time_segments_insights_delete after delete on public.time_segments
referencing old table as old_rows for each statement execute function internal.insights_forget_rows();
create trigger checkin_events_insights_insert after insert on public.checkin_events
referencing new table as new_rows for each statement execute function internal.insights_forget_rows();
create trigger checkin_events_insights_update after update on public.checkin_events
referencing old table as old_rows new table as new_rows
for each statement execute function internal.insights_forget_rows();
create trigger checkin_events_insights_delete after delete on public.checkin_events
referencing old table as old_rows for each statement execute function internal.insights_forget_rows();

-- Everything else, a row at a time: the person-days a row (before and after) can touch.
create function internal.insights_forget_row()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_last date := internal.insights_daily_last(now());
  v_rows jsonb[] := '{}';
  v jsonb;
  v_from date;
  v_to date;
  v_ids uuid[];
begin
  if tg_op in ('INSERT', 'UPDATE') then
    v_rows := v_rows || to_jsonb(new);
  end if;
  if tg_op in ('DELETE', 'UPDATE') then
    v_rows := v_rows || to_jsonb(old);
  end if;

  if tg_table_name = 'shift_history' and tg_op = 'UPDATE' then
    if (old.user_id, old.days, old.start_time, old.end_time, old.timezone, old.valid_from)
       is not distinct from
       (new.user_id, new.days, new.start_time, new.end_time, new.timezone, new.valid_from) then
      -- Closed or reopened: only the days from the earlier end on changed.
      perform internal.insights_daily_forget(array[new.user_id],
        least(coalesce(old.valid_to, 'infinity'), coalesce(new.valid_to, 'infinity')) - 1,
        'infinity');
      return null;
    end if;
  end if;

  foreach v in array v_rows loop
    v_ids := array[(v ->> 'user_id')::uuid];
    case tg_table_name
      when 'late_clock_ins', 'anticheat_flags' then
        v_from := (v ->> 'day')::date;
        v_to := v_from;
      when 'clock_sessions' then
        v_from := ((v ->> 'start_at')::timestamptz at time zone 'UTC')::date - 2;
        v_to := (coalesce((v ->> 'end_at')::timestamptz, now()) at time zone 'UTC')::date + 1;
      when 'leave_requests' then
        v_from := ((v ->> 'start_at')::timestamptz at time zone 'UTC')::date - 2;
        v_to := ((v ->> 'end_at')::timestamptz at time zone 'UTC')::date + 2;
      when 'status_periods' then
        continue when v ->> 'status' <> 'tamper';
        v_from := ((v ->> 'start_at')::timestamptz at time zone 'UTC')::date - 1;
        v_to := v_from + 2;
      when 'shift_history' then
        v_from := (v ->> 'valid_from')::date - 1;
        v_to := coalesce((v ->> 'valid_to')::date, 'infinity');
      when 'holidays' then
        v_from := (v ->> 'day')::date - 2;
        v_to := (v ->> 'day')::date + 2;
        v_ids := array(select u.id from public.users u where u.org_id = (v ->> 'org_id')::uuid);
      when 'users' then
        v_ids := array[(v ->> 'id')::uuid];
        v_from := '-infinity';
        v_to := 'infinity';
      when 'projects', 'project_tasks' then
        v_ids := array(select u.id from public.users u where u.org_id = (v ->> 'org_id')::uuid);
        v_from := '-infinity';
        v_to := 'infinity';
    end case;
    if v_from <= v_last then
      perform internal.insights_daily_forget(v_ids, v_from, v_to);
    end if;
  end loop;
  return null;
end;
$$;

create trigger late_clock_ins_insights after insert or update or delete on public.late_clock_ins
for each row execute function internal.insights_forget_row();
create trigger anticheat_flags_insights after insert or update or delete on public.anticheat_flags
for each row execute function internal.insights_forget_row();
create trigger clock_sessions_insights after insert or update or delete on public.clock_sessions
for each row execute function internal.insights_forget_row();
create trigger leave_requests_insights after insert or update or delete on public.leave_requests
for each row execute function internal.insights_forget_row();
-- Only Tamper periods count; the rest of the (frequent) status changes skip the function.
create trigger status_periods_insights_insert after insert on public.status_periods
for each row when (new.status = 'tamper') execute function internal.insights_forget_row();
create trigger status_periods_insights_update after update on public.status_periods
for each row when (old.status = 'tamper' or new.status = 'tamper')
execute function internal.insights_forget_row();
create trigger status_periods_insights_delete after delete on public.status_periods
for each row when (old.status = 'tamper') execute function internal.insights_forget_row();
create trigger shift_history_insights after insert or update or delete on public.shift_history
for each row execute function internal.insights_forget_row();
create trigger holidays_insights after insert or update or delete on public.holidays
for each row execute function internal.insights_forget_row();
create trigger users_insights after update of timezone, active, work_country, work_state
on public.users
for each row when ((old.timezone, old.active, old.work_country, old.work_state)
  is distinct from (new.timezone, new.active, new.work_country, new.work_state))
execute function internal.insights_forget_row();
create trigger projects_insights after update of billable on public.projects
for each row when (old.billable is distinct from new.billable)
execute function internal.insights_forget_row();
create trigger project_tasks_insights after update of billable on public.project_tasks
for each row when (old.billable is distinct from new.billable)
execute function internal.insights_forget_row();

-- Per person, totals, the page and the weekly email ------------------------------------------

drop function internal.insights_people(uuid, uuid[], internal.insights_day[], date, date);

-- One range of p_user_ids, from one read of their person-days (insights_days): the people
-- by name (active people, and deactivated ones with segments or shown check-ins, as
-- report_rows picks them) and, when p_step is given, the series by bucket of p_step days
-- from p_from and the person-days to review (ANT-08) of those people, newest first, at
-- most p_max_review (and how many there are).
create function internal.insights_range(
  p_org_id uuid,
  p_user_ids uuid[],
  p_from date,
  p_to date,
  p_now timestamptz,
  p_step int,
  p_max_review int
)
returns table (people internal.insights_person[], series jsonb, review jsonb, review_total int)
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
  d as materialized (
    select * from internal.insights_days(p_user_ids, p_from, p_to, p_now)
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
      round(sum(d.leave_s))::bigint as leave_s,
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
  -- Every pass's response time once (the medians by person and by bucket read it).
  pm as materialized (
    select d.user_id, d.day, m.m
    from d cross join lateral unnest(d.pass_ms) as m (m)
  ),
  ms as (
    select pm.user_id, array_agg(pm.m order by pm.m) as pass_ms,
      percentile_cont(0.5) within group (order by pm.m) as median
    from pm
    group by pm.user_id
  ),
  pp as (
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
      coalesce(per.flags, 0), coalesce(per.unreviewed, 0), coalesce(per.tamper, 0),
      coalesce(per.leave_s, 0)
    from public.users u
    left join per on per.user_id = u.id
    left join weeks on weeks.user_id = u.id
    left join ms on ms.user_id = u.id
    where u.id = any (p_user_ids)
      and u.org_id = p_org_id
      and (u.active or coalesce(per.seg_n, 0) > 0 or coalesce(per.shown, 0) > 0)
  ),
  -- The kept people's days.
  kd as (
    select d.* from d where d.user_id in (select pp.id from pp)
  ),
  rv as (
    select kd.user_id, pp.full_name, kd.day, kd.flags, kd.unreviewed, kd.tamper
    from kd
    join pp on pp.id = kd.user_id
    where kd.flags > 0 or kd.tamper > 0
  )
  select
    (select coalesce(array_agg(row(pp.*)::internal.insights_person order by pp.full_name, pp.id), '{}')
     from pp),
    case when p_step is not null then
      (select coalesce(jsonb_agg(jsonb_build_object(
          'bucket', b.bucket,
          'worked_s', coalesce(s.worked_s, 0),
          'flagged_s', coalesce(s.flagged_s, 0),
          'excluded_s', coalesce(s.excluded_s, 0),
          'scheduled_s', coalesce(s.scheduled_s, 0),
          'leave_s', coalesce(s.leave_s, 0),
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
       from (
         select g::date as bucket
         from generate_series(p_from::timestamp, p_to::timestamp, make_interval(days => p_step)) g
       ) b
       left join (
         select p_from + ((kd.day - p_from) / p_step) * p_step as bucket,
           round(sum(kd.worked_s))::bigint as worked_s,
           round(sum(kd.flagged_s))::bigint as flagged_s,
           round(sum(kd.excluded_s))::bigint as excluded_s,
           round(sum(kd.scheduled_s))::bigint as scheduled_s,
           round(sum(kd.leave_s))::bigint as leave_s,
           round(sum(kd.break_s))::bigint as break_s,
           round(sum(kd.pause_s))::bigint as pause_s,
           round(sum(kd.pause_over_cap_s))::bigint as pause_over_cap_s,
           round(sum(kd.billable_s))::bigint as billable_s,
           round(sum(kd.unassigned_s))::bigint as unassigned_s,
           coalesce(sum(round(kd.worked_s) - l.ot_day_s)
             filter (where round(kd.worked_s) > l.ot_day_s), 0)::bigint as overtime_daily_s,
           sum(kd.shift_days)::int as shift_days,
           sum(kd.on_time)::int as on_time,
           sum(kd.late)::int as late,
           sum(kd.no_clock_in)::int as no_clock_in,
           sum(kd.shown)::int as shown,
           sum(kd.passed)::int as passed,
           sum(kd.missed)::int as missed,
           sum(kd.failed)::int as failed,
           sum(kd.deferred)::int as deferred,
           sum(kd.flags)::int as flags,
           sum(kd.unreviewed)::int as unreviewed,
           sum(kd.tamper)::int as tamper
         from kd cross join lim l
         group by 1
       ) s on s.bucket = b.bucket
       left join (
         select p_from + ((pm.day - p_from) / p_step) * p_step as bucket,
           percentile_cont(0.5) within group (order by pm.m) as median
         from pm
         where pm.user_id in (select pp.id from pp)
         group by 1
       ) m on m.bucket = b.bucket)
    end,
    case when p_step is not null then
      (select coalesce(jsonb_agg(jsonb_build_object(
          'user_id', r.user_id, 'full_name', r.full_name, 'day', r.day,
          'anomaly_flags', r.flags, 'needs_review', r.unreviewed, 'tamper', r.tamper
        ) order by r.day desc, r.full_name, r.user_id), '[]'::jsonb)
       from (
         select * from rv
         order by rv.day desc, rv.full_name, rv.user_id
         limit p_max_review
       ) r)
    end,
    case when p_step is not null then (select count(*)::int from rv) end;
$$;

-- The people of p_user_ids for a range, by name (insights_range without the series).
create function internal.insights_people(
  p_org_id uuid,
  p_user_ids uuid[],
  p_from date,
  p_to date,
  p_now timestamptz
)
returns setof internal.insights_person
language sql
stable
security definer
set search_path = ''
as $$
  select p.*
  from internal.insights_range(p_org_id, p_user_ids, p_from, p_to, p_now, null, 0) r
  cross join lateral unnest(r.people) p;
$$;

-- A group's totals from its people (as before, + leave_s).
create or replace function internal.insights_totals(p_people internal.insights_person[])
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
    'leave_s', coalesce(sum(p.leave_s), 0)::bigint,
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


create or replace function public.insights(
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
-- A year's medians sort ~1M response times in memory, not on disk.
set work_mem = '64MB'
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
  v_ids uuid[];
  v_people int;
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

  -- The range (its people, series and days to review, from one read of the person-days)
  -- and the previous range's people.
  select r.people, r.series, r.review, r.review_total
  into v_cur, v_series, v_review, v_review_total
  from internal.insights_range(v_me.org_id, v_ids, p_from, p_to, v_now, v_step, c_max_review_days) r;
  v_prev := array(
    select p from internal.insights_people(v_me.org_id, v_ids, v_prev_from, v_prev_to, v_now) p);
  v_keep := array(select p.user_id from unnest(v_cur) p);

  -- Projects (DSH-10): worked time per project and task, rounded per person, project and
  -- task over the range like report_task_rows, then added up; and per bucket for the chart.
  with seg as (
    select t.user_id, t.project_id, t.task_id,
      p_from + ((t.day - p_from) / v_step) * v_step as bucket,
      sum(t.worked_s) as s
    from internal.insights_project_days(v_keep, p_from, p_to, v_now) t
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


create or replace function internal.weekly_insights_eval(p_now timestamptz default now())
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
      r.week_from, r.week_to, p_now) p);
    v_tot := internal.insights_totals(v_cur);
    v_email_id := null;

    if (v_tot ->> 'worked_s')::bigint > 0 or (v_tot ->> 'checkins_shown')::int > 0
       or (v_tot ->> 'shift_days')::int > 0 or (v_tot ->> 'anomaly_flags')::int > 0
       or (v_tot ->> 'tamper')::int > 0 then
      v_prev := array(select p from internal.insights_people(r.org_id, v_ids,
        r.week_from - 7, r.week_to - 7, p_now) p);
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


revoke all on function internal.insights_daily_last(timestamptz) from public, anon, authenticated;
revoke all on function internal.insights_daily_key(uuid) from public, anon, authenticated;
revoke all on function internal.insights_day_empty(uuid, date) from public, anon, authenticated;
revoke all on function internal.insights_daily_forget(uuid[], date, date) from public, anon, authenticated;
revoke all on function internal.insights_days_live(uuid[], date, date, timestamptz) from public, anon, authenticated;
revoke all on function internal.insights_project_days_live(uuid[], date, date) from public, anon, authenticated;
revoke all on function internal.insights_daily_cover(uuid[], date, date, timestamptz) from public, anon, authenticated;
revoke all on function internal.insights_project_days(uuid[], date, date, timestamptz) from public, anon, authenticated;
revoke all on function internal.insights_daily_fill(int) from public, anon, authenticated;
revoke all on function internal.insights_forget_rows() from public, anon, authenticated;
revoke all on function internal.insights_forget_row() from public, anon, authenticated;
revoke all on function internal.insights_people(uuid, uuid[], date, date, timestamptz) from public, anon, authenticated;
revoke all on function internal.insights_range(uuid, uuid[], date, date, timestamptz, int, int) from public, anon, authenticated;
