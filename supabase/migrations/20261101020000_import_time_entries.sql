-- #282 (#256 follow-up): import manual time entries from another tool (TS-31).
--
-- The dashboard checks a time-entry file row by row (apps/web/src/lib/import/timeEntries.ts)
-- and sends ImportTimeEntry items (packages/contracts/src/imports.ts) to import_apply with
-- kind 'time_entries'. Each item becomes a manual entry for the person, under exactly the
-- rules of their own request (request_manual_entry, TS-07, TS-24):
--   - pending until their manager decides, or approved at once when they need no approval
--     (TS-16: approval_required off, or nobody above them);
--   - at most 24 hours, not in the future, a reason, a note of up to 2,000 characters;
--   - a project they can log to (a member, not archived) and a task of that project;
--   - no overlap with their clocked time or their other pending or approved entries;
--   - nothing in an approved (locked) week.
-- To share those rules rather than copy them, request_manual_entry's body moves into
-- internal.create_manual_entry(person, actor, ...), and request_manual_entry calls it with
-- the caller as both: the same checks, row and audit events as before. An import calls it
-- with the person and the importing admin, so the audit events (manual_entry.requested,
-- manual_entry.auto_approved) name the admin as actor, the person as target and carry
-- "import": true.
--
-- A re-import matches on person, start and end: an identical entry (same project, task,
-- note and reason, whatever its status) is left alone and counted as unchanged; a
-- different one is refused (entry_exists). Imports never change existing entries.
-- import.applied gets an `unchanged` count for this kind.
--
-- The preview also needs what's already there for the file's people and dates:
-- import_time_entries_context returns their entries, clocked time and approved weeks as
-- one JSON value (so no page limit cuts it short). Admin-only, like import_apply.
--
-- Redefined here, each copied from its latest definition:
--   request_manual_entry (20261031120254_tasks_and_work_notes): body moved, unchanged, into
--                         internal.create_manual_entry; it now calls that.
--   import_apply         (20261031160000_import_apply): + kind 'time_entries' and its
--                         unchanged count.

