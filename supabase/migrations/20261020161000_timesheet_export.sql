-- #45: timesheet CSV export (TS-20 CSV, TS-21..23, AUD-01).
--
-- The export-timesheet Edge Function turns raw segment rows into the three CSV views
-- (packages/core exportRows.ts). The rows come only from timesheet_export_rows, which
-- checks who the caller may view and writes the audit row in the same call, before it
-- returns anything: an export cannot skip the log, and a direct RPC call is logged too.
--
-- Rows are the stored time_segments, so the CSV adds up from the same raw seconds as
-- timesheet_totals and the dashboard (TS-05/06). Segments are whole seconds, so the
-- per-segment rounding below changes nothing.
--
-- The team filter (TS-20) waits for teams (ORG-08, P1; there is no teams table yet):
-- until then p_manager_id filters to one manager's direct reports.

-- The caller's exportable segments for the employee-local days in [p_from, p_to], one
-- row per segment, as {"row_count": n, "rows": [...]}. Filters (all optional, empty
-- means no filter):
--   p_user_ids     these employees; one the caller may not view is refused (forbidden)
--   p_manager_id   direct reports of this manager (the team filter until ORG-08)
--   p_client_ids / p_project_ids   segments of these clients / projects; naming one
--                  leaves Unassigned time out (it has neither)
--   p_statuses     timesheet status of the segment's week; a week nobody has opened has
--                  no timesheet row yet and counts as draft
-- p_view ('daily', 'project', 'segments') only goes into the audit row: the Edge
-- Function shapes the rows. Unassigned time (no project) comes back with null project
-- and client and billable false.
create function public.timesheet_export_rows(
  p_from date,
  p_to date,
  p_view text,
  p_user_ids uuid[] default null,
  p_manager_id uuid default null,
  p_client_ids uuid[] default null,
  p_project_ids uuid[] default null,
  p_statuses text[] default null
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
begin
  if p_view is null or p_view not in ('daily', 'project', 'segments') then
    raise exception 'invalid_view' using errcode = '22023';
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
        'client_id', p.client_id,
        'client', c.name,
        'billable', coalesce(p.billable, false),
        'counted', t.counted,
        'flagged', t.flagged,
        'excluded', t.excluded,
        'seconds', round(extract(epoch from t.end_at - t.start_at))::bigint,
        'status', coalesce(ts.status, 'draft'),
        'approver', a.full_name
      ) as seg
    from public.time_segments t
    join public.users u on u.id = t.user_id
    left join public.projects p on p.id = t.project_id
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
      and (coalesce(cardinality(p_project_ids), 0) = 0 or t.project_id = any (p_project_ids))
      and (coalesce(cardinality(p_client_ids), 0) = 0 or p.client_id = any (p_client_ids))
      and (coalesce(cardinality(p_statuses), 0) = 0 or coalesce(ts.status, 'draft') = any (p_statuses))
  ) r;

  -- One named employee is the target; anything wider has none.
  if cardinality(p_user_ids) = 1 then
    v_target := p_user_ids[1];
  end if;
  perform internal.audit(v_me.org_id, v_me.id, 'timesheet.exported', v_target,
    jsonb_build_object(
      'view', p_view,
      'from', p_from,
      'to', p_to,
      'user_ids', coalesce(to_jsonb(p_user_ids), '[]'::jsonb),
      'manager_id', p_manager_id,
      'client_ids', coalesce(to_jsonb(p_client_ids), '[]'::jsonb),
      'project_ids', coalesce(to_jsonb(p_project_ids), '[]'::jsonb),
      'statuses', coalesce(to_jsonb(p_statuses), '[]'::jsonb),
      'row_count', v_count
    ));

  return jsonb_build_object('row_count', v_count, 'rows', v_rows);
end;
$$;

revoke all on function public.timesheet_export_rows(date, date, text, uuid[], uuid, uuid[], uuid[], text[])
  from public, anon;
grant execute on function public.timesheet_export_rows(date, date, text, uuid[], uuid, uuid[], uuid[], text[])
  to authenticated;
