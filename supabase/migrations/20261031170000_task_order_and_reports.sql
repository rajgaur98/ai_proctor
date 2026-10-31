-- #269 (follow-up of #254): task order and reports by task.
--
-- Task order (PRJ-05). project_tasks.sort_order (#254) puts a project's tasks in order:
-- the task pickers and the Tasks dialog list them that way, and a new task goes last.
-- reorder_tasks lets an owner or admin change it. It takes every task of the project in
-- the new order and refuses any other list (a task missing, repeated or from another
-- project, as when someone added one since the list was read), so a stale list never
-- drops a task's place. A change of order is audit-logged.
--
-- Reports by task (DSH-10). report_task_rows gives worked and flagged seconds per person,
-- project and task for the same people and days as report_rows, so the Reports tab can
-- group by project and task ("No task" for project time without one, Unassigned for
-- time without a project) and count the people on each. Seconds are summed from the
-- segments and rounded to the second per row, like timesheet_breakdown; the dashboard
-- adds rows up and rounds only for display.
--
-- Nothing is redefined here: report_rows (latest: 20261022160000_report_late_clock_ins)
-- is unchanged, and report_task_rows copies its choice of people.

-- Task order ---------------------------------------------------------------------------------

create function public.reorder_tasks(p_project_id uuid, p_task_ids uuid[])
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me public.users := internal.current_app_user();
  v_before uuid[];
  v_count int;
begin
  if v_me.role not in ('owner', 'admin') then
    raise exception 'admin_only' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.projects p where p.id = p_project_id and p.org_id = v_me.org_id
  ) then
    raise exception 'project_not_found' using errcode = '42501';
  end if;

  -- Two reorders of one project run one after the other.
  perform 1 from public.projects p where p.id = p_project_id for update;
  select array_agg(t.id order by t.sort_order, t.name), count(*)::int
  into v_before, v_count
  from public.project_tasks t
  where t.project_id = p_project_id;

  if coalesce(cardinality(p_task_ids), 0) <> v_count
     or (select count(distinct x) from unnest(p_task_ids) x) <> v_count
     or exists (
       select 1 from unnest(p_task_ids) x
       where x is null or not exists (
         select 1 from public.project_tasks t where t.id = x and t.project_id = p_project_id
       )
     )
  then
    raise exception 'task_list_changed' using errcode = '22023';
  end if;
  if v_count = 0 or v_before = p_task_ids then
    return;
  end if;

  update public.project_tasks t
  set sort_order = o.ord - 1
  from unnest(p_task_ids) with ordinality as o (id, ord)
  where t.id = o.id and t.sort_order <> o.ord - 1;

  perform internal.audit(v_me.org_id, v_me.id, 'project.tasks_reordered', null,
    jsonb_build_object('project_id', p_project_id, 'before', to_jsonb(v_before),
      'after', to_jsonb(p_task_ids)));
end;
$$;

revoke all on function public.reorder_tasks(uuid, uuid[]) from public, anon;
grant execute on function public.reorder_tasks(uuid, uuid[]) to authenticated;

-- Reports by task ----------------------------------------------------------------------------

-- Worked and flagged seconds per person, project and task over p_from..p_to (each
-- person's local days). The people are report_rows': those the caller can see, never the
-- caller unless named, narrowed by p_user_ids, p_manager_id and p_team_id. Worked is
-- counted time a manager hasn't excluded, flagged is flagged time not excluded, as in
-- report_rows; a row has some of one or the other. A null project is Unassigned; a null
-- task on a project is "No task".
create function public.report_task_rows(
  p_from date,
  p_to date,
  p_user_ids uuid[] default null,
  p_manager_id uuid default null,
  p_team_id uuid default null
)
returns table (
  user_id uuid,
  project_id uuid,
  task_id uuid,
  worked_s bigint,
  flagged_s bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_me public.users := internal.current_app_user();
begin
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 365 then
    raise exception 'invalid_range' using errcode = '22023';
  end if;
  if coalesce(cardinality(p_user_ids), 0) > 0
     and exists (select 1 from unnest(p_user_ids) u where u is null or not public.can_view_user(u)) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  return query
  select t.user_id, t.project_id, t.task_id,
    coalesce(round(sum(extract(epoch from t.end_at - t.start_at))
      filter (where t.counted)), 0)::bigint,
    coalesce(round(sum(extract(epoch from t.end_at - t.start_at))
      filter (where t.flagged)), 0)::bigint
  from public.users u
  join public.time_segments t on t.user_id = u.id and t.day between p_from and p_to
  where u.org_id = v_me.org_id
    and public.can_view_user(u.id)
    and (coalesce(cardinality(p_user_ids), 0) = 0 or u.id = any (p_user_ids))
    and (u.id <> v_me.id or u.id = any (coalesce(p_user_ids, '{}'::uuid[])))
    and (p_manager_id is null or u.manager_id = p_manager_id)
    and (p_team_id is null or u.team_id = p_team_id)
    and not t.excluded
    and (t.counted or t.flagged)
  group by t.user_id, t.project_id, t.task_id
  order by t.user_id, t.project_id nulls last, t.task_id nulls last;
end;
$$;

revoke all on function public.report_task_rows(date, date, uuid[], uuid, uuid) from public, anon;
grant execute on function public.report_task_rows(date, date, uuid[], uuid, uuid) to authenticated;
