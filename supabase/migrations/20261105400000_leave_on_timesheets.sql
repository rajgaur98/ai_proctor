-- #319: time off, part 2 (LV-05, LV-06). Leave on the timesheet, in the timesheet export
-- and in Reports, and the time-off list's filters.
--
-- Leave seconds (LV-05) ---------------------------------------------------------------------
-- internal.leave_days(people, from, to): for each person and local day (their users.timezone,
-- like time_segments.day) that has leave, how many seconds of leave it counts and what the
-- leave is. Counted, from raw seconds (TS-05/06):
--   * approved paid whole-day leave and holidays that apply to the person (LV-02, LV-04; a
--     holiday is their whole local day) count the hours of their shifts (SHF-01) that start
--     on that day and fall inside the leave: the shift's hours for a whole day off. No
--     shift that day: nothing to count (0);
--   * approved paid part-day leave counts its own span, on the day it starts;
--   * where these overlap (a part day on a holiday) the time counts once;
--   * unpaid leave counts 0 but is still listed, so the timesheet shows it with 0 hours.
-- Leave is never worked time: it is not in the worked, billable or overtime numbers (TS-19);
-- every consumer shows it apart.
--
-- Reading it:
--   * timesheet_leave(from, to, person?): per person and day, for the people the caller may
--     view (can_view_user). The week page reads one person's week (the Leave row, LV-05);
--     the Timesheets list reads everyone's week (their leave next to their worked time).
--   * timesheet_export_rows: a `leave` list next to `rows` (person, day, seconds, what,
--     the week's status and approver) for the people the export covers; the export adds a
--     Leave column (LV-06, TS-20..22). A client or project filter leaves leave out: it is
--     on no project. A status filter applies to the leave day's week as to segments.
--   * report_rows: a leave_s per person (DSH-07, LV-06).
--
-- Time-off list (LV-06) ----------------------------------------------------------------------
-- leave_requests_list gets a team filter (p_team_id) next to its person, status and date
-- filters, so the page filters by person, team, status and dates instead of a fixed
-- look-back. Its export follows the filters (TS-28) and is audit-logged like every export.
--
-- Redefined here, each copied from its latest definition with only this change:
--   leave_requests_list   (20261105110000_time_off): + p_team_id (a new signature, so the
--                         old one is dropped)
--   timesheet_export_rows (20261031120254_tasks_and_work_notes): + leave
--   report_rows           (20261022160000_report_late_clock_ins): + leave_s

-- Leave seconds --------------------------------------------------------------------------------

create function internal.leave_days(p_user_ids uuid[], p_from date, p_to date)
returns table (user_id uuid, day date, seconds bigint, items jsonb)
language sql
stable
security definer
set search_path = ''
as $$
  with people as (
    select u.id, u.org_id, u.timezone, u.work_country, u.work_state
    from public.users u
    where u.id = any (p_user_ids)
  ),
  -- Approved requests and applicable holidays around the range: a day of margin on each
  -- side for time zones and for a night shift that runs into the next day.
  src as (
    select p.id as user_id, r.kind, r.paid, t.name, false as holiday, r.start_at, r.end_at
    from people p
    join public.leave_requests r on r.user_id = p.id and r.status = 'approved'
    join public.leave_types t on t.id = r.leave_type_id
    where r.end_at > (p_from - 1)::timestamp at time zone p.timezone
      and r.start_at < (p_to + 2)::timestamp at time zone p.timezone
    union all
    select p.id, 'days', true, h.name, true,
      h.day::timestamp at time zone p.timezone, (h.day + 1)::timestamp at time zone p.timezone
    from people p
    join public.holidays h on h.org_id = p.org_id
    where h.day between p_from - 1 and p_to + 1
      and internal.holiday_applies(h.country, h.state, p.work_country, p.work_state)
  ),
  -- The local days in the range each one touches, and the day before it (a shift that
  -- starts that evening can run into it).
  days as (
    select distinct s.user_id, d.day
    from src s
    join people p on p.id = s.user_id
    cross join lateral (
      select g::date as day
      from generate_series(
        (s.start_at at time zone p.timezone)::date - 1,
        ((s.end_at - interval '1 microsecond') at time zone p.timezone)::date,
        interval '1 day') g
    ) d
    where d.day between p_from and p_to
  ),
  per_day as (
    select dd.user_id, dd.day,
      -- Shift hours inside paid whole-day leave or a holiday ...
      (sh.mr * coalesce((select range_agg(tstzrange(s.start_at, s.end_at))
                         from src s
                         where s.user_id = dd.user_id and s.paid and s.kind = 'days'),
                        '{}'::tstzmultirange))
      -- ... and paid part days that start that day, each instant once.
      + coalesce((select range_agg(tstzrange(s.start_at, s.end_at))
                  from src s
                  where s.user_id = dd.user_id and s.paid and s.kind = 'part_day'
                    and (s.start_at at time zone p.timezone)::date = dd.day),
                 '{}'::tstzmultirange) as leave,
      -- What the day's leave is: what touches the day, or the day's shifts. Holidays
      -- first, then requests in time order.
      (select jsonb_agg(jsonb_build_object('name', s.name, 'paid', s.paid, 'holiday', s.holiday,
                'part_day', s.kind = 'part_day')
              order by s.holiday desc, s.start_at, s.name)
       from src s
       where s.user_id = dd.user_id
         and ((s.start_at < (dd.day + 1)::timestamp at time zone p.timezone
               and s.end_at > dd.day::timestamp at time zone p.timezone)
              or (s.kind = 'days' and sh.mr && tstzrange(s.start_at, s.end_at)))) as items
    from days dd
    join people p on p.id = dd.user_id
    -- The person's shifts that start that day (each in its own zone, SHF-01).
    cross join lateral (
      select coalesce(range_agg(tstzrange(o.starts_at, o.ends_at)), '{}'::tstzmultirange) as mr
      from public.shifts sf
      cross join lateral (
        select (dd.day + sf.start_time) at time zone sf.timezone as starts_at,
          ((dd.day + case when sf.end_time <= sf.start_time then 1 else 0 end) + sf.end_time)
            at time zone sf.timezone as ends_at
      ) o
      where sf.user_id = dd.user_id
        and extract(isodow from dd.day)::int = any (sf.days)
    ) sh
  )
  select pd.user_id, pd.day, x.seconds, coalesce(pd.items, '[]'::jsonb)
  from per_day pd
  cross join lateral (
    select coalesce(round(sum(extract(epoch from upper(r) - lower(r)))), 0)::bigint as seconds
    from unnest(pd.leave) r
  ) x
  where pd.items is not null or x.seconds > 0;
$$;

revoke all on function internal.leave_days(uuid[], date, date) from public, anon, authenticated;

-- LV-05: leave per person and local day from p_from to p_to (at most a year), for one person
-- (p_user_id) or everyone the caller may view. `items` names what the day's leave is:
-- [{ name, paid, holiday, part_day }]. A person the caller can't view has no rows.
create function public.timesheet_leave(p_from date, p_to date, p_user_id uuid default null)
returns table (user_id uuid, day date, seconds bigint, items jsonb)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_me public.users := internal.current_app_user();
begin
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 366 then
    raise exception 'invalid_range' using errcode = '22023';
  end if;
  return query
    select l.user_id, l.day, l.seconds, l.items
    from internal.leave_days(
      array(select u.id from public.users u
            where u.org_id = v_me.org_id
              and (p_user_id is null or u.id = p_user_id)
              and public.can_view_user(u.id)),
      p_from, p_to) l
    order by l.user_id, l.day;
end;
$$;

revoke all on function public.timesheet_leave(date, date, uuid) from public, anon;
grant execute on function public.timesheet_leave(date, date, uuid) to authenticated;

-- Time-off list: + team (copied from 20261105110000_time_off) ---------------------------------

drop function public.leave_requests_list(date, date, uuid, text);

-- The requests the caller may view (can_view_user: their own, their reports', an active
-- delegate's, everyone's for owners and admins), with the names an employee can't read
-- themselves and what the caller may do with each: decide (pending, and they are the
-- direct manager or active delegate) or cancel (their own, pending or not yet started).
-- Optional filters: days overlapping p_from..p_to, one person, one status, one team (its
-- current members). Newest first, at most 2000.
create function public.leave_requests_list(
  p_from date default null,
  p_to date default null,
  p_user_id uuid default null,
  p_status text default null,
  p_team_id uuid default null
)
returns table (
  id uuid,
  user_id uuid,
  employee_name text,
  leave_type_id uuid,
  type_name text,
  paid boolean,
  kind text,
  first_day date,
  last_day date,
  start_at timestamptz,
  end_at timestamptz,
  timezone text,
  note text,
  status text,
  decided_by_name text,
  decided_at timestamptz,
  decision_note text,
  cancelled_at timestamptz,
  created_at timestamptz,
  can_decide boolean,
  can_cancel boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_me public.users := internal.current_app_user();
begin
  return query
    select r.id, r.user_id, u.full_name, r.leave_type_id, t.name, r.paid, r.kind,
           r.first_day, r.last_day, r.start_at, r.end_at, r.timezone, r.note, r.status,
           r.decided_by_name, r.decided_at, r.decision_note, r.cancelled_at, r.created_at,
           r.status = 'pending' and internal.is_entry_decider(v_me, r.user_id),
           r.user_id = v_me.id
             and (r.status = 'pending' or (r.status = 'approved' and r.start_at > now()))
    from public.leave_requests r
    join public.users u on u.id = r.user_id
    join public.leave_types t on t.id = r.leave_type_id
    where r.org_id = v_me.org_id
      and public.can_view_user(r.user_id)
      and (p_from is null or r.last_day >= p_from)
      and (p_to is null or r.first_day <= p_to)
      and (p_user_id is null or r.user_id = p_user_id)
      and (p_status is null or r.status = p_status)
      and (p_team_id is null or u.team_id = p_team_id)
    order by r.first_day desc, r.start_at desc, r.id
    limit 2000;
end;
$$;

revoke all on function public.leave_requests_list(date, date, uuid, text, uuid) from public, anon;
grant execute on function public.leave_requests_list(date, date, uuid, text, uuid) to authenticated;

-- Export: + leave (copy of 20261031120254_tasks_and_work_notes) --------------------------------

-- As before, and the reply has `leave`: per person-day of the people the export covers (its
-- person, manager and team filters, can_view_user), from internal.leave_days, with the
-- week's status and approver; none when a client or project filter is set (leave is on no
-- project); a status filter keeps the days whose week has that status. Same arguments, so
-- replaced in place.
create or replace function public.timesheet_export_rows(
  p_from date,
  p_to date,
  p_view text,
  p_user_ids uuid[] default null,
  p_manager_id uuid default null,
  p_client_ids uuid[] default null,
  p_project_ids uuid[] default null,
  p_statuses text[] default null,
  p_team_id uuid default null,
  p_format text default 'csv'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me public.users := internal.current_app_user();
  v_rows jsonb;
  v_count int;
  v_target uuid;
  v_policy jsonb;
  v_notes jsonb;
  v_leave jsonb := '[]'::jsonb;
begin
  if p_view is null or p_view not in ('daily', 'project', 'segments') then
    raise exception 'invalid_view' using errcode = '22023';
  end if;
  if p_format is null or p_format not in ('csv', 'xlsx') then
    raise exception 'invalid_format' using errcode = '22023';
  end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 365 then
    raise exception 'invalid_range' using errcode = '22023';
  end if;
  if p_statuses is not null
     and exists (select 1 from unnest(p_statuses) s
                 where s is null or s not in ('draft', 'submitted', 'approved', 'returned')) then
    raise exception 'invalid_status' using errcode = '22023';
  end if;
  if coalesce(cardinality(p_user_ids), 0) > 0
     and exists (select 1 from unnest(p_user_ids) u where u is null or not public.can_view_user(u)) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(r.seg order by r.full_name, r.user_id, r.day, r.start_at), '[]'::jsonb),
         count(*)::int
  into v_rows, v_count
  from (
    select u.full_name, t.user_id, t.day, t.start_at,
      jsonb_build_object(
        'user_id', t.user_id,
        'employee', u.full_name,
        'email', u.email,
        'timezone', u.timezone,
        'day', t.day,
        'start_local', to_char(t.start_at at time zone u.timezone, 'YYYY-MM-DD HH24:MI:SS'),
        'end_local', to_char(t.end_at at time zone u.timezone, 'YYYY-MM-DD HH24:MI:SS'),
        'type', t.type,
        'project_id', t.project_id,
        'project', p.name,
        'task_id', tk.id,
        'task', tk.name,
        'client_id', p.client_id,
        'client', c.name,
        -- The task's flag when there is one, else the project's.
        'billable', coalesce(tk.billable, p.billable, false),
        'counted', t.counted,
        'flagged', t.flagged,
        'excluded', t.excluded,
        'seconds', round(extract(epoch from t.end_at - t.start_at))::bigint,
        'status', coalesce(ts.status, 'draft'),
        'approver', a.full_name,
        -- TS-24: a manual segment's entry note (entries never overlap, so one covers it).
        'note', case when t.type = 'manual' then (
          select me.note from public.manual_entries me
          where me.user_id = t.user_id and me.status = 'approved'
            and me.start_at <= t.start_at and me.end_at >= t.end_at
          order by me.start_at
          limit 1
        ) end
      ) as seg
    from public.time_segments t
    join public.users u on u.id = t.user_id
    left join public.projects p on p.id = t.project_id
    left join public.project_tasks tk on tk.id = t.task_id and tk.project_id = t.project_id
    left join public.clients c on c.id = p.client_id
    left join lateral (
      select s.status, s.approver_id
      from public.timesheets s
      where s.user_id = t.user_id and t.day >= s.period_start and t.day < s.period_start + 7
      order by s.period_start desc
      limit 1
    ) ts on true
    left join public.users a on a.id = ts.approver_id
    where t.org_id = v_me.org_id
      and t.day between p_from and p_to
      and public.can_view_user(t.user_id)
      and (coalesce(cardinality(p_user_ids), 0) = 0 or t.user_id = any (p_user_ids))
      and (p_manager_id is null or u.manager_id = p_manager_id)
      and (p_team_id is null or u.team_id = p_team_id)
      and (coalesce(cardinality(p_project_ids), 0) = 0 or t.project_id = any (p_project_ids))
      and (coalesce(cardinality(p_client_ids), 0) = 0 or p.client_id = any (p_client_ids))
      and (coalesce(cardinality(p_statuses), 0) = 0 or coalesce(ts.status, 'draft') = any (p_statuses))
  ) r;

  -- LV-06: the leave of the people the export covers; leave is on no project.
  if coalesce(cardinality(p_project_ids), 0) = 0 and coalesce(cardinality(p_client_ids), 0) = 0 then
    select coalesce(jsonb_agg(jsonb_build_object(
             'user_id', l.user_id,
             'employee', u.full_name,
             'email', u.email,
             'timezone', u.timezone,
             'day', l.day,
             'seconds', l.seconds,
             'items', l.items,
             'status', coalesce(ts.status, 'draft'),
             'approver', a.full_name)
           order by u.full_name, l.user_id, l.day), '[]'::jsonb)
    into v_leave
    from internal.leave_days(
      array(select u2.id from public.users u2
            where u2.org_id = v_me.org_id
              and public.can_view_user(u2.id)
              and (coalesce(cardinality(p_user_ids), 0) = 0 or u2.id = any (p_user_ids))
              and (p_manager_id is null or u2.manager_id = p_manager_id)
              and (p_team_id is null or u2.team_id = p_team_id)),
      p_from, p_to) l
    join public.users u on u.id = l.user_id
    left join lateral (
      select s.status, s.approver_id
      from public.timesheets s
      where s.user_id = l.user_id and l.day >= s.period_start and l.day < s.period_start + 7
      order by s.period_start desc
      limit 1
    ) ts on true
    left join public.users a on a.id = ts.approver_id
    where coalesce(cardinality(p_statuses), 0) = 0 or coalesce(ts.status, 'draft') = any (p_statuses);
  end if;

  -- One named employee is the target; anything wider has none.
  if cardinality(p_user_ids) = 1 then
    v_target := p_user_ids[1];
  end if;
  perform internal.audit(v_me.org_id, v_me.id, 'timesheet.exported', v_target,
    jsonb_build_object(
      'view', p_view,
      'format', p_format,
      'from', p_from,
      'to', p_to,
      'user_ids', coalesce(to_jsonb(p_user_ids), '[]'::jsonb),
      'manager_id', p_manager_id,
      'team_id', p_team_id,
      'client_ids', coalesce(to_jsonb(p_client_ids), '[]'::jsonb),
      'project_ids', coalesce(to_jsonb(p_project_ids), '[]'::jsonb),
      'statuses', coalesce(to_jsonb(p_statuses), '[]'::jsonb),
      'row_count', v_count,
      'leave_days', jsonb_array_length(v_leave)
    ));

  -- TS-25: the day notes of the person-days in the export, for the per-day Work done.
  select coalesce(jsonb_agg(jsonb_build_object('user_id', n.user_id, 'day', n.day, 'note', n.note)
           order by n.user_id, n.day), '[]'::jsonb)
  into v_notes
  from public.timesheet_day_notes n
  where n.org_id = v_me.org_id
    and n.day between p_from and p_to
    and public.can_view_user(n.user_id)
    and exists (
      select 1 from jsonb_array_elements(v_rows) r
      where (r ->> 'user_id')::uuid = n.user_id and (r ->> 'day')::date = n.day
    );

  -- TS-19: what the XLSX highlights, from the org's policy (null is off).
  select internal.policy_defaults() || o.policy into v_policy
  from public.orgs o where o.id = v_me.org_id;

  return jsonb_build_object(
    'row_count', v_count,
    'rows', v_rows,
    'day_notes', v_notes,
    'leave', v_leave,
    'overtime', jsonb_build_object(
      'daily_hours', v_policy -> 'overtime_daily_hours',
      'weekly_hours', v_policy -> 'overtime_weekly_hours'
    ),
    'week_start', v_policy ->> 'week_start'
  );
end;
$$;

-- Reports: + leave_s (copy of 20261022160000_report_late_clock_ins) -----------------------------

-- As before, and each row has leave_s: the person's leave in the span (internal.leave_days,
-- the timesheet's Leave row), apart from worked time. Same signature, so a replace.
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
  -- LV-06: everyone's leave in the span at once.
  lv as (
    select l.user_id, sum(l.seconds)::bigint as leave_s
    from internal.leave_days(array(select p.id from p), p_from, p_to) l
    group by l.user_id
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
        'leave_s', coalesce(lv.leave_s, 0),
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
    left join lv on lv.user_id = p.id
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
