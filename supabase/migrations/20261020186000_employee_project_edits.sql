-- #139: employees re-assign project time on a draft week (PRJ-04, PRJ-03).
--
-- An employee moves time of their own to another project (or to Unassigned) while the
-- week is a draft or returned, with reassign_my_time(). It is stored in timesheet_edits
-- as kind 'employee_project', authored by the employee, and fed to buildSegments() as
-- DayInput.projectEdits exactly like a manager's 'project' edit (TS-13). Both kinds go
-- through the same list, oldest first, so the LATEST edit over a span wins: a manager
-- who changes a span after the employee overrides them, and an employee who changes it
-- again once the week is returned overrides the manager's edit. Both stay in the edit
-- list, so the review page shows who did what.
--
-- Only the project moves. The span's type, counted and flagged state, and any exclusion
-- are untouched: flagged time can be re-assigned but is never un-flagged by it (TS-02).
-- Unlike a manager's edit, the employee gives no reason (optional), and nobody is
-- notified. Every re-assignment is audit-logged as 'timesheet.project_reassigned'.

-- timesheet_edits: the new kind, and no reason required for it -------------------------

alter table public.timesheet_edits
  drop constraint timesheet_edits_kind_check,
  add constraint timesheet_edits_kind_check
    check (kind in ('keep', 'exclude', 'include', 'project', 'adjust', 'employee_project')),
  drop constraint timesheet_edits_reason,
  add constraint timesheet_edits_reason
    check (kind in ('keep', 'employee_project') or reason is not null);

-- The employee's re-assignment ---------------------------------------------------------

