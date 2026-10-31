-- #266 (#254 part 7, TS-29): the Timesheets list shows billable and non-billable time per
-- person and totals by client, project and task for the timesheets shown. It needs each
-- person's worked seconds by project and task for the week; timesheet_breakdown gives that
-- for one person only, and timesheet_totals has no project.
--
-- New function, nothing redefined. Same rules as timesheet_totals (20261020152000_weekly_
-- timesheets): worked is counted and not excluded time, security invoker so the
-- time_segments policy (can_view_user) decides whose rows come back, and each person's
-- rows add up to timesheet_totals' worked_s (segments are whole seconds). Billable and
-- the client come from the project and task (packages/core timeTotals.ts), the way the
-- export decides them (20261031120254_tasks_and_work_notes: coalesce(task, project, false)).

create function public.timesheet_assignment_totals(p_from date, p_to date)
returns table (user_id uuid, project_id uuid, task_id uuid, seconds bigint)
language sql
stable
set search_path = ''
as $$
  select t.user_id, t.project_id, t.task_id,
         round(sum(extract(epoch from t.end_at - t.start_at)))::bigint
  from public.time_segments t
  where t.day between p_from and p_to and t.counted and not t.excluded
  group by t.user_id, t.project_id, t.task_id;
$$;

revoke all on function public.timesheet_assignment_totals(date, date) from public, anon;
grant execute on function public.timesheet_assignment_totals(date, date) to authenticated;
