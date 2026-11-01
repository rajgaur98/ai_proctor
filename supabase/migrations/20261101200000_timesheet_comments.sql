-- #265 (#254 part 6): comments on a week's rows and manual entries (TS-33, AUD-01), and
-- who approved a week, for the lock banner.
--
-- A comment is on one person's week (its timesheet row) and targets either
--   - a row of the weekly grid (TS-32): a project and task of the week, both null for
--     Unassigned, a null task for the project's time without one; or
--   - a single manual entry. Its week is the one its start falls in (the employee's local
--     day, as for the entry's other changes), and its project and task are copied from
--     the entry when the comment is written, so the comment can be grouped by row and keeps
--     its place if the entry later goes (a cancel or a merge sets manual_entry_id to null;
--     the comment stays).
-- Comments are never edited or deleted by anyone: they stay after approval, and retention
-- and a person's deletion remove them with the week.
--
-- Reading: whoever can view the week (can_view_user: the employee, their manager and
-- active delegate, owners and admins). Writing only through add_timesheet_comment: the
-- employee and the people who review the week (direct manager, active delegate). Owners
-- and admins who aren't the manager only read, as for the rest of the review (TS-12).
-- A comment doesn't change the sheet, so it may be written in any state, approved too.
-- Each one is audit-logged (timesheet.commented: where it is and its length, not its
-- words, which the table keeps) and the other side is told (timesheet.commented
-- notification): the employee when a reviewer writes, the manager and active delegates
-- when the employee writes. The author is never told about their own comment.
--
-- The author's name is stored with the comment as it is when written (like the audit
-- log's actor_name): an employee can't read their manager's user row, and the thread
-- still reads "Max Manager" after Max's row is gone.
--
-- Redefined here, each copied from its latest definition with only this change:
--   retention_purge_rows      (20261020193000_retention_messages): + timesheet_comments
--   internal.delete_user_data (20261020182000_data_requests): + timesheet_comments

-- Comments -------------------------------------------------------------------------------------

create table public.timesheet_comments (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  timesheet_id uuid not null references public.timesheets (id) on delete cascade,
  -- Whose week (access checks, exports, deletion).
  user_id uuid not null references public.users (id) on delete cascade,
  target text not null check (target in ('row', 'entry')),
  -- The row: null project is Unassigned; a task always belongs to the project. For an
  -- entry comment, the entry's project and task when the comment was written.
  project_id uuid references public.projects (id) on delete set null,
  task_id uuid references public.project_tasks (id) on delete set null,
  -- target = 'entry': the entry, null once it's gone (cancelled or merged away).
  manual_entry_id uuid references public.manual_entries (id) on delete set null,
  author_id uuid references public.users (id) on delete set null,
  author_name text,
  body text not null check (length(body) between 1 and 2000),
  created_at timestamptz not null default now(),
  constraint timesheet_comments_row_has_no_entry check (target = 'entry' or manual_entry_id is null)
);

create index timesheet_comments_timesheet_idx on public.timesheet_comments (timesheet_id, created_at);
create index timesheet_comments_entry_idx on public.timesheet_comments (manual_entry_id)
  where manual_entry_id is not null;
create index timesheet_comments_user_idx on public.timesheet_comments (user_id, created_at);
alter table public.timesheet_comments enable row level security;

-- Same rule as the other per-employee tables. Writes only through add_timesheet_comment.
create policy "Visible per can_view_user"
on public.timesheet_comments for select to authenticated
using (org_id = (select internal.jwt_org_id()) and public.can_view_user(user_id));

revoke insert, update, delete on public.timesheet_comments from anon, authenticated;

-- TS-33: adds a comment to a row of a week (p_timesheet_id with p_project_id and
-- p_task_id, both null for Unassigned) or to a manual entry (p_manual_entry_id; its week
-- is found from the entry, and p_timesheet_id, when given, must be that week). The
-- employee and their direct manager or active delegate may comment, in any state of the
-- week. Audit-logged; the other side is notified. Returns the comment's id.
create function public.add_timesheet_comment(
  p_timesheet_id uuid,
  p_body text,
  p_project_id uuid default null,
  p_task_id uuid default null,
  p_manual_entry_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me public.users := internal.current_app_user();
  v_body text := trim(coalesce(p_body, ''));
  v_entry public.manual_entries;
  v_emp public.users;
  v_ts public.timesheets;
  v_ts_id uuid;
  v_day date;
  v_project uuid := p_project_id;
  v_task uuid := p_task_id;
  v_target text := case when p_manual_entry_id is null then 'row' else 'entry' end;
  v_id uuid;
  v_payload jsonb;
  r record;
begin
  if length(v_body) not between 1 and 2000 then
    raise exception 'invalid_comment' using errcode = '22023';
  end if;

  if v_target = 'entry' then
    if p_project_id is not null or p_task_id is not null then
      raise exception 'invalid_target' using errcode = '22023';
    end if;
    select * into v_entry from public.manual_entries e where e.id = p_manual_entry_id;
    if not found or v_entry.org_id <> v_me.org_id or not public.can_view_user(v_entry.user_id) then
      raise exception 'entry_not_found' using errcode = '42501';
    end if;
    select * into v_emp from public.users u where u.id = v_entry.user_id;
    v_day := (v_entry.start_at at time zone v_emp.timezone)::date;
    select t.id into v_ts_id from public.timesheets t
    where t.user_id = v_emp.id and v_day >= t.period_start and v_day < t.period_start + 7;
    if not found then
      v_ts_id := public.ensure_timesheet(v_emp.id, internal.week_start(v_emp.org_id, v_day));
    end if;
    if p_timesheet_id is not null and p_timesheet_id <> v_ts_id then
      raise exception 'invalid_target' using errcode = '22023';
    end if;
    v_project := v_entry.project_id;
    v_task := v_entry.task_id;
  else
    if p_timesheet_id is null then
      raise exception 'invalid_target' using errcode = '22023';
    end if;
    v_ts_id := p_timesheet_id;
  end if;

  v_ts := internal.load_timesheet(v_ts_id, v_me);
  select * into v_emp from public.users u where u.id = v_ts.user_id;
  if v_ts.user_id <> v_me.id and not internal.is_entry_decider(v_me, v_ts.user_id) then
    raise exception 'not_allowed' using errcode = '42501';
  end if;

  -- A row is a project of the org (or Unassigned) and, optionally, one of its tasks.
  -- Archived ones too: time already logged keeps them.
  if v_target = 'row' then
    if v_project is not null and not exists (
      select 1 from public.projects p where p.id = v_project and p.org_id = v_ts.org_id
    ) then
      raise exception 'invalid_target' using errcode = '22023';
    end if;
    if v_task is not null and (v_project is null or not exists (
      select 1 from public.project_tasks t where t.id = v_task and t.project_id = v_project
    )) then
      raise exception 'invalid_target' using errcode = '22023';
    end if;
  end if;

  insert into public.timesheet_comments (org_id, timesheet_id, user_id, target, project_id,
    task_id, manual_entry_id, author_id, author_name, body)
  values (v_ts.org_id, v_ts.id, v_ts.user_id, v_target, v_project, v_task, p_manual_entry_id,
    v_me.id, v_me.full_name, v_body)
  returning id into v_id;

  -- AUD-01: where the comment is and how long it is; its words stay in the table, which
  -- retention purges with the week.
  perform internal.audit(v_ts.org_id, v_me.id, 'timesheet.commented', v_ts.user_id,
    jsonb_build_object('timesheet_id', v_ts.id, 'period_start', v_ts.period_start,
      'comment_id', v_id, 'target', v_target, 'project_id', v_project, 'task_id', v_task,
      'manual_entry_id', p_manual_entry_id, 'length', length(v_body)));

  v_payload := jsonb_build_object('timesheet_id', v_ts.id, 'period_start', v_ts.period_start,
    'employee_id', v_ts.user_id, 'employee_name', v_emp.full_name, 'comment_id', v_id,
    'target', v_target, 'project_id', v_project, 'task_id', v_task,
    'manual_entry_id', p_manual_entry_id, 'by', v_me.id, 'by_name', v_me.full_name,
    'excerpt', left(v_body, 140));
  if v_me.id = v_ts.user_id then
    -- The employee wrote: their direct manager and the manager's active delegates.
    for r in
      select u.id from public.users u
      where u.org_id = v_ts.org_id and u.active and u.id <> v_me.id
        and v_emp.manager_id is not null
        and (u.id = v_emp.manager_id or internal.is_active_delegate(v_emp.manager_id, u.id))
    loop
      perform internal.notify(v_ts.org_id, r.id, 'timesheet.commented',
        v_payload || jsonb_build_object('to', 'reviewer'));
    end loop;
  else
    perform internal.notify(v_ts.org_id, v_ts.user_id, 'timesheet.commented',
      v_payload || jsonb_build_object('to', 'employee'));
  end if;
  return v_id;
end;
$$;

revoke all on function public.add_timesheet_comment(uuid, text, uuid, uuid, uuid) from public, anon;
grant execute on function public.add_timesheet_comment(uuid, text, uuid, uuid, uuid) to authenticated;

-- Lock banner ----------------------------------------------------------------------------------

-- Who approved a week, by name, for anyone who can view it (the employee can't read their
-- manager's user row). Null while it isn't approved, when it approved itself on submit
-- (TS-16), and when the approver's row is gone.
create function public.timesheet_approver_name(p_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select u.full_name
  from public.timesheets t
  join public.users u on u.id = t.approver_id
  where t.id = p_id and t.status = 'approved'
    and t.org_id = internal.jwt_org_id() and public.can_view_user(t.user_id);
$$;

revoke all on function public.timesheet_approver_name(uuid) from public, anon;
grant execute on function public.timesheet_approver_name(uuid) to authenticated;

-- Retention and deletion -----------------------------------------------------------------------

-- Deletes each org's expired rows by that org's settings and logs the counts.
-- Returns the totals per category. retention-purge calls it after the files are gone.
--
-- Partitioned tables (agent_events_raw, activity_samples): an org on the longest
-- event retention is left to the partitions job, which drops whole weeks; only orgs
-- on a shorter setting get row deletes here.
create or replace function public.retention_purge_rows()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  o record;
  n bigint;
  v_counts jsonb;
  v_from bigint := coalesce((select max(id) from public.retention_runs), 0);
  v_longest timestamptz := now() - make_interval(
    months => coalesce((select max(internal.event_retention_months(policy)) from public.orgs), 12));
  v_events timestamptz;
  v_timesheets timestamptz;
  v_day date;
begin
  for o in select id, policy from public.orgs loop
    v_events := now() - make_interval(months => internal.event_retention_months(o.policy));
    v_timesheets := now() - make_interval(years => internal.timesheet_retention_years(o.policy));
    v_day := (v_timesheets at time zone 'UTC')::date - 1;
    v_counts := '{}'::jsonb;

    if v_events > v_longest then
      delete from public.agent_events_raw where org_id = o.id and at < v_events;
      get diagnostics n = row_count;
      v_counts := v_counts || jsonb_build_object('agent_events_raw', n);
      delete from public.activity_samples where org_id = o.id and minute < v_events;
      get diagnostics n = row_count;
      v_counts := v_counts || jsonb_build_object('activity_samples', n);
    end if;

    -- A check-in whose files are still in Storage stays until they are gone.
    delete from public.checkin_events
    where org_id = o.id and scheduled_at < v_events
      and (cardinality(object_keys) = 0 or captures_purged_at is not null);
    get diagnostics n = row_count;
    v_counts := v_counts || jsonb_build_object('checkin_events', n);

    -- Closed periods only: an open one is the user's current state.
    delete from public.status_periods
    where org_id = o.id and end_at is not null and end_at < v_events;
    get diagnostics n = row_count;
    v_counts := v_counts || jsonb_build_object('status_periods', n);

    delete from public.agent_event_rejections r
    using public.devices d
    where d.id = r.device_id and d.org_id = o.id and r.received_at < v_events;
    get diagnostics n = row_count;
    v_counts := v_counts || jsonb_build_object('agent_event_rejections', n);

    -- Shift records are what timesheets are built from, so they keep the
    -- timesheet window. Breaks and pauses go first for their own counts.
    delete from public.breaks b
    using public.clock_sessions s
    where s.id = b.clock_session_id and s.org_id = o.id
      and s.end_at is not null and s.end_at < v_timesheets;
    get diagnostics n = row_count;
    v_counts := v_counts || jsonb_build_object('breaks', n);
    delete from public.pauses p
    using public.clock_sessions s
    where s.id = p.clock_session_id and s.org_id = o.id
      and s.end_at is not null and s.end_at < v_timesheets;
    get diagnostics n = row_count;
    v_counts := v_counts || jsonb_build_object('pauses', n);
    delete from public.clock_sessions
    where org_id = o.id and end_at is not null and end_at < v_timesheets;
    get diagnostics n = row_count;
    v_counts := v_counts || jsonb_build_object('clock_sessions', n);

    -- Timesheet window (#130). Whole days and weeks only, and only once they ended
    -- everywhere before the cutoff: v_day is the UTC date of the cutoff less one day,
    -- so a local day (UTC-12 to UTC+14) or a week of them is over by then. Children
    -- before parents. A draft or submitted week that old goes too: nobody can still
    -- approve three years on, and the window is the promise made to the org.
    delete from public.dirty_days d
    using public.users u
    where u.id = d.user_id and u.org_id = o.id and d.day < v_day;
    get diagnostics n = row_count;
    v_counts := v_counts || jsonb_build_object('dirty_days', n);

    delete from public.time_segments where org_id = o.id and day < v_day;
    get diagnostics n = row_count;
    v_counts := v_counts || jsonb_build_object('time_segments', n);

    -- Reminder bookkeeping of a week (kept by its week, like the sheet it was about).
    delete from public.reminders_sent where org_id = o.id and period_start + 6 < v_day;
    get diagnostics n = row_count;
    v_counts := v_counts || jsonb_build_object('reminders_sent', n);

    -- #265: a week's comments go with it.
    delete from public.timesheet_comments c
    using public.timesheets t
    where t.id = c.timesheet_id and c.org_id = o.id and t.period_start + 6 < v_day;
    get diagnostics n = row_count;
    v_counts := v_counts || jsonb_build_object('timesheet_comments', n);
    delete from public.timesheet_edits e
    using public.timesheets t
    where t.id = e.timesheet_id and e.org_id = o.id and t.period_start + 6 < v_day;
    get diagnostics n = row_count;
    v_counts := v_counts || jsonb_build_object('timesheet_edits', n);
    delete from public.timesheets where org_id = o.id and period_start + 6 < v_day;
    get diagnostics n = row_count;
    v_counts := v_counts || jsonb_build_object('timesheets', n);

    -- By end time, whatever the status: a pending request is as old as the others.
    delete from public.manual_entries where org_id = o.id and end_at < v_timesheets;
    get diagnostics n = row_count;
    v_counts := v_counts || jsonb_build_object('manual_entries', n);

    -- In-app notifications are transient, so they follow the events window, not
    -- the timesheet one.
    delete from public.notifications where org_id = o.id and created_at < v_events;
    get diagnostics n = row_count;
    v_counts := v_counts || jsonb_build_object('notifications', n);

    -- Messages (#185), on the events window like notifications. Alerts first: they
    -- point at their email (on delete set null), and an alert is always older than
    -- its email, so none outlives the email it went out in.
    delete from public.alerts where org_id = o.id and triggered_at < v_events;
    get diagnostics n = row_count;
    v_counts := v_counts || jsonb_build_object('alerts', n);

    -- Only mail that is done: sent, or given up on (5 attempts, see email_claim). A
    -- row still waiting to go out stays however old, so nothing undelivered is lost.
    delete from public.email_outbox
    where org_id = o.id and created_at < v_events
      and (sent_at is not null or attempts >= 5);
    get diagnostics n = row_count;
    v_counts := v_counts || jsonb_build_object('email_outbox', n);

    -- The rebuild log (when each employee-day was last rebuilt) only matters while a
    -- day can still be rebuilt, which needs its raw events: the events window. The
    -- kick only looks at days of an open shift, so a purged entry is never read.
    delete from internal.segment_rebuilds r
    using public.users u
    where u.id = r.user_id and u.org_id = o.id and r.rebuilt_at < v_events;
    get diagnostics n = row_count;
    v_counts := v_counts || jsonb_build_object('segment_rebuilds', n);

    perform internal.log_retention(o.id, v_counts);
  end loop;

  return coalesce((
    select jsonb_object_agg(category, total)
    from (
      select category, sum(deleted)::bigint as total
      from public.retention_runs where id > v_from and org_id is not null
      group by category
    ) t
  ), '{}'::jsonb);
end;
$$;

-- Removes every row about one person, then the person (the users row and the Auth
-- account, so they cannot sign in), and writes the tombstone. One transaction: it all
-- happens or none of it. Children before parents, partitions through their parent
-- table. The users row is deleted last, so any table added later with an
-- ON DELETE CASCADE foreign key to it is still emptied (the pgTAP test fails if one
-- is missed, so it can be added here and counted). Rows of other people that merely
-- point at this person (the approver of a timesheet, who decided a manual entry, who
-- excluded a segment, someone's manager when they are inactive) are set to null.
-- Refuses while capture files remain in Storage: the images go first, so a failure
-- never leaves files with no row to say whose they are.
-- Returns the number of rows removed per table.
create or replace function internal.delete_user_data(p_actor_id uuid, p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user public.users;
  v_counts jsonb := '{}'::jsonb;
  v_n bigint;
begin
  select * into v_user from public.users u where u.id = p_user_id for update;
  if not found then
    raise exception 'user_not_found' using errcode = '42501';
  end if;
  if exists (
    select 1 from storage.objects o
    where o.bucket_id = 'captures'
      and starts_with(o.name, v_user.org_id::text || '/' || v_user.id::text || '/')
  ) then
    raise exception 'captures_remain' using errcode = '55000';
  end if;

  -- Raw agent data and what was computed from it.
  delete from public.agent_events_raw where user_id = p_user_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('agent_events', v_n);
  delete from public.activity_samples where user_id = p_user_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('activity_samples', v_n);
  delete from public.agent_event_rejections
  where device_id in (select d.id from public.devices d where d.user_id = p_user_id);
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('agent_event_rejections', v_n);
  delete from public.checkin_events where user_id = p_user_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('checkin_events', v_n);
  delete from public.status_periods where user_id = p_user_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('status_periods', v_n);
  delete from public.time_segments where user_id = p_user_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('time_segments', v_n);
  delete from internal.segment_rebuilds where user_id = p_user_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('segment_rebuilds', v_n);
  delete from public.anticheat_flags where user_id = p_user_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('anticheat_flags', v_n);

  -- Clock sessions and what hangs off them.
  delete from public.pauses where user_id = p_user_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('pauses', v_n);
  delete from public.breaks where user_id = p_user_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('breaks', v_n);
  delete from public.clock_sessions where user_id = p_user_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('clock_sessions', v_n);

  -- Timesheets and the edits and entries on them.
  delete from public.timesheet_comments where user_id = p_user_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('timesheet_comments', v_n);
  delete from public.timesheet_edits where user_id = p_user_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('timesheet_edits', v_n);
  delete from public.manual_entries where user_id = p_user_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('manual_entries', v_n);
  delete from public.timesheets where user_id = p_user_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('timesheets', v_n);

  -- Messages: about them or to them, and the emails behind the alerts and reminders.
  delete from public.alerts where user_id = p_user_id or recipient_id = p_user_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('alerts', v_n);
  delete from public.reminders_sent where user_id = p_user_id or recipient_id = p_user_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('reminders_sent', v_n);
  delete from public.notifications where user_id = p_user_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('notifications', v_n);
  delete from public.email_outbox
  where org_id = v_user.org_id
    and (lower(to_email) = lower(v_user.email) or payload ->> 'employee_id' = p_user_id::text);
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('email_outbox', v_n);

  -- Their own settings and acknowledgements, and delegations in either direction (a
  -- delegation to or from them ends with them).
  delete from public.notice_acks where user_id = p_user_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('notice_acks', v_n);
  delete from public.project_members where user_id = p_user_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('project_members', v_n);
  delete from public.shifts where user_id = p_user_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('shifts', v_n);
  delete from public.delegations where manager_id = p_user_id or delegate_id = p_user_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('delegations', v_n);
  delete from public.presence where user_id = p_user_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('presence', v_n);
  delete from public.last_seen where user_id = p_user_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('last_seen', v_n);

  -- Devices and sign-in sessions (ending the sessions revokes the refresh tokens).
  perform internal.end_sessions(array(select s.id from auth.sessions s where s.user_id = p_user_id));
  delete from public.device_sessions where user_id = p_user_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('device_sessions', v_n);
  delete from public.devices where user_id = p_user_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('devices', v_n);

  -- Last of the data: the dirty-day marks the deletes above may have left.
  delete from public.dirty_days where user_id = p_user_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('dirty_days', v_n);

  -- The tombstone (AUD-01), written while the names can still be snapshotted. No email.
  perform internal.audit(v_user.org_id, p_actor_id, 'user_data.deleted', v_user.id,
    jsonb_build_object('role', v_user.role, 'counts', v_counts));

  -- The person: the users row (anything with a cascading key to it goes too), then the
  -- Auth account, which frees the email address and ends sign-in for good.
  delete from public.users where id = v_user.id;
  delete from auth.users where id = v_user.id;
  return v_counts;
end;
$$;