-- PRJ-04: moves the caller's own time in [p_start, p_end) to p_project_id (null:
-- Unassigned). Rules:
--   - the week is the caller's draft or returned one (submitted and approved weeks are
--     locked: a manager is reviewing or has approved them);
--   - the span lies in one week, in the past, and covers counted time that isn't
--     excluded (project time only exists on counted time);
--   - the project is one the caller is assigned to and isn't archived, or Unassigned;
--   - the reason is optional (up to 500 characters).
-- The affected days are marked dirty, so the next rebuild applies it (the dashboard
-- rebuilds the week when it opens and after saving). Returns the edit id.
create function public.reassign_my_time(
  p_start timestamptz,
  p_end timestamptz,
  p_project_id uuid,
  p_reason text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me public.users := internal.current_app_user();
  v_ts public.timesheets;
  v_reason text := nullif(trim(coalesce(p_reason, '')), '');
  v_ts_id uuid;
  v_day date;
  v_before jsonb;
  v_id uuid;
begin
  if p_start is null or p_end is null or p_end <= p_start then
    raise exception 'invalid_range' using errcode = '22023';
  end if;
  if p_end > now() then
    raise exception 'in_the_future' using errcode = '22023';
  end if;
  if length(v_reason) > 500 then
    raise exception 'invalid_reason' using errcode = '22023';
  end if;

  -- The caller's week holding the span's first day; created as a draft if it is new.
  v_day := (p_start at time zone v_me.timezone)::date;
  select t.id into v_ts_id from public.timesheets t
  where t.user_id = v_me.id and v_day >= t.period_start and v_day < t.period_start + 7;
  if not found then
    v_ts_id := public.ensure_timesheet(v_me.id, internal.week_start(v_me.org_id, v_day));
  end if;
  v_ts := internal.load_timesheet(v_ts_id, v_me);

  if v_ts.status = 'approved' then
    raise exception 'timesheet_locked' using errcode = '55000';
  end if;
  if v_ts.status = 'submitted' then
    raise exception 'timesheet_submitted' using errcode = '55000';
  end if;
  if p_start < internal.local_day_start(v_me.id, v_ts.period_start)
    or p_end > internal.local_day_start(v_me.id, v_ts.period_start + 7)
  then
    raise exception 'outside_week' using errcode = '22023';
  end if;

  if p_project_id is not null and internal.allowed_project(v_me.id, p_project_id::text) is null then
    raise exception 'project_not_allowed' using errcode = '22023';
  end if;

  if not exists (
    select 1 from public.time_segments t
    where t.user_id = v_me.id and t.counted and not t.excluded
      and t.start_at < p_end and t.end_at > p_start
  ) then
    raise exception 'no_counted_time' using errcode = '22023';
  end if;

  -- The projects the span had, for the audit log (null is Unassigned).
  select coalesce(jsonb_agg(distinct t.project_id), '[]'::jsonb) into v_before
  from public.time_segments t
  where t.user_id = v_me.id and t.counted and not t.excluded
    and t.start_at < p_end and t.end_at > p_start;

  insert into public.timesheet_edits (org_id, timesheet_id, user_id, editor_id, kind, start_at,
    end_at, project_id, reason, detail)
  values (v_ts.org_id, v_ts.id, v_me.id, v_me.id, 'employee_project', p_start, p_end,
    p_project_id, v_reason, jsonb_build_object('before_projects', v_before))
  returning id into v_id;

  perform internal.mark_dirty(v_me.id, p_start, p_end);

  perform internal.audit(v_ts.org_id, v_me.id, 'timesheet.project_reassigned', v_me.id,
    jsonb_build_object('timesheet_id', v_ts.id, 'edit_id', v_id, 'start_at', p_start,
      'end_at', p_end, 'project_id', p_project_id, 'before_projects', v_before,
      'reason', v_reason));
  return v_id;
end;
$$;

revoke all on function public.reassign_my_time(timestamptz, timestamptz, uuid, text) from public, anon;
grant execute on function public.reassign_my_time(timestamptz, timestamptz, uuid, text) to authenticated;

-- Rebuild input: both kinds of project edit (replaces #43's version) ------------------

create or replace function public.segment_inputs(p_user_id uuid, p_day date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user public.users;
  v_now timestamptz := clock_timestamp();
  v_start timestamptz;
  v_end timestamptz;
  v_from timestamptz;
  v_policy jsonb;
begin
  select * into v_user from public.users u where u.id = p_user_id;
  if not found then
    raise exception 'user_not_found' using errcode = '22023';
  end if;
  v_start := p_day::timestamp at time zone v_user.timezone;
  v_end := (p_day + 1)::timestamp at time zone v_user.timezone;
  select least(v_start, min(cs.start_at)) into v_from
  from public.clock_sessions cs
  where cs.user_id = p_user_id and cs.start_at < v_end and coalesce(cs.end_at, v_now) > v_start;
  v_from := coalesce(v_from, v_start);
  select o.policy into v_policy from public.orgs o where o.id = v_user.org_id;

  return jsonb_build_object(
    'loaded_at', v_now,
    'input', jsonb_build_object(
      'day', jsonb_build_object(
        'start', floor(extract(epoch from v_start))::bigint,
        'end', floor(extract(epoch from v_end))::bigint
      ),
      'now', floor(extract(epoch from v_now))::bigint,
      'clockSessions', coalesce((
        select jsonb_agg(jsonb_build_object(
          'start', floor(extract(epoch from cs.start_at))::bigint,
          'end', floor(extract(epoch from cs.end_at))::bigint,
          'projectId', cs.project_id) order by cs.start_at)
        from public.clock_sessions cs
        where cs.user_id = p_user_id and cs.start_at < v_end and coalesce(cs.end_at, v_now) > v_start
      ), '[]'::jsonb),
      -- Approved entries only: pending and rejected ones aren't counted (TS-08).
      'manualEntries', coalesce((
        select jsonb_agg(jsonb_build_object(
          'start', floor(extract(epoch from me.start_at))::bigint,
          'end', floor(extract(epoch from me.end_at))::bigint,
          'projectId', me.project_id) order by me.start_at)
        from public.manual_entries me
        where me.user_id = p_user_id and me.status = 'approved'
          and me.start_at < v_end and me.end_at > v_start
      ), '[]'::jsonb),
      'breaks', coalesce((
        select jsonb_agg(jsonb_build_object(
          'start', floor(extract(epoch from b.start_at))::bigint,
          'end', floor(extract(epoch from b.end_at))::bigint) order by b.start_at)
        from public.breaks b
        where b.user_id = p_user_id and b.start_at < v_end and coalesce(b.end_at, v_now) > v_start
      ), '[]'::jsonb),
      'pauses', coalesce((
        select jsonb_agg(jsonb_build_object(
          'start', floor(extract(epoch from p.start_at))::bigint,
          'end', floor(extract(epoch from p.end_at))::bigint) order by p.start_at)
        from public.pauses p
        where p.user_id = p_user_id and p.start_at < v_end and coalesce(p.end_at, v_now) > v_start
      ), '[]'::jsonb),
      'statusPeriods', coalesce((
        select jsonb_agg(jsonb_build_object(
          'status', sp.status,
          'start', floor(extract(epoch from sp.start_at))::bigint,
          'end', floor(extract(epoch from sp.end_at))::bigint) order by sp.start_at)
        from public.status_periods sp
        where sp.user_id = p_user_id and sp.start_at < v_end and coalesce(sp.end_at, v_now) > v_start
      ), '[]'::jsonb),
      'checkins', coalesce((
        select jsonb_agg(jsonb_build_object(
          'at', floor(extract(epoch from coalesce(c.shown_at, c.scheduled_at)))::bigint,
          'outcome', c.outcome) order by coalesce(c.shown_at, c.scheduled_at))
        from public.checkin_events c
        where c.user_id = p_user_id
          and coalesce(c.shown_at, c.scheduled_at) >= v_from
          and coalesce(c.shown_at, c.scheduled_at) < v_end
          -- Only outcomes that verify or fail the person; a deferred card (#102)
          -- must never open an unverified window.
          and c.outcome::text in ('pass', 'miss', 'failed')
      ), '[]'::jsonb),
      'projectSwitches', coalesce((
        select jsonb_agg(jsonb_build_object(
          'at', floor(extract(epoch from r.at))::bigint,
          'projectId', nullif(r.payload ->> 'project_id', '')) order by r.at, r.seq)
        from public.agent_events_raw r
        where r.user_id = p_user_id and r.type = 'project_switch' and r.at >= v_from and r.at < v_end
      ), '[]'::jsonb),
      -- Project edits, the manager's (TS-13) and the employee's (PRJ-04), oldest first
      -- so the latest over a span wins. Applied last.
      'projectEdits', coalesce((
        select jsonb_agg(jsonb_build_object(
          'start', floor(extract(epoch from e.start_at))::bigint,
          'end', floor(extract(epoch from e.end_at))::bigint,
          'projectId', e.project_id) order by e.seq)
        from public.timesheet_edits e
        where e.user_id = p_user_id and e.kind in ('project', 'employee_project')
          and e.start_at < v_end and e.end_at > v_start
      ), '[]'::jsonb),
      'policy', jsonb_build_object(
        'breaksPaid', coalesce((v_policy ->> 'breaks_paid')::boolean, false),
        -- BRK-06 defaults: 15 minutes per pause, 60 per day.
        'pauseMaxS', coalesce((v_policy ->> 'pause_max_min')::int, 15) * 60,
        'pauseDailyMaxS', coalesce((v_policy ->> 'pause_daily_max_min')::int, 60) * 60
      )
    )
  );
end;
$$;
