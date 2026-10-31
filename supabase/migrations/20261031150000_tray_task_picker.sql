-- #268: the tray's task picker (PRJ-05, #254 follow-up).
--
-- agent_config lists each project's active tasks (id, name, sort order), so the tray can
-- offer a task under the project. A task change sends a project_switch with the same
-- project and the new task_id (optional in the event contract, so older agents still
-- validate; see the contract migration that follows this one).
--
-- segment_inputs carries each switch's task into projectSwitches, and buildSegments()
-- puts it on the segments. A task is kept only when it is a task of the switch's project
-- in the person's org; any other task_id (another org's, another project's, unknown) is
-- ignored and the switch still counts for its project. It is not rejected: the project
-- change is what matters for the timesheet, and losing it to a bad task would be worse.
-- An archived task is kept, like everywhere else (time already logged keeps its task); the
-- tray only offers active ones.
--
-- Saving a task moves the config version of the project's members (#146, #198), so their
-- tray picks up a new, renamed, archived or reordered task.
--
-- Redefined here, each copied from its latest definition with only this change:
--   agent_config    (20261022170000_assistive_input): + each project's tasks
--   segment_inputs  (20261031120254_tasks_and_work_notes): + projectSwitches[].taskId

-- 1. A task change refetches the members' config ------------------------------------------

create function internal.project_tasks_bump_config_version()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE'
    and (old.name, old.archived, old.sort_order, old.project_id)
      is not distinct from (new.name, new.archived, new.sort_order, new.project_id)
  then
    return null;
  end if;
  update public.users u set config_version = u.config_version + 1
  where u.id in (select m.user_id from public.project_members m where m.project_id = new.project_id);
  return null;
end;
$$;

revoke all on function internal.project_tasks_bump_config_version() from public, anon, authenticated;

create trigger project_tasks_config_version
after insert or update on public.project_tasks
for each row
execute function internal.project_tasks_bump_config_version();

-- 2. The agent's config (copied from 20261022170000_assistive_input; adds tasks) ----------

create or replace function public.agent_config(p_device_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_device public.devices := internal.require_active_device(p_device_id);
begin
  return (
    select jsonb_build_object(
      -- The org's policy, then their team's overrides (ADM-02); the collection keys are
      -- what this person may run with (AGT-05).
      'policy', o.policy || internal.team_policy(u.id) || internal.effective_collection(u.id),
      'policy_version', o.policy_version,
      -- What the heartbeat's config_version is compared with.
      'config_version', o.policy_version + u.config_version,
      'timezone', u.timezone,
      -- #168: injected clicks on the card are accepted (and still flagged), not blocked.
      'assistive_input', u.assistive_input,
      'shifts', coalesce((
        select jsonb_agg(jsonb_build_object('days', s.days, 'start', to_char(s.start_time, 'HH24:MI'),
          'end', to_char(s.end_time, 'HH24:MI'), 'timezone', s.timezone) order by s.start_time, s.days)
        from public.shifts s where s.user_id = u.id
      ), '[]'::jsonb),
      -- PRJ-02: what the person can pick in the tray and on the card; #268 (PRJ-05): with
      -- each project's active tasks in their order, for the tray's task picker.
      'projects', coalesce((
        select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name, 'client', c.name,
          'tasks', coalesce((
            select jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name, 'sort_order', t.sort_order)
              order by t.sort_order, lower(t.name), t.id)
            from public.project_tasks t
            where t.project_id = p.id and not t.archived
          ), '[]'::jsonb))
          order by c.name nulls first, p.name)
        from public.project_members m
        join public.projects p on p.id = m.project_id and not p.archived
        left join public.clients c on c.id = p.client_id
        where m.user_id = u.id
      ), '[]'::jsonb),
      -- AGT-04/05: the current version, whether this person acknowledged it, and
      -- the latest version they did acknowledge (null: never, so nothing runs).
      'notice', (
        select jsonb_build_object(
          'id', n.id, 'version', n.version, 'body', n.body,
          'acknowledged', exists (
            select 1 from public.notice_acks a where a.user_id = u.id and a.notice_id = n.id),
          'acknowledged_version', (
            select max(n2.version) from public.notice_acks a2
            join public.notices n2 on n2.id = a2.notice_id where a2.user_id = u.id)
        )
        from public.notices n where n.org_id = u.org_id
        order by n.version desc limit 1
      )
    )
    from public.users u
    join public.orgs o on o.id = u.org_id
    where u.id = v_device.user_id
  );
end;
$$;

-- 3. Rebuild inputs: each switch's task (copied from 20261031120254_tasks_and_work_notes) --

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
          'projectId', me.project_id,
          'taskId', me.task_id) order by me.start_at)
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
      -- #268: each switch's task, only when it is a task of that project in this
      -- person's org (anything else is ignored: the switch counts for its project alone).
      'projectSwitches', coalesce((
        select jsonb_agg(jsonb_build_object(
          'at', floor(extract(epoch from r.at))::bigint,
          'projectId', nullif(r.payload ->> 'project_id', ''),
          'taskId', (
            select t.id from public.project_tasks t
            where t.id::text = r.payload ->> 'task_id'
              and t.project_id::text = r.payload ->> 'project_id'
              and t.org_id = v_user.org_id
          )) order by r.at, r.seq)
        from public.agent_events_raw r
        where r.user_id = p_user_id and r.type = 'project_switch' and r.at >= v_from and r.at < v_end
      ), '[]'::jsonb),
      -- Project edits, the manager's (TS-13) and the employee's (PRJ-04), oldest first
      -- so the latest over a span wins. Applied last.
      'projectEdits', coalesce((
        select jsonb_agg(jsonb_build_object(
          'start', floor(extract(epoch from e.start_at))::bigint,
          'end', floor(extract(epoch from e.end_at))::bigint,
          'projectId', e.project_id,
          'taskId', e.task_id) order by e.seq)
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
