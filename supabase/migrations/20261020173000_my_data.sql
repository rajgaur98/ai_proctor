-- #49: My data (EMP-02, EMP-03, EMP-04, ACT-05).
--
-- The audit_log select policy is admin-only, so the employee's "who viewed my
-- captures" can't read it directly. my_capture_views returns the capture.viewed rows
-- about the caller (viewer name, role and time) and nothing else. The caller's own
-- views are logged like any other (capture_view audits every open, AUD-01) but are not
-- listed: "who viewed" is about other people.
--
-- The rest are small helpers for the page and the self-export Edge Function
-- (export-my-data), each limited to the caller's own rows or to the service role.

-- Who viewed my captures (EMP-03) ------------------------------------------------------

create function public.my_capture_views(p_days int default 30)
returns table (
  viewed_at timestamptz,
  viewer_id uuid,
  viewer_name text,
  viewer_role text,
  checkin_id uuid,
  checkin_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_me public.users := internal.current_app_user();
  v_days int := greatest(1, least(coalesce(p_days, 30), 3650));
begin
  return query
  select a.at, a.actor_id, u.full_name, u.role::text,
         c.id, c.scheduled_at
  from public.audit_log a
  left join public.users u on u.id = a.actor_id
  left join public.checkin_events c
    on c.id::text = a.metadata ->> 'checkin_id' and c.user_id = v_me.id
  where a.action = 'capture.viewed'
    and a.org_id = v_me.org_id
    and a.target_user_id = v_me.id
    and a.actor_id is distinct from v_me.id
    and a.at >= now() - make_interval(days => v_days)
  order by a.at desc, a.id desc
  limit 500;
end;
$$;

revoke all on function public.my_capture_views(int) from public, anon;
grant execute on function public.my_capture_views(int) to authenticated;

-- Manager edits with who made them (EMP-02, TS-13) -------------------------------------

-- The employee can't read their manager's users row (can_view_user is one-directional),
-- so editor names come from here. 'keep' decisions are review notes, not edits, and stay
-- hidden from the employee, as in the timesheet_edits policy.
create function public.my_edit_history(p_limit int default 50)
returns table (
  id uuid,
  kind text,
  start_at timestamptz,
  end_at timestamptz,
  project_id uuid,
  reason text,
  editor_id uuid,
  editor_name text,
  created_at timestamptz,
  period_start date
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
  select e.id, e.kind, e.start_at, e.end_at, e.project_id, e.reason,
         e.editor_id, u.full_name, e.created_at, t.period_start
  from public.timesheet_edits e
  join public.timesheets t on t.id = e.timesheet_id
  left join public.users u on u.id = e.editor_id
  where e.user_id = v_me.id and e.org_id = v_me.org_id and e.kind <> 'keep'
  order by e.seq desc
  limit greatest(1, least(coalesce(p_limit, 50), 500));
end;
$$;

revoke all on function public.my_edit_history(int) from public, anon;
grant execute on function public.my_edit_history(int) to authenticated;

-- The caller's direct manager, for the "who can see this" line and the Submit hint.
create function public.my_manager()
returns table (id uuid, full_name text)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_me public.users := internal.current_app_user();
begin
  return query
  select m.id, m.full_name from public.users m
  where m.id = v_me.manager_id and m.org_id = v_me.org_id;
end;
$$;

revoke all on function public.my_manager() from public, anon;
grant execute on function public.my_manager() to authenticated;

-- Activity (ACT-05) --------------------------------------------------------------------

-- Seconds per app and site over [p_from, p_to), with up to five window titles seen.
-- Runs as the caller, so row-level security limits it to the people they may view.
create function public.activity_summary(p_user_id uuid, p_from timestamptz, p_to timestamptz)
returns table (
  app_name text,
  domain text,
  seconds bigint,
  titles text[]
)
language sql
stable
set search_path = ''
as $$
  select s.app_name, s.domain, sum(s.seconds)::bigint,
         (array_agg(distinct s.window_title) filter (where s.window_title is not null))[1:5]
  from public.activity_samples s
  where s.user_id = p_user_id and s.minute >= p_from and s.minute < p_to
  group by s.app_name, s.domain
  order by sum(s.seconds) desc, s.app_name
  limit 200;
$$;

revoke all on function public.activity_summary(uuid, timestamptz, timestamptz) from public, anon;
grant execute on function public.activity_summary(uuid, timestamptz, timestamptz) to authenticated;

-- Self-export (EMP-04) -----------------------------------------------------------------

-- Both are for the export-my-data Edge Function, which calls them with the service role
-- and the user id of the verified caller; nobody else may run them.

-- Sizes of the capture files that exist under the user's own folder, among the paths
-- the function worked out from the user's check-ins. Lets it refuse an export that is
-- too large before streaming anything.
create function public.export_capture_objects(p_user_id uuid, p_paths text[])
returns table (name text, bytes bigint)
language sql
stable
security definer
set search_path = ''
as $$
  select o.name, coalesce((o.metadata ->> 'size')::bigint, 0)
  from storage.objects o
  join public.users u on u.id = p_user_id
  where o.bucket_id = 'captures'
    and o.name = any (p_paths)
    and starts_with(o.name, u.org_id::text || '/' || u.id::text || '/')
  order by o.name;
$$;

-- AUD-01: the export is logged with what it contained, before it is returned.
create function public.record_my_data_export(p_user_id uuid, p_counts jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user public.users;
begin
  select * into v_user from public.users u where u.id = p_user_id and u.active;
  if not found then
    raise exception 'user_not_found' using errcode = '42501';
  end if;
  perform internal.audit(v_user.org_id, v_user.id, 'my_data.exported', v_user.id,
    jsonb_build_object('counts', coalesce(p_counts, '{}'::jsonb)));
end;
$$;

revoke all on function public.export_capture_objects(uuid, text[]) from public, anon, authenticated;
revoke all on function public.record_my_data_export(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.export_capture_objects(uuid, text[]) to service_role;
grant execute on function public.record_my_data_export(uuid, jsonb) to service_role;
