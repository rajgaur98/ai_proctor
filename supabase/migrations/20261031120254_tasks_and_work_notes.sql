-- #254 part 1: tasks under projects (PRJ-05) and work notes (TS-24, TS-25).
--
-- Tasks. A project has tasks (name, billable, archived, order). A new task's billable
-- flag defaults to its project's. Owners, admins and managers add, rename and archive
-- them, like projects; everyone in the org reads the names. Tasks are never deleted, only
-- archived: time already logged keeps its task, new time can't pick an archived one.
--
-- Time carries a task only through the dashboard: manual entries (the employee's request,
-- the manager's adjust_time), the manager's project edit (edit_segment) and the
-- employee's re-assignment (reassign_my_time). The agent's tray still picks a project
-- only, so clocked time starts with no task until someone tags it (a tray task picker is
-- a later step). The task goes through buildSegments() (DayInput manualEntries[].taskId,
-- projectEdits[].taskId) into time_segments.task_id. A task always belongs to the time's
-- project; time without a project has no task.
--
-- Work notes. A manual entry has an optional "work done" note (TS-24), and each
-- person-day has one (timesheet_day_notes, TS-25), both up to 2,000 characters. The
-- employee writes them while their week is a draft or returned; once it's submitted the
-- manager reviews them read-only, and once approved they're locked like every other
-- edit (TS-18). The direct manager or delegate may change them on the employee's behalf
-- before approval, with a reason: audit-logged and the employee is notified (TS-13).
-- A day note belongs to its week's timesheet row, so retention removes it with the week.
--
-- Exports: per-project and segment rows get the task (and the task's billable flag), and
-- the per-day view a Work done column: the day note, then the day's entry notes.
--
-- Redefined here, each copied from its latest definition with only this change:
--   request_manual_entry        (20261020123541_manual_entries): + p_task_id, p_note
--   edit_segment                (20261020152000_weekly_timesheets): + p_task_id
--   adjust_time                 (20261020152000_weekly_timesheets): + p_task_id
--   reassign_my_time            (20261020186000_employee_project_edits): + p_task_id
--   segment_inputs              (20261020186000_employee_project_edits): + taskId
--   internal.replace_day_segments (20261020181000_segments_fresh): + task_id
--   timesheet_breakdown         (20261020152000_weekly_timesheets): + task_id column
--   timesheet_export_rows       (20261022120000_overtime_xlsx): + task, note, day_notes
-- The functions that gain arguments or columns are dropped first (an overload would make
-- named calls ambiguous).

-- Tasks --------------------------------------------------------------------------------------

create table public.project_tasks (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  project_id uuid not null references public.projects (id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 120),
  billable boolean not null,
  archived boolean not null default false,
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);
create unique index project_tasks_project_name_idx on public.project_tasks (project_id, lower(name));
create index project_tasks_project_order_idx on public.project_tasks (project_id, sort_order);
alter table public.project_tasks enable row level security;

-- Names only, like projects: everyone in the org reads them. Writes through save_task.
create policy "Members read their org's tasks"
on public.project_tasks for select to authenticated
using (org_id = (select internal.jwt_org_id()));

revoke insert, update, delete on public.project_tasks from anon, authenticated;

-- Time and edits carry a task (null: none).
alter table public.manual_entries
  add column task_id uuid references public.project_tasks (id) on delete set null,
  -- TS-24: what was done in this time.
  add column note text check (length(note) between 1 and 2000);
alter table public.timesheet_edits
  add column task_id uuid references public.project_tasks (id) on delete set null;
alter table public.time_segments
  add column task_id uuid references public.project_tasks (id) on delete set null;

-- `p_task_id` may be logged with `p_project_id`: none, or an active task of that project.
create function internal.task_allowed(p_project_id uuid, p_task_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_task_id is null or exists (
    select 1 from public.project_tasks t
    where t.id = p_task_id and t.project_id = p_project_id and not t.archived
  );
$$;

revoke all on function internal.task_allowed(uuid, uuid) from public, anon, authenticated;

-- PRJ-05: creates (null id) or updates a task of a project. A new task takes the
-- project's billable flag unless one is given, and goes last in the project's order; an
-- update leaves billable as it is when none is given. A task never moves to another
-- project. Returns its id.
create function public.save_task(
  p_id uuid,
  p_project_id uuid,
  p_name text,
  p_billable boolean default null,
  p_archived boolean default false
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me public.users := internal.require_project_manager();
  v_project public.projects;
  v_id uuid;
begin
  select * into v_project from public.projects p
  where p.id = p_project_id and p.org_id = v_me.org_id;
  if not found then
    raise exception 'project_not_found' using errcode = '42501';
  end if;
  if p_id is null then
    insert into public.project_tasks (org_id, project_id, name, billable, archived, sort_order)
    values (v_me.org_id, v_project.id, trim(p_name), coalesce(p_billable, v_project.billable),
      coalesce(p_archived, false),
      coalesce((select max(t.sort_order) + 1 from public.project_tasks t
                where t.project_id = v_project.id), 0))
    returning id into v_id;
  else
    update public.project_tasks
    set name = trim(p_name), billable = coalesce(p_billable, billable),
        archived = coalesce(p_archived, false)
    where id = p_id and project_id = v_project.id and org_id = v_me.org_id
    returning id into v_id;
    if v_id is null then
      raise exception 'task_not_found' using errcode = '42501';
    end if;
  end if;
  return v_id;
exception
  when unique_violation then raise exception 'name_taken' using errcode = '23505';
  when check_violation then raise exception 'invalid_name' using errcode = '22023';
end;
$$;

revoke all on function public.save_task(uuid, uuid, text, boolean, boolean) from public, anon;
grant execute on function public.save_task(uuid, uuid, text, boolean, boolean) to authenticated;

-- Work notes ------------------------------------------------------------------------------------

-- TS-25: what the person did on a day, in their own words. One per person and local day.
create table public.timesheet_day_notes (
  user_id uuid not null references public.users (id) on delete cascade,
  day date not null,
  org_id uuid not null references public.orgs (id) on delete cascade,
  -- The week the day is in: retention and deletion remove the note with it.
  timesheet_id uuid not null references public.timesheets (id) on delete cascade,
  note text not null check (length(note) between 1 and 2000),
  updated_by uuid references public.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  primary key (user_id, day)
);
create index timesheet_day_notes_org_day_idx on public.timesheet_day_notes (org_id, day);
create index timesheet_day_notes_timesheet_idx on public.timesheet_day_notes (timesheet_id);
alter table public.timesheet_day_notes enable row level security;

-- Same rule as the other per-employee tables. Writes only through save_day_note.
create policy "Visible per can_view_user"
on public.timesheet_day_notes for select to authenticated
using (org_id = (select internal.jwt_org_id()) and public.can_view_user(user_id));

revoke insert, update, delete on public.timesheet_day_notes from anon, authenticated;

-- The week holding `p_day` for a work note change by `p_me` (created as a draft if new),
-- after checking who may change it now:
--   - the employee, while the week is a draft or returned (submitted: the manager is
--     reviewing it; approved: locked);
--   - their direct manager or active delegate, until it's approved, with a reason
--     (TS-13: the change is audit-logged and shown to the employee).
-- Owners and admins who aren't the manager only read.
create function internal.work_note_week(
  p_me public.users,
  p_user_id uuid,
  p_day date,
  p_reason text
)
returns public.timesheets
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_emp public.users;
  v_id uuid;
  v_ts public.timesheets;
  v_reason text := nullif(trim(coalesce(p_reason, '')), '');
begin
  select * into v_emp from public.users u where u.id = p_user_id;
  if not found or v_emp.org_id <> p_me.org_id or not public.can_view_user(p_user_id) then
    raise exception 'user_not_found' using errcode = '42501';
  end if;
  if p_day is null then
    raise exception 'invalid_day' using errcode = '22023';
  end if;
  if p_day > (now() at time zone v_emp.timezone)::date then
    raise exception 'in_the_future' using errcode = '22023';
  end if;

  select t.id into v_id from public.timesheets t
  where t.user_id = p_user_id and p_day >= t.period_start and p_day < t.period_start + 7;
  if not found then
    v_id := public.ensure_timesheet(p_user_id, internal.week_start(v_emp.org_id, p_day));
  end if;

  if p_me.id = p_user_id then
    v_ts := internal.load_timesheet(v_id, p_me);
    if v_ts.status = 'submitted' then
      raise exception 'timesheet_submitted' using errcode = '55000';
    end if;
  else
    v_ts := internal.decidable_timesheet(v_id, p_me);
    if v_reason is null or length(v_reason) > 500 then
      raise exception 'invalid_reason' using errcode = '22023';
    end if;
  end if;
  if v_ts.status = 'approved' then
    raise exception 'timesheet_locked' using errcode = '55000';
  end if;
  return v_ts;
end;
$$;

revoke all on function internal.work_note_week(public.users, uuid, date, text) from public, anon, authenticated;

-- TS-25: sets (or, with an empty note, clears) a person's note for a local day. The
-- employee's own changes aren't audit-logged; anyone else's are, with the reason, and
-- the employee is notified.
create function public.save_day_note(
  p_user_id uuid,
  p_day date,
  p_note text,
  p_reason text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me public.users := internal.current_app_user();
  v_note text := nullif(trim(coalesce(p_note, '')), '');
  v_ts public.timesheets;
  v_before text;
begin
  if length(v_note) > 2000 then
    raise exception 'invalid_note' using errcode = '22023';
  end if;
  v_ts := internal.work_note_week(v_me, p_user_id, p_day, p_reason);

  select n.note into v_before from public.timesheet_day_notes n
  where n.user_id = p_user_id and n.day = p_day
  for update;
  if v_before is not distinct from v_note then
    return;
  end if;

  if v_note is null then
    delete from public.timesheet_day_notes where user_id = p_user_id and day = p_day;
  else
    insert into public.timesheet_day_notes (user_id, day, org_id, timesheet_id, note, updated_by)
    values (p_user_id, p_day, v_ts.org_id, v_ts.id, v_note, v_me.id)
    on conflict (user_id, day) do update
      set note = excluded.note, timesheet_id = excluded.timesheet_id,
          updated_by = excluded.updated_by, updated_at = now();
  end if;

  if v_me.id <> p_user_id then
    perform internal.audit(v_ts.org_id, v_me.id, 'timesheet.note_edited', p_user_id,
      jsonb_build_object('timesheet_id', v_ts.id, 'day', p_day, 'before', v_before,
        'after', v_note, 'reason', trim(p_reason)));
    perform internal.notify(v_ts.org_id, p_user_id, 'timesheet.edited',
      jsonb_build_object('timesheet_id', v_ts.id, 'period_start', v_ts.period_start,
        'kind', 'note', 'reason', trim(p_reason), 'by', v_me.id));
  end if;
end;
$$;

-- TS-24 / PRJ-05: changes a manual entry's task and work note (not its times or project:
-- those are a new request, or the manager's adjust_time). Same rules as day notes, for
-- the week the entry starts in; a day of it in an approved week locks it too. A rejected
-- entry can't change. The task must be an active one of the entry's project (or the one
-- it already has). Anyone but the employee is audit-logged with a reason and the employee
-- is notified; the employee's own task change is audit-logged too (it moves counted time,
-- like re-assigning a project), their note change isn't.
create function public.update_manual_entry_details(
  p_id uuid,
  p_task_id uuid,
  p_note text,
  p_reason text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me public.users := internal.current_app_user();
  v_e public.manual_entries;
  v_note text := nullif(trim(coalesce(p_note, '')), '');
  v_ts public.timesheets;
  v_tz text;
begin
  if length(v_note) > 2000 then
    raise exception 'invalid_note' using errcode = '22023';
  end if;
  select * into v_e from public.manual_entries where id = p_id for update;
  if not found or v_e.org_id <> v_me.org_id or not public.can_view_user(v_e.user_id) then
    raise exception 'entry_not_found' using errcode = '42501';
  end if;
  if v_e.status = 'rejected' then
    raise exception 'not_adjustable' using errcode = '55000';
  end if;
  select u.timezone into v_tz from public.users u where u.id = v_e.user_id;
  v_ts := internal.work_note_week(v_me, v_e.user_id, (v_e.start_at at time zone v_tz)::date,
    p_reason);
  if internal.range_locked(v_e.user_id, v_e.start_at, v_e.end_at) then
    raise exception 'day_locked' using errcode = '55000';
  end if;
  if p_task_id is distinct from v_e.task_id
     and not internal.task_allowed(v_e.project_id, p_task_id) then
    raise exception 'task_not_allowed' using errcode = '22023';
  end if;
  if p_task_id is not distinct from v_e.task_id and v_note is not distinct from v_e.note then
    return;
  end if;

  -- An approved entry's new task reaches its segments with the next rebuild (the
  -- manual_entries trigger marks the days).
  update public.manual_entries set task_id = p_task_id, note = v_note where id = v_e.id;

  if v_me.id <> v_e.user_id or p_task_id is distinct from v_e.task_id then
    perform internal.audit(v_e.org_id, v_me.id, 'manual_entry.details_changed', v_e.user_id,
      jsonb_build_object('entry_id', v_e.id, 'timesheet_id', v_ts.id,
        'before', jsonb_build_object('task_id', v_e.task_id, 'note', v_e.note),
        'after', jsonb_build_object('task_id', p_task_id, 'note', v_note),
        'reason', nullif(trim(coalesce(p_reason, '')), '')));
  end if;
  if v_me.id <> v_e.user_id then
    perform internal.notify(v_e.org_id, v_e.user_id, 'timesheet.edited',
      jsonb_build_object('timesheet_id', v_ts.id, 'period_start', v_ts.period_start,
        'kind', 'note', 'reason', trim(p_reason), 'by', v_me.id));
  end if;
end;
$$;

revoke all on function public.save_day_note(uuid, date, text, text) from public, anon;
revoke all on function public.update_manual_entry_details(uuid, uuid, text, text) from public, anon;
grant execute on function public.save_day_note(uuid, date, text, text) to authenticated;
grant execute on function public.update_manual_entry_details(uuid, uuid, text, text) to authenticated;

-- Manual entries: a task and a work note (copy of #42's request_manual_entry) -------------------

-- TS-07, TS-24: as #42's, plus an optional task of the chosen project (not archived) and an
-- optional work note (up to 2,000 characters). New trailing arguments, so the old
-- signature is dropped (an overload would make named calls ambiguous).
drop function public.request_manual_entry(timestamptz, timestamptz, uuid, text);

create function public.request_manual_entry(
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
  v_reason text := trim(coalesce(p_reason, ''));
  v_note text := nullif(trim(coalesce(p_note, '')), '');
  v_overlap text;
  v_auto boolean := not v_me.approval_required or v_me.manager_id is null;
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
  if p_project_id is not null and internal.allowed_project(v_me.id, p_project_id::text) is null then
    raise exception 'project_not_allowed' using errcode = '22023';
  end if;
  if not internal.task_allowed(p_project_id, p_task_id) then
    raise exception 'task_not_allowed' using errcode = '22023';
  end if;
  if length(v_note) > 2000 then
    raise exception 'invalid_note' using errcode = '22023';
  end if;

  -- Serialises this person's requests so two can't both pass the overlap check.
  perform pg_advisory_xact_lock(hashtext('manual_entry:' || v_me.id::text));
  if internal.range_locked(v_me.id, p_start_at, p_end_at) then
    raise exception 'day_locked' using errcode = '55000';
  end if;
  v_overlap := internal.manual_entry_overlap(v_me.id, p_start_at, p_end_at);
  if v_overlap is not null then
    raise exception '%', v_overlap using errcode = '23P01';
  end if;

  insert into public.manual_entries (org_id, user_id, start_at, end_at, project_id, task_id,
    note, reason, status, decided_by, decided_at)
  values (v_me.org_id, v_me.id, p_start_at, p_end_at, p_project_id, p_task_id, v_note, v_reason,
    case when v_auto then 'approved' else 'pending' end,
    case when v_auto then v_me.id end,
    case when v_auto then now() end)
  returning id into v_id;

  perform internal.audit(v_me.org_id, v_me.id, 'manual_entry.requested', v_me.id,
    jsonb_build_object('entry_id', v_id, 'start_at', p_start_at, 'end_at', p_end_at,
      'project_id', p_project_id, 'task_id', p_task_id));
  if v_auto then
    perform internal.audit(v_me.org_id, v_me.id, 'manual_entry.auto_approved', v_me.id,
      jsonb_build_object('entry_id', v_id));
  end if;
  return v_id;
end;
$$;

revoke all on function public.request_manual_entry(timestamptz, timestamptz, uuid, text, uuid, text) from public, anon;
grant execute on function public.request_manual_entry(timestamptz, timestamptz, uuid, text, uuid, text) to authenticated;
-- Dashboard edits carry a task (copies of #43's edit_segment and adjust_time) ------------------

-- TS-13: as #43's; a 'project' edit also sets the task (null: none), which must belong to
-- the new project and not be archived.
drop function public.edit_segment(uuid, text, timestamptz, timestamptz, uuid, text);

create function public.edit_segment(
  p_timesheet_id uuid,
  p_kind text,
  p_start_at timestamptz,
  p_end_at timestamptz,
  p_project_id uuid default null,
  p_reason text default null,
  p_task_id uuid default null
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
  v_id uuid;
begin
  if p_kind is null or p_kind not in ('keep', 'exclude', 'include', 'project') then
    raise exception 'invalid_kind' using errcode = '22023';
  end if;
  if p_start_at is null or p_end_at is null or p_end_at <= p_start_at then
    raise exception 'invalid_range' using errcode = '22023';
  end if;
  if length(v_reason) > 500 or (p_kind <> 'keep' and v_reason is null) then
    raise exception 'invalid_reason' using errcode = '22023';
  end if;

  v_ts := internal.decidable_timesheet(p_timesheet_id, v_me);
  if v_ts.status = 'approved' then
    raise exception 'timesheet_locked' using errcode = '55000';
  end if;
  if p_start_at < internal.local_day_start(v_ts.user_id, v_ts.period_start)
    or p_end_at > internal.local_day_start(v_ts.user_id, v_ts.period_start + 7)
  then
    raise exception 'outside_week' using errcode = '22023';
  end if;

  if p_kind = 'project' then
    if p_project_id is not null and not exists (
      select 1 from public.projects p
      where p.id = p_project_id and p.org_id = v_ts.org_id and not p.archived
    ) then
      raise exception 'project_not_allowed' using errcode = '22023';
    end if;
    if not internal.task_allowed(p_project_id, p_task_id) then
      raise exception 'task_not_allowed' using errcode = '22023';
    end if;
    if not exists (
      select 1 from public.time_segments t
      where t.user_id = v_ts.user_id and t.start_at < p_end_at and t.end_at > p_start_at
    ) then
      raise exception 'no_segments' using errcode = '22023';
    end if;
  elsif not exists (
    select 1 from public.time_segments t
    where t.user_id = v_ts.user_id and t.flagged and t.start_at < p_end_at and t.end_at > p_start_at
  ) then
    -- Only flagged time can be excluded, and only it needs a decision (TS-02).
    raise exception 'not_flagged' using errcode = '22023';
  elsif p_kind = 'keep' and exists (
    select 1 from public.time_segments t
    where t.user_id = v_ts.user_id and t.excluded and t.start_at < p_end_at and t.end_at > p_start_at
  ) then
    -- Undoing an exclusion is an edit: 'include', with a reason.
    raise exception 'already_excluded' using errcode = '55000';
  end if;

  insert into public.timesheet_edits (org_id, timesheet_id, user_id, editor_id, kind, start_at,
    end_at, project_id, task_id, reason)
  values (v_ts.org_id, v_ts.id, v_ts.user_id, v_me.id, p_kind, p_start_at, p_end_at,
    case when p_kind = 'project' then p_project_id end,
    case when p_kind = 'project' then p_task_id end, v_reason)
  returning id into v_id;

  if p_kind = 'project' then
    perform internal.mark_dirty(v_ts.user_id, p_start_at, p_end_at);
  else
    perform internal.apply_decisions(v_ts.user_id, p_start_at, p_end_at);
  end if;

  if p_kind <> 'keep' then
    perform internal.audit(v_ts.org_id, v_me.id, 'timesheet.edited', v_ts.user_id,
      jsonb_build_object('timesheet_id', v_ts.id, 'edit_id', v_id, 'kind', p_kind,
        'start_at', p_start_at, 'end_at', p_end_at, 'project_id', p_project_id,
        'task_id', case when p_kind = 'project' then p_task_id end, 'reason', v_reason));
    perform internal.notify(v_ts.org_id, v_ts.user_id, 'timesheet.edited',
      jsonb_build_object('timesheet_id', v_ts.id, 'period_start', v_ts.period_start,
        'edit_id', v_id, 'kind', p_kind, 'reason', v_reason, 'by', v_me.id));
  end if;
  return v_id;
end;
$$;

-- TS-13: as #43's; the added or changed time also gets a task (null: none) of its project.
-- The task is set as given, so changing an entry's project without one clears it.
drop function public.adjust_time(uuid, timestamptz, timestamptz, uuid, text, uuid);

create function public.adjust_time(
  p_timesheet_id uuid,
  p_start_at timestamptz,
  p_end_at timestamptz,
  p_project_id uuid,
  p_reason text,
  p_entry_id uuid default null,
  p_task_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me public.users := internal.current_app_user();
  v_ts public.timesheets;
  v_reason text := trim(coalesce(p_reason, ''));
  v_entry public.manual_entries;
  v_entry_id uuid := p_entry_id;
  v_before jsonb;
  v_overlap text;
  v_edit uuid;
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

  v_ts := internal.decidable_timesheet(p_timesheet_id, v_me);
  if v_ts.status = 'approved' then
    raise exception 'timesheet_locked' using errcode = '55000';
  end if;
  if p_start_at < internal.local_day_start(v_ts.user_id, v_ts.period_start)
    or p_end_at > internal.local_day_start(v_ts.user_id, v_ts.period_start + 7)
  then
    raise exception 'outside_week' using errcode = '22023';
  end if;
  if p_project_id is not null and not exists (
    select 1 from public.projects p
    where p.id = p_project_id and p.org_id = v_ts.org_id and not p.archived
  ) then
    raise exception 'project_not_allowed' using errcode = '22023';
  end if;
  -- An archived task the entry already has may stay on it.
  if not internal.task_allowed(p_project_id, p_task_id) and not exists (
    select 1 from public.manual_entries me
    where me.id = p_entry_id and me.task_id = p_task_id
      and me.project_id is not distinct from p_project_id
  ) then
    raise exception 'task_not_allowed' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtext('manual_entry:' || v_ts.user_id::text));
  v_overlap := internal.manual_entry_overlap(v_ts.user_id, p_start_at, p_end_at, p_entry_id);
  if v_overlap is not null then
    raise exception '%', v_overlap using errcode = '23P01';
  end if;

  if p_entry_id is null then
    insert into public.manual_entries (org_id, user_id, start_at, end_at, project_id, task_id,
      reason, status, decided_by, decided_at, decision_note)
    values (v_ts.org_id, v_ts.user_id, p_start_at, p_end_at, p_project_id, p_task_id, v_reason,
      'approved', v_me.id, now(), 'Added by the manager')
    returning id into v_entry_id;
  else
    select * into v_entry from public.manual_entries me
    where me.id = p_entry_id and me.user_id = v_ts.user_id for update;
    if not found then
      raise exception 'entry_not_found' using errcode = '42501';
    end if;
    if v_entry.status = 'rejected' then
      raise exception 'not_adjustable' using errcode = '55000';
    end if;
    v_before := jsonb_build_object('start_at', v_entry.start_at, 'end_at', v_entry.end_at,
      'project_id', v_entry.project_id, 'task_id', v_entry.task_id);
    update public.manual_entries
    set start_at = p_start_at, end_at = p_end_at, project_id = p_project_id, task_id = p_task_id
    where id = v_entry.id;
  end if;

  insert into public.timesheet_edits (org_id, timesheet_id, user_id, editor_id, kind, start_at,
    end_at, project_id, task_id, reason, detail)
  values (v_ts.org_id, v_ts.id, v_ts.user_id, v_me.id, 'adjust', p_start_at, p_end_at,
    p_project_id, p_task_id, v_reason, jsonb_build_object('entry_id', v_entry_id, 'before', v_before))
  returning id into v_edit;

  perform internal.audit(v_ts.org_id, v_me.id, 'timesheet.edited', v_ts.user_id,
    jsonb_build_object('timesheet_id', v_ts.id, 'edit_id', v_edit, 'kind', 'adjust',
      'entry_id', v_entry_id, 'start_at', p_start_at, 'end_at', p_end_at,
      'project_id', p_project_id, 'task_id', p_task_id, 'before', v_before, 'reason', v_reason));
  perform internal.notify(v_ts.org_id, v_ts.user_id, 'timesheet.edited',
    jsonb_build_object('timesheet_id', v_ts.id, 'period_start', v_ts.period_start,
      'edit_id', v_edit, 'kind', 'adjust', 'reason', v_reason, 'by', v_me.id));
  return v_entry_id;
end;
$$;

revoke all on function public.edit_segment(uuid, text, timestamptz, timestamptz, uuid, text, uuid) from public, anon;
revoke all on function public.adjust_time(uuid, timestamptz, timestamptz, uuid, text, uuid, uuid) from public, anon;
grant execute on function public.edit_segment(uuid, text, timestamptz, timestamptz, uuid, text, uuid) to authenticated;
grant execute on function public.adjust_time(uuid, timestamptz, timestamptz, uuid, text, uuid, uuid) to authenticated;

-- The employee's re-assignment carries a task (copy of #139's reassign_my_time) ------------------

-- PRJ-04: as #139's; the time also gets a task (null: none) of the project.
drop function public.reassign_my_time(timestamptz, timestamptz, uuid, text);

create function public.reassign_my_time(
  p_start timestamptz,
  p_end timestamptz,
  p_project_id uuid,
  p_reason text default null,
  p_task_id uuid default null
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
  if not internal.task_allowed(p_project_id, p_task_id) then
    raise exception 'task_not_allowed' using errcode = '22023';
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
    end_at, project_id, task_id, reason, detail)
  values (v_ts.org_id, v_ts.id, v_me.id, v_me.id, 'employee_project', p_start, p_end,
    p_project_id, p_task_id, v_reason, jsonb_build_object('before_projects', v_before))
  returning id into v_id;

  perform internal.mark_dirty(v_me.id, p_start, p_end);

  perform internal.audit(v_ts.org_id, v_me.id, 'timesheet.project_reassigned', v_me.id,
    jsonb_build_object('timesheet_id', v_ts.id, 'edit_id', v_id, 'start_at', p_start,
      'end_at', p_end, 'project_id', p_project_id, 'task_id', p_task_id,
      'before_projects', v_before,
      'reason', v_reason));
  return v_id;
end;
$$;

revoke all on function public.reassign_my_time(timestamptz, timestamptz, uuid, text, uuid) from public, anon;
grant execute on function public.reassign_my_time(timestamptz, timestamptz, uuid, text, uuid) to authenticated;

-- Rebuild: tasks in and out (copies of #139's segment_inputs, #126's replace_day_segments) -------

-- As #139's, with each manual entry's and project edit's task (DayInput taskId).
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

-- As the latest (20261020181000_segments_fresh), with each segment's task_id (absent: none).
create or replace function internal.replace_day_segments(
  p_user_id uuid,
  p_day date,
  p_segments jsonb,
  p_loaded_at timestamptz default clock_timestamp()
)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid;
  v_start timestamptz;
  v_end timestamptz;
  v_n int;
begin
  select u.org_id into v_org from public.users u where u.id = p_user_id;
  if v_org is null then
    raise exception 'user_not_found' using errcode = '22023';
  end if;
  if jsonb_typeof(p_segments) is distinct from 'array' then
    raise exception 'segments_not_array' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtext(p_user_id::text || p_day::text));

  if internal.day_locked(p_user_id, p_day) then
    delete from public.dirty_days d where d.user_id = p_user_id and d.day = p_day;
    return null;
  end if;

  v_start := internal.local_day_start(p_user_id, p_day);
  v_end := internal.local_day_start(p_user_id, p_day + 1);

  delete from public.time_segments t
  where t.user_id = p_user_id and t.day = p_day and t.source = 'auto';

  insert into public.time_segments (
    org_id, user_id, day, start_at, end_at, type, project_id, task_id, counted, flagged, source
  )
  select v_org, p_user_id, p_day, to_timestamp(s.start), to_timestamp(s."end"), s.type,
         s.project_id, s.task_id, s.counted, s.flagged, 'auto'
  from jsonb_to_recordset(p_segments) as s(
    start bigint, "end" bigint, type text, project_id uuid, task_id uuid, counted boolean,
    flagged boolean
  );
  get diagnostics v_n = row_count;

  if exists (
    select 1 from public.time_segments t
    where t.user_id = p_user_id and t.day = p_day and t.source = 'auto'
      and (t.start_at < v_start or t.end_at > v_end)
  ) then
    raise exception 'segment_outside_day' using errcode = '22023';
  end if;

  perform internal.apply_decisions(p_user_id, v_start, v_end);

  insert into internal.segment_rebuilds (user_id, day, rebuilt_at)
  values (p_user_id, p_day, clock_timestamp())
  on conflict (user_id, day) do update set rebuilt_at = excluded.rebuilt_at;

  delete from public.dirty_days d
  where d.user_id = p_user_id and d.day = p_day and d.marked_at <= p_loaded_at;
  return v_n;
end;
$$;

-- The week's seconds by task too (copy of #43's timesheet_breakdown) ---------------------------

-- As #43's, grouped by task as well. Its columns change, so it is dropped and recreated.
drop function public.timesheet_breakdown(uuid, date, date);

create function public.timesheet_breakdown(p_user_id uuid, p_from date, p_to date)
returns table (
  day date,
  type text,
  project_id uuid,
  task_id uuid,
  counted boolean,
  flagged boolean,
  excluded boolean,
  seconds bigint
)
language sql
stable
set search_path = ''
as $$
  select t.day, t.type, t.project_id, t.task_id, t.counted, t.flagged, t.excluded,
         round(sum(extract(epoch from t.end_at - t.start_at)))::bigint
  from public.time_segments t
  where t.user_id = p_user_id and t.day between p_from and p_to
  group by t.day, t.type, t.project_id, t.task_id, t.counted, t.flagged, t.excluded
  order by t.day;
$$;

revoke all on function public.timesheet_breakdown(uuid, date, date) from public, anon;
grant execute on function public.timesheet_breakdown(uuid, date, date) to authenticated;

-- Export: task, billable by task, work notes (copy of #65's timesheet_export_rows) -------------

-- As #65's (20261022120000_overtime_xlsx): each row also has task_id and task, billable is
-- the task's flag when there is one, a manual segment has its entry's note, and the reply
-- has day_notes for the person-days it covers. Same arguments, so replaced in place.
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
      'row_count', v_count
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
    'overtime', jsonb_build_object(
      'daily_hours', v_policy -> 'overtime_daily_hours',
      'weekly_hours', v_policy -> 'overtime_weekly_hours'
    ),
    'week_start', v_policy ->> 'week_start'
  );
end;
$$;