-- The rules of a manual entry request, for `p_user`, by `p_actor` (the person themselves,
-- or an admin importing). Returns the entry id. `p_audit` is added to the audit metadata.
create function internal.create_manual_entry(
  p_user public.users,
  p_actor public.users,
  p_start_at timestamptz,
  p_end_at timestamptz,
  p_project_id uuid,
  p_reason text,
  p_task_id uuid,
  p_note text,
  p_audit jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reason text := trim(coalesce(p_reason, ''));
  v_note text := nullif(trim(coalesce(p_note, '')), '');
  v_overlap text;
  v_auto boolean := not p_user.approval_required or p_user.manager_id is null;
  v_id uuid;
begin
  if p_start_at is null or p_end_at is null or p_end_at <= p_start_at then
    raise exception 'invalid_range' using errcode = '22023';
  end if;
  if p_end_at - p_start_at > interval '24 hours' then
    raise exception 'range_too_long' using errcode = '22023';
  end if;
  if p_end_at > now() then
    raise exception 'in_the_future' using errcode = '22023';
  end if;
  if length(v_reason) not between 1 and 500 then
    raise exception 'invalid_reason' using errcode = '22023';
  end if;
  if p_project_id is not null and internal.allowed_project(p_user.id, p_project_id::text) is null then
    raise exception 'project_not_allowed' using errcode = '22023';
  end if;
  if not internal.task_allowed(p_project_id, p_task_id) then
    raise exception 'task_not_allowed' using errcode = '22023';
  end if;
  if length(v_note) > 2000 then
    raise exception 'invalid_note' using errcode = '22023';
  end if;

  -- Serialises this person's requests so two can't both pass the overlap check.
  perform pg_advisory_xact_lock(hashtext('manual_entry:' || p_user.id::text));
  if internal.range_locked(p_user.id, p_start_at, p_end_at) then
    raise exception 'day_locked' using errcode = '55000';
  end if;
  v_overlap := internal.manual_entry_overlap(p_user.id, p_start_at, p_end_at);
  if v_overlap is not null then
    raise exception '%', v_overlap using errcode = '23P01';
  end if;

  insert into public.manual_entries (org_id, user_id, start_at, end_at, project_id, task_id,
    note, reason, status, decided_by, decided_at)
  values (p_user.org_id, p_user.id, p_start_at, p_end_at, p_project_id, p_task_id, v_note, v_reason,
    case when v_auto then 'approved' else 'pending' end,
    case when v_auto then p_user.id end,
    case when v_auto then now() end)
  returning id into v_id;

  perform internal.audit(p_user.org_id, p_actor.id, 'manual_entry.requested', p_user.id,
    jsonb_build_object('entry_id', v_id, 'start_at', p_start_at, 'end_at', p_end_at,
      'project_id', p_project_id, 'task_id', p_task_id) || coalesce(p_audit, '{}'::jsonb));
  if v_auto then
    perform internal.audit(p_user.org_id, p_actor.id, 'manual_entry.auto_approved', p_user.id,
      jsonb_build_object('entry_id', v_id) || coalesce(p_audit, '{}'::jsonb));
  end if;
  return v_id;
end;
$$;

revoke all on function internal.create_manual_entry(public.users, public.users, timestamptz, timestamptz, uuid, text, uuid, text, jsonb) from public, anon, authenticated;

-- TS-07, TS-24: the caller asks for time they weren't clocked in for (see
-- internal.create_manual_entry). Same signature, grants and behaviour as #254's.
create or replace function public.request_manual_entry(
  p_start_at timestamptz,
  p_end_at timestamptz,
  p_project_id uuid,
  p_reason text,
  p_task_id uuid default null,
  p_note text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me public.users := internal.current_app_user();
begin
  return internal.create_manual_entry(v_me, v_me, p_start_at, p_end_at, p_project_id, p_reason,
    p_task_id, p_note);
end;
$$;

-- One imported entry (see the header). True when it was created, false when an identical
-- one was already there.
create function internal.import_time_entry(p_me public.users, p_item jsonb)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user public.users := internal.import_user(p_me.org_id, p_item ->> 'email');
  v_start timestamptz := (p_item ->> 'start_at')::timestamptz;
  v_end timestamptz := (p_item ->> 'end_at')::timestamptz;
  v_reason text := trim(coalesce(p_item ->> 'reason', ''));
  v_note text := nullif(trim(coalesce(p_item ->> 'note', '')), '');
  v_client_id uuid;
  v_project_id uuid;
  v_task_id uuid;
  v_same public.manual_entries;
begin
  if p_item ->> 'action' <> 'create' then
    raise exception 'invalid_import' using errcode = '22023';
  end if;
  if v_user.id is null then
    raise exception 'user_not_found' using errcode = '22023';
  end if;
  if not v_user.active then
    raise exception 'user_inactive' using errcode = '22023';
  end if;

  if p_item ->> 'project' is not null then
    if p_item ->> 'client' is not null then
      select c.id into v_client_id from public.clients c
      where c.org_id = p_me.org_id and lower(c.name) = lower(btrim(p_item ->> 'client'));
      if v_client_id is null then
        raise exception 'client_not_found' using errcode = '22023';
      end if;
    end if;
    select p.id into v_project_id from public.projects p
    where p.org_id = p_me.org_id and p.client_id is not distinct from v_client_id
      and lower(p.name) = lower(btrim(p_item ->> 'project'));
    if v_project_id is null then
      raise exception 'project_not_found' using errcode = '22023';
    end if;
  end if;
  if p_item ->> 'task' is not null then
    select t.id into v_task_id from public.project_tasks t
    where t.project_id = v_project_id and lower(t.name) = lower(btrim(p_item ->> 'task'));
    if v_task_id is null then
      raise exception 'task_not_found' using errcode = '22023';
    end if;
  end if;

  -- The same person, start and end is the same entry: left alone when identical.
  perform pg_advisory_xact_lock(hashtext('manual_entry:' || v_user.id::text));
  select * into v_same from public.manual_entries me
  where me.user_id = v_user.id and me.start_at = v_start and me.end_at = v_end
  order by me.created_at
  limit 1;
  if found then
    if v_same.project_id is not distinct from v_project_id
      and v_same.task_id is not distinct from v_task_id
      and v_same.note is not distinct from v_note
      and v_same.reason = v_reason
    then
      return false;
    end if;
    raise exception 'entry_exists' using errcode = '23505';
  end if;

  perform internal.create_manual_entry(v_user, p_me, v_start, v_end, v_project_id, v_reason,
    v_task_id, v_note, jsonb_build_object('import', true));
  return true;
end;
$$;

revoke all on function internal.import_time_entry(public.users, jsonb) from public, anon, authenticated;

-- import_apply (copy of #256's) with the time_entries kind ------------------------------------

create or replace function public.import_apply(p_payload jsonb, p_new_users jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me public.users := internal.current_app_user();
  v_kind text := p_payload ->> 'kind';
  v_items jsonb := p_payload -> 'items';
  v_item jsonb;
  v_rows text;
  v_created int := 0;
  v_updated int := 0;
  v_unchanged int := 0;
  v_applied boolean;
  v_rowcount int := 0;
  v_late jsonb := '[]'::jsonb;
  v_pass int;
  v_err_message text;
  v_err_state text;
  v_err_detail text;
  v_counts jsonb;
begin
  perform internal.require_org_admin(v_me.org_id);
  if v_kind is null
    or v_kind not in ('people', 'teams', 'clients', 'projects', 'shifts', 'time_entries')
    or jsonb_typeof(v_items) is distinct from 'array'
    or jsonb_array_length(v_items) not between 1 and 5000
    or jsonb_typeof(coalesce(p_new_users, '{}'::jsonb)) <> 'object'
  then
    raise exception 'invalid_import' using errcode = '22023';
  end if;
  -- One import at a time per org, so two admins can't interleave.
  perform pg_advisory_xact_lock(hashtextextended('import_apply:' || v_me.org_id::text, 0));

  -- People made employees go last, after the people who reported to them have moved
  -- (update_member refuses has_reports).
  for v_pass in 1..2 loop
    for v_item in
      select i from jsonb_array_elements(v_items) i
      where v_kind <> 'people'
        or (v_pass = 1) <> (i ->> 'action' = 'update' and i ->> 'role' = 'employee' and exists (
          select 1 from public.users u
          where u.org_id = v_me.org_id and lower(u.email) = lower(btrim(i ->> 'email'))
            and u.role <> 'employee'))
    loop
      continue when v_kind <> 'people' and v_pass = 2;
      v_rows := coalesce((select string_agg(r, ',') from jsonb_array_elements_text(v_item -> 'rows') r), '?');
      v_rowcount := v_rowcount + coalesce(jsonb_array_length(v_item -> 'rows'), 0);
      v_applied := true;
      begin
        if v_item ->> 'action' not in ('create', 'update') then
          raise exception 'invalid_import' using errcode = '22023';
        end if;
        case v_kind
          when 'people' then perform internal.import_person(v_me, v_item, p_new_users);
          when 'teams' then perform internal.import_team(v_me, v_item);
          when 'clients' then perform internal.import_client(v_me, v_item);
          when 'projects' then perform internal.import_project(v_me, v_item);
          when 'shifts' then perform internal.import_shifts(v_me, v_item);
          when 'time_entries' then v_applied := internal.import_time_entry(v_me, v_item);
        end case;
      exception when others then
        get stacked diagnostics v_err_message = message_text, v_err_state = returned_sqlstate,
          v_err_detail = pg_exception_detail;
        raise exception '%', v_err_message using errcode = v_err_state,
          detail = 'rows: ' || v_rows, hint = coalesce(v_err_detail, '');
      end;
      if not v_applied then v_unchanged := v_unchanged + 1;
      elsif v_item ->> 'action' = 'create' then v_created := v_created + 1;
      else v_updated := v_updated + 1;
      end if;
    end loop;
  end loop;

  v_counts := jsonb_build_object('kind', v_kind, 'created', v_created, 'updated', v_updated)
    || case when v_kind = 'time_entries' then jsonb_build_object('unchanged', v_unchanged)
       else '{}'::jsonb end;
  perform internal.audit(v_me.org_id, v_me.id, 'import.applied', null,
    v_counts || jsonb_build_object('rows', v_rowcount));
  return v_counts;
end;
$$;

-- What a time-entry import is checked against (TimeContext in apps/web/src/lib/import):
-- for the people `p_emails` in the caller's org, their manual entries (any status) and
-- clocked time around the dates [p_from, p_to] (a day's margin for time zones), and their
-- approved weeks that touch those dates.
create function public.import_time_entries_context(p_emails text[], p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_me public.users := internal.current_app_user();
  v_from timestamptz;
  v_to timestamptz;
begin
  perform internal.require_org_admin(v_me.org_id);
  if p_emails is null or cardinality(p_emails) > 5000 or p_from is null or p_to is null
    or p_to < p_from
  then
    raise exception 'invalid_import' using errcode = '22023';
  end if;
  v_from := (p_from - 1)::timestamp at time zone 'UTC';
  v_to := (p_to + 2)::timestamp at time zone 'UTC';

  return (
    with people as (
      select u.id, lower(u.email) as email from public.users u
      where u.org_id = v_me.org_id
        and lower(u.email) in (select lower(btrim(e)) from unnest(p_emails) e)
    )
    select jsonb_build_object(
      'entries', coalesce((
        select jsonb_agg(jsonb_build_object('email', pe.email, 'start_at', me.start_at,
          'end_at', me.end_at, 'status', me.status, 'project', p.name, 'client', c.name,
          'task', t.name, 'note', me.note, 'reason', me.reason) order by me.start_at)
        from public.manual_entries me
        join people pe on pe.id = me.user_id
        left join public.projects p on p.id = me.project_id
        left join public.clients c on c.id = p.client_id
        left join public.project_tasks t on t.id = me.task_id
        where me.start_at < v_to and me.end_at > v_from), '[]'::jsonb),
      'clocked', coalesce((
        select jsonb_agg(jsonb_build_object('email', pe.email, 'start_at', cs.start_at,
          'end_at', cs.end_at) order by cs.start_at)
        from public.clock_sessions cs
        join people pe on pe.id = cs.user_id
        where cs.start_at < v_to and coalesce(cs.end_at, now()) > v_from), '[]'::jsonb),
      'locked', coalesce((
        select jsonb_agg(jsonb_build_object('email', pe.email, 'period_start', ts.period_start)
          order by ts.period_start)
        from public.timesheets ts
        join people pe on pe.id = ts.user_id
        where ts.status = 'approved' and ts.period_start > p_from - 7
          and ts.period_start <= p_to), '[]'::jsonb)
    )
  );
end;
$$;

revoke all on function public.import_time_entries_context(text[], date, date) from public, anon;
grant execute on function public.import_time_entries_context(text[], date, date) to authenticated;
