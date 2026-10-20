-- #43: weekly timesheets (TS-02, TS-10..13, TS-16, TS-18, DSH-06).
--
-- One timesheet per employee and week (a row per user and week-start date, created
-- lazily as a draft). Lifecycle: draft -> submitted (employee) -> approved (locked) or
-- returned (with a comment; the employee edits and submits again). Only the direct
-- manager or their active delegate approves, returns, reopens and edits (TS-12);
-- owners and admins only view. A person whose approval_required is off is approved on
-- submit (TS-16).
--
-- A week is seven employee-local days (the same days time_segments uses), starting on
-- the org's policy.week_start (monday..sunday, default monday). Rows keep the start
-- date they were created with, so changing the setting never moves an existing week.
--
-- Locking: a day is locked when its week is approved. Rebuilds and manual entries
-- leave a locked day alone; reopening or returning a week marks its days dirty again.
--
-- Manager edits live in timesheet_edits (append-only) and are applied on every
-- rebuild, so they survive it: 'project' edits go into buildSegments() as
-- DayInput.projectEdits, exclusions are re-applied to the rebuilt rows. Flagged time is
-- only ever excluded by an explicit, reasoned edit (TS-02). 'keep' is a review
-- decision, not an edit: it is hidden from the employee. 'include' undoes an exclusion
-- (with a reason). 'adjust' adds or changes manual time on the employee's behalf.

-- Tables ----------------------------------------------------------------------------

create table public.timesheets (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  user_id uuid not null references public.users (id) on delete cascade,
  -- The first employee-local day of the week; the week covers period_start..+6.
  period_start date not null,
  status text not null default 'draft'
    check (status in ('draft', 'submitted', 'approved', 'returned')),
  submitted_at timestamptz,
  -- Who approved (null while not approved, and for an auto-approved week).
  approver_id uuid references public.users (id) on delete set null,
  approved_at timestamptz,
  returned_at timestamptz,
  -- The manager's latest return comment; shown while the week is returned.
  comment text check (length(comment) <= 500),
  created_at timestamptz not null default now(),
  constraint timesheets_user_week_key unique (user_id, period_start)
);

create index timesheets_org_week_idx on public.timesheets (org_id, period_start, status);
alter table public.timesheets enable row level security;

-- Same rule as the other per-employee tables. Writes only through the functions below.
create policy "Visible per can_view_user"
on public.timesheets for select to authenticated
using (org_id = (select internal.jwt_org_id()) and public.can_view_user(user_id));

revoke insert, update, delete on public.timesheets from anon, authenticated;

create table public.timesheet_edits (
  id uuid primary key default gen_random_uuid(),
  -- Orders edits: the latest of overlapping edits wins.
  seq bigint generated always as identity,
  org_id uuid not null references public.orgs (id) on delete cascade,
  timesheet_id uuid not null references public.timesheets (id) on delete cascade,
  -- The employee the edit is about (for access checks and segment lookups).
  user_id uuid not null references public.users (id) on delete cascade,
  editor_id uuid references public.users (id) on delete set null,
  kind text not null check (kind in ('keep', 'exclude', 'include', 'project', 'adjust')),
  start_at timestamptz not null,
  end_at timestamptz not null,
  -- kind = 'project': the new project (null is Unassigned). kind = 'adjust': the
  -- project of the added or changed time.
  project_id uuid references public.projects (id) on delete set null,
  -- Required for everything but 'keep' (TS-13).
  reason text check (length(reason) between 1 and 500),
  -- 'adjust': { entry_id, before } (before is null for added time).
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint timesheet_edits_end_after_start check (end_at > start_at),
  constraint timesheet_edits_reason check (kind = 'keep' or reason is not null)
);

create index timesheet_edits_timesheet_idx on public.timesheet_edits (timesheet_id, seq);
create index timesheet_edits_user_start_idx on public.timesheet_edits (user_id, start_at);
alter table public.timesheet_edits enable row level security;

-- Visible to the employee, their manager and delegate, and owners/admins, except that
-- 'keep' (a review decision, not an edit) is not shown to the employee.
create policy "Visible per can_view_user, keep decisions not to the employee"
on public.timesheet_edits for select to authenticated
using (
  org_id = (select internal.jwt_org_id())
  and public.can_view_user(user_id)
  and (kind <> 'keep' or user_id <> (select auth.uid()))
);

revoke insert, update, delete on public.timesheet_edits from anon, authenticated;

create function internal.timesheet_edits_are_append_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'timesheet_edits_are_append_only' using errcode = '42501';
end;
$$;

create trigger timesheet_edits_no_update
before update on public.timesheet_edits
for each row execute function internal.timesheet_edits_are_append_only();

-- In-app notifications; emails come with the Resend pipeline (#46, #50).
create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  user_id uuid not null references public.users (id) on delete cascade,
  -- e.g. timesheet.returned
  kind text not null check (kind ~ '^[a-z_]+\.[a-z_]+$'),
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  read_at timestamptz
);

create index notifications_user_idx on public.notifications (user_id, created_at desc);
alter table public.notifications enable row level security;

create policy "Own notifications"
on public.notifications for select to authenticated
using (org_id = (select internal.jwt_org_id()) and user_id = (select auth.uid()));

revoke insert, update, delete on public.notifications from anon, authenticated;

-- Helpers ---------------------------------------------------------------------------

-- The first day of the week containing p_day, for the org's policy.week_start
-- (monday..sunday; anything else, or nothing, is monday).
create function internal.week_start(p_org_id uuid, p_day date)
returns date
language sql
stable
security definer
set search_path = ''
as $$
  select p_day - ((extract(isodow from p_day)::int - w.n + 7) % 7)
  from (
    select coalesce(array_position(
      array['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'],
      lower(o.policy ->> 'week_start')), 1) as n
    from public.orgs o
    where o.id = p_org_id
  ) w;
$$;

-- True when the day sits in an approved week (TS-18). Replaces #41's stub. Submitted
-- weeks are not locked: they still rebuild and take manager edits.
create or replace function internal.day_locked(p_user_id uuid, p_day date)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.timesheets t
    where t.user_id = p_user_id and t.status = 'approved'
      and p_day >= t.period_start and p_day < t.period_start + 7
  );
$$;

-- Marks every day of the week for rebuilding (up to now: later days have no segments).
create function internal.mark_week_dirty(p_user_id uuid, p_period_start date)
returns void
language sql
security definer
set search_path = ''
as $$
  select internal.mark_dirty(p_user_id, internal.local_day_start(p_user_id, p_period_start),
    least(internal.local_day_start(p_user_id, p_period_start + 7), now()));
$$;

-- The review decision on a flagged span: 'keep' or 'exclude' from the latest edit that
-- overlaps it ('include' is a keep that undid an exclusion); null while undecided.
create function internal.segment_decision(p_user_id uuid, p_start timestamptz, p_end timestamptz)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case e.kind when 'exclude' then 'exclude' else 'keep' end
  from public.timesheet_edits e
  where e.user_id = p_user_id and e.kind in ('keep', 'exclude', 'include')
    and e.start_at < p_end and e.end_at > p_start
  order by e.seq desc
  limit 1;
$$;

-- Applies the exclusion decisions to the stored segments overlapping [p_from, p_to).
-- Only flagged segments are ever excluded (TS-02). Run after a decision and after
-- every rebuild, which re-inserts the rows unexcluded.
create function internal.apply_decisions(p_user_id uuid, p_from timestamptz, p_to timestamptz)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.time_segments t
  set excluded = coalesce(d.kind = 'exclude', false) and t.flagged,
      excluded_reason = case when coalesce(d.kind = 'exclude', false) and t.flagged then d.reason end,
      excluded_by = case when coalesce(d.kind = 'exclude', false) and t.flagged then d.editor_id end
  from public.time_segments s
  left join lateral (
    select e.kind, e.reason, e.editor_id
    from public.timesheet_edits e
    where e.user_id = s.user_id and e.kind in ('keep', 'exclude', 'include')
      and e.start_at < s.end_at and e.end_at > s.start_at
    order by e.seq desc
    limit 1
  ) d on true
  where s.id = t.id and t.user_id = p_user_id and t.start_at < p_to and t.end_at > p_from;
$$;

create function internal.notify(p_org_id uuid, p_user_id uuid, p_kind text, p_payload jsonb)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.notifications (org_id, user_id, kind, payload)
  values (p_org_id, p_user_id, p_kind, coalesce(p_payload, '{}'::jsonb));
$$;

-- Loads and locks a timesheet the caller may view (else timesheet_not_found).
create function internal.load_timesheet(p_id uuid, p_me public.users)
returns public.timesheets
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ts public.timesheets;
begin
  select * into v_ts from public.timesheets where id = p_id for update;
  if not found or v_ts.org_id <> p_me.org_id or not public.can_view_user(v_ts.user_id) then
    raise exception 'timesheet_not_found' using errcode = '42501';
  end if;
  return v_ts;
end;
$$;

-- Loads a timesheet the caller decides on: the employee's direct manager or active
-- delegate (TS-12; the same rule as manual entries). Owners and admins who are not
-- the manager only view.
create function internal.decidable_timesheet(p_id uuid, p_me public.users)
returns public.timesheets
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ts public.timesheets := internal.load_timesheet(p_id, p_me);
begin
  if not internal.is_entry_decider(p_me, v_ts.user_id) then
    raise exception 'not_the_manager' using errcode = '42501';
  end if;
  return v_ts;
end;
$$;

revoke all on function internal.timesheet_edits_are_append_only() from public, anon, authenticated;
revoke all on function internal.week_start(uuid, date) from public, anon, authenticated;
revoke all on function internal.mark_week_dirty(uuid, date) from public, anon, authenticated;
revoke all on function internal.segment_decision(uuid, timestamptz, timestamptz) from public, anon, authenticated;
revoke all on function internal.apply_decisions(uuid, timestamptz, timestamptz) from public, anon, authenticated;
revoke all on function internal.notify(uuid, uuid, text, jsonb) from public, anon, authenticated;
revoke all on function internal.load_timesheet(uuid, public.users) from public, anon, authenticated;
revoke all on function internal.decidable_timesheet(uuid, public.users) from public, anon, authenticated;

-- Reading helpers --------------------------------------------------------------------

-- True when the caller is the employee's direct manager or active delegate: what the
-- dashboard asks before showing approve, return, reopen and edit controls.
create function public.can_decide_timesheet(target uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select auth.uid() is not null and public.can_view_user(target)
    and internal.is_entry_decider((select u from public.users u where u.id = auth.uid()), target);
$$;

-- A week's segment seconds by day, type, project and state (TS-05/06: raw seconds,
-- rounded only for display). Runs as the caller, so row-level security limits it to
-- the people they may view.
create function public.timesheet_breakdown(p_user_id uuid, p_from date, p_to date)
returns table (
  day date,
  type text,
  project_id uuid,
  counted boolean,
  flagged boolean,
  excluded boolean,
  seconds bigint
)
language sql
stable
set search_path = ''
as $$
  select t.day, t.type, t.project_id, t.counted, t.flagged, t.excluded,
         round(sum(extract(epoch from t.end_at - t.start_at)))::bigint
  from public.time_segments t
  where t.user_id = p_user_id and t.day between p_from and p_to
  group by t.day, t.type, t.project_id, t.counted, t.flagged, t.excluded
  order by t.day;
$$;

-- Worked (counted, not excluded), flagged (still counted) and excluded seconds per
-- person for the days in [p_from, p_to], for the Timesheets list.
create function public.timesheet_totals(p_from date, p_to date)
returns table (user_id uuid, worked_s bigint, flagged_s bigint, excluded_s bigint)
language sql
stable
set search_path = ''
as $$
  select t.user_id,
    coalesce(round(sum(extract(epoch from t.end_at - t.start_at))
      filter (where t.counted and not t.excluded)), 0)::bigint,
    coalesce(round(sum(extract(epoch from t.end_at - t.start_at))
      filter (where t.flagged and not t.excluded)), 0)::bigint,
    coalesce(round(sum(extract(epoch from t.end_at - t.start_at))
      filter (where t.excluded)), 0)::bigint
  from public.time_segments t
  where t.day between p_from and p_to
  group by t.user_id;
$$;

-- The flagged segments of a span of days with the review decision on each ('keep',
-- 'exclude' or null while undecided). The employee gets no decision: 'keep' is not
-- shown to them (their exclusions show through excluded and the edit list).
create function public.timesheet_flagged_segments(p_user_id uuid, p_from date, p_to date)
returns table (
  id uuid,
  day date,
  type text,
  start_at timestamptz,
  end_at timestamptz,
  project_id uuid,
  excluded boolean,
  excluded_reason text,
  decision text
)
language sql
stable
security definer
set search_path = ''
as $$
  select t.id, t.day, t.type, t.start_at, t.end_at, t.project_id, t.excluded, t.excluded_reason,
         case when auth.uid() = p_user_id then null
              else internal.segment_decision(t.user_id, t.start_at, t.end_at) end
  from public.time_segments t
  where public.can_view_user(p_user_id) and t.user_id = p_user_id and t.flagged
    and t.day between p_from and p_to
  order by t.start_at;
$$;

revoke all on function public.can_decide_timesheet(uuid) from public, anon;
revoke all on function public.timesheet_breakdown(uuid, date, date) from public, anon;
revoke all on function public.timesheet_totals(date, date) from public, anon;
revoke all on function public.timesheet_flagged_segments(uuid, date, date) from public, anon;
grant execute on function public.can_decide_timesheet(uuid) to authenticated;
grant execute on function public.timesheet_breakdown(uuid, date, date) to authenticated;
grant execute on function public.timesheet_totals(date, date) to authenticated;
grant execute on function public.timesheet_flagged_segments(uuid, date, date) to authenticated;

-- Lifecycle -------------------------------------------------------------------------

-- The timesheet of a person's week, created as a draft on first need. p_period_start
-- must be a week start under the org's policy and not overlap another week.
create function public.ensure_timesheet(p_user_id uuid, p_period_start date)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me public.users := internal.current_app_user();
  v_emp public.users;
  v_id uuid;
begin
  if p_period_start is null then
    raise exception 'invalid_week' using errcode = '22023';
  end if;
  select * into v_emp from public.users u where u.id = p_user_id;
  if not found or v_emp.org_id <> v_me.org_id or not public.can_view_user(p_user_id) then
    raise exception 'user_not_found' using errcode = '42501';
  end if;

  select t.id into v_id from public.timesheets t
  where t.user_id = p_user_id and t.period_start = p_period_start;
  if found then
    return v_id;
  end if;
  if internal.week_start(v_emp.org_id, p_period_start) <> p_period_start
    or exists (
      select 1 from public.timesheets t
      where t.user_id = p_user_id and t.period_start > p_period_start - 7
        and t.period_start < p_period_start + 7
    )
  then
    raise exception 'invalid_week' using errcode = '22023';
  end if;

  insert into public.timesheets (org_id, user_id, period_start)
  values (v_emp.org_id, p_user_id, p_period_start)
  on conflict (user_id, period_start) do nothing
  returning id into v_id;
  if v_id is null then
    select t.id into v_id from public.timesheets t
    where t.user_id = p_user_id and t.period_start = p_period_start;
  end if;
  return v_id;
end;
$$;

-- TS-11: the employee submits their own draft or returned week. Returns the new
-- status: 'submitted', or 'approved' for a person whose approval is not required
-- and for the owner at the top of the org (TS-16). Anyone else needs a direct
-- manager (ORG acceptance criteria). The dashboard rebuilds the week's
-- segments first so the manager reviews fresh numbers.
create function public.submit_timesheet(p_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me public.users := internal.current_app_user();
  v_ts public.timesheets := internal.load_timesheet(p_id, v_me);
  v_auto boolean := not v_me.approval_required or (v_me.role = 'owner' and v_me.manager_id is null);
begin
  if v_ts.user_id <> v_me.id then
    raise exception 'not_your_timesheet' using errcode = '42501';
  end if;
  if v_ts.status not in ('draft', 'returned') then
    raise exception 'not_submittable' using errcode = '55000';
  end if;
  if v_ts.period_start > (now() at time zone v_me.timezone)::date then
    raise exception 'week_in_future' using errcode = '22023';
  end if;
  if not v_auto and v_me.manager_id is null then
    raise exception 'no_manager' using errcode = '55000';
  end if;

  update public.timesheets
  set status = case when v_auto then 'approved' else 'submitted' end,
      submitted_at = now(),
      approved_at = case when v_auto then now() end,
      approver_id = null
  where id = v_ts.id;

  perform internal.audit(v_ts.org_id, v_me.id, 'timesheet.submitted', v_me.id,
    jsonb_build_object('timesheet_id', v_ts.id, 'period_start', v_ts.period_start));
  if v_auto then
    perform internal.audit(v_ts.org_id, v_me.id, 'timesheet.auto_approved', v_me.id,
      jsonb_build_object('timesheet_id', v_ts.id, 'period_start', v_ts.period_start));
    return 'approved';
  end if;
  return 'submitted';
end;
$$;

-- TS-11/12: the manager (or delegate) approves a submitted week, which locks it. Every
-- manual entry in the week must be decided, and every flagged segment must carry a
-- decision (keep or exclude).
create function public.approve_timesheet(p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me public.users := internal.current_app_user();
  v_ts public.timesheets := internal.decidable_timesheet(p_id, v_me);
  v_from timestamptz := internal.local_day_start(v_ts.user_id, v_ts.period_start);
  v_to timestamptz := internal.local_day_start(v_ts.user_id, v_ts.period_start + 7);
begin
  if v_ts.status <> 'submitted' then
    raise exception 'not_submitted' using errcode = '55000';
  end if;
  if exists (
    select 1 from public.manual_entries me
    where me.user_id = v_ts.user_id and me.status = 'pending'
      and me.start_at < v_to and me.end_at > v_from
  ) then
    raise exception 'pending_entries' using errcode = '55000';
  end if;
  if exists (
    select 1 from public.time_segments t
    where t.user_id = v_ts.user_id and t.flagged
      and t.day >= v_ts.period_start and t.day < v_ts.period_start + 7
      and internal.segment_decision(t.user_id, t.start_at, t.end_at) is null
  ) then
    raise exception 'undecided_flagged' using errcode = '55000';
  end if;

  update public.timesheets
  set status = 'approved', approver_id = v_me.id, approved_at = now()
  where id = v_ts.id;

  perform internal.audit(v_ts.org_id, v_me.id, 'timesheet.approved', v_ts.user_id,
    jsonb_build_object('timesheet_id', v_ts.id, 'period_start', v_ts.period_start));
end;
$$;

-- TS-11: the manager (or delegate) sends a submitted week back with a comment. It
-- behaves as a draft for the employee, who sees the comment.
create function public.return_timesheet(p_id uuid, p_comment text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me public.users := internal.current_app_user();
  v_ts public.timesheets := internal.decidable_timesheet(p_id, v_me);
  v_comment text := trim(coalesce(p_comment, ''));
begin
  if length(v_comment) not between 1 and 500 then
    raise exception 'invalid_comment' using errcode = '22023';
  end if;
  if v_ts.status <> 'submitted' then
    raise exception 'not_submitted' using errcode = '55000';
  end if;

  update public.timesheets
  set status = 'returned', returned_at = now(), comment = v_comment
  where id = v_ts.id;
  -- The week was open to edits as submitted; make sure it is rebuilt before the
  -- employee looks again.
  perform internal.mark_week_dirty(v_ts.user_id, v_ts.period_start);

  perform internal.audit(v_ts.org_id, v_me.id, 'timesheet.returned', v_ts.user_id,
    jsonb_build_object('timesheet_id', v_ts.id, 'period_start', v_ts.period_start,
      'comment', v_comment));
  perform internal.notify(v_ts.org_id, v_ts.user_id, 'timesheet.returned',
    jsonb_build_object('timesheet_id', v_ts.id, 'period_start', v_ts.period_start,
      'comment', v_comment, 'by', v_me.id));
end;
$$;

-- TS-18: the manager (or delegate) reopens an approved week, back to submitted, with a
-- reason. Audit-logged; the employee is notified. Its days are rebuilt again (a
-- locked day's dirty marks were dropped).
create function public.reopen_timesheet(p_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me public.users := internal.current_app_user();
  v_ts public.timesheets := internal.decidable_timesheet(p_id, v_me);
  v_reason text := trim(coalesce(p_reason, ''));
begin
  if length(v_reason) not between 1 and 500 then
    raise exception 'invalid_reason' using errcode = '22023';
  end if;
  if v_ts.status <> 'approved' then
    raise exception 'not_approved' using errcode = '55000';
  end if;

  update public.timesheets
  set status = 'submitted', approver_id = null, approved_at = null
  where id = v_ts.id;
  perform internal.mark_week_dirty(v_ts.user_id, v_ts.period_start);

  perform internal.audit(v_ts.org_id, v_me.id, 'timesheet.reopened', v_ts.user_id,
    jsonb_build_object('timesheet_id', v_ts.id, 'period_start', v_ts.period_start,
      'reason', v_reason, 'approved_by', v_ts.approver_id));
  perform internal.notify(v_ts.org_id, v_ts.user_id, 'timesheet.reopened',
    jsonb_build_object('timesheet_id', v_ts.id, 'period_start', v_ts.period_start,
      'reason', v_reason, 'by', v_me.id));
end;
$$;

-- Manager edits ----------------------------------------------------------------------

-- TS-02/13: a decision or edit by the manager (or delegate) on a span of the week, while
-- the week isn't approved.
--   keep     review decision on flagged time; reason optional; not an edit (hidden from
--            the employee, not audit-logged).
--   exclude  takes flagged time out of the worked total; reason required.
--   include  undoes an exclusion; reason required.
--   project  moves the span to another project (null: Unassigned); reason required.
--            Applied by the next rebuild (the days are marked dirty).
-- Everything but 'keep' is audit-logged and notifies the employee. Returns the edit id.
create function public.edit_segment(
  p_timesheet_id uuid,
  p_kind text,
  p_start_at timestamptz,
  p_end_at timestamptz,
  p_project_id uuid default null,
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
    end_at, project_id, reason)
  values (v_ts.org_id, v_ts.id, v_ts.user_id, v_me.id, p_kind, p_start_at, p_end_at,
    case when p_kind = 'project' then p_project_id end, v_reason)
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
        'reason', v_reason));
    perform internal.notify(v_ts.org_id, v_ts.user_id, 'timesheet.edited',
      jsonb_build_object('timesheet_id', v_ts.id, 'period_start', v_ts.period_start,
        'edit_id', v_id, 'kind', p_kind, 'reason', v_reason, 'by', v_me.id));
  end if;
  return v_id;
end;
$$;

-- TS-13: the manager (or delegate) adds time to the week on the employee's behalf
-- (p_entry_id null) or changes the times and project of one of their manual entries.
-- Both go through manual_entries so rebuilds count them like any approved entry, and
-- they can't overlap clocked time or another entry (TS-09). Reason required; an
-- 'adjust' edit is logged, audit-logged and shown to the employee. Returns the
-- entry id.
create function public.adjust_time(
  p_timesheet_id uuid,
  p_start_at timestamptz,
  p_end_at timestamptz,
  p_project_id uuid,
  p_reason text,
  p_entry_id uuid default null
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

  perform pg_advisory_xact_lock(hashtext('manual_entry:' || v_ts.user_id::text));
  v_overlap := internal.manual_entry_overlap(v_ts.user_id, p_start_at, p_end_at, p_entry_id);
  if v_overlap is not null then
    raise exception '%', v_overlap using errcode = '23P01';
  end if;

  if p_entry_id is null then
    insert into public.manual_entries (org_id, user_id, start_at, end_at, project_id, reason,
      status, decided_by, decided_at, decision_note)
    values (v_ts.org_id, v_ts.user_id, p_start_at, p_end_at, p_project_id, v_reason,
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
      'project_id', v_entry.project_id);
    update public.manual_entries
    set start_at = p_start_at, end_at = p_end_at, project_id = p_project_id
    where id = v_entry.id;
  end if;

  insert into public.timesheet_edits (org_id, timesheet_id, user_id, editor_id, kind, start_at,
    end_at, project_id, reason, detail)
  values (v_ts.org_id, v_ts.id, v_ts.user_id, v_me.id, 'adjust', p_start_at, p_end_at,
    p_project_id, v_reason, jsonb_build_object('entry_id', v_entry_id, 'before', v_before))
  returning id into v_edit;

  perform internal.audit(v_ts.org_id, v_me.id, 'timesheet.edited', v_ts.user_id,
    jsonb_build_object('timesheet_id', v_ts.id, 'edit_id', v_edit, 'kind', 'adjust',
      'entry_id', v_entry_id, 'start_at', p_start_at, 'end_at', p_end_at,
      'project_id', p_project_id, 'before', v_before, 'reason', v_reason));
  perform internal.notify(v_ts.org_id, v_ts.user_id, 'timesheet.edited',
    jsonb_build_object('timesheet_id', v_ts.id, 'period_start', v_ts.period_start,
      'edit_id', v_edit, 'kind', 'adjust', 'reason', v_reason, 'by', v_me.id));
  return v_entry_id;
end;
$$;

-- Marks the caller's unread notifications as read; returns how many.
create function public.mark_notifications_read()
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me public.users := internal.current_app_user();
  v_n int;
begin
  update public.notifications set read_at = now() where user_id = v_me.id and read_at is null;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

revoke all on function public.ensure_timesheet(uuid, date) from public, anon;
revoke all on function public.submit_timesheet(uuid) from public, anon;
revoke all on function public.approve_timesheet(uuid) from public, anon;
revoke all on function public.return_timesheet(uuid, text) from public, anon;
revoke all on function public.reopen_timesheet(uuid, text) from public, anon;
revoke all on function public.edit_segment(uuid, text, timestamptz, timestamptz, uuid, text) from public, anon;
revoke all on function public.adjust_time(uuid, timestamptz, timestamptz, uuid, text, uuid) from public, anon;
revoke all on function public.mark_notifications_read() from public, anon;
grant execute on function public.ensure_timesheet(uuid, date) to authenticated;
grant execute on function public.submit_timesheet(uuid) to authenticated;
grant execute on function public.approve_timesheet(uuid) to authenticated;
grant execute on function public.return_timesheet(uuid, text) to authenticated;
grant execute on function public.reopen_timesheet(uuid, text) to authenticated;
grant execute on function public.edit_segment(uuid, text, timestamptz, timestamptz, uuid, text) to authenticated;
grant execute on function public.adjust_time(uuid, timestamptz, timestamptz, uuid, text, uuid) to authenticated;
grant execute on function public.mark_notifications_read() to authenticated;

-- Rebuild: segment inputs and replace (replaces #42's and #41's versions) --------------

-- Everything buildSegments() needs for one employee-day, as DayInput (camelCase,
-- whole Unix seconds), wrapped as { input, loaded_at }. loaded_at is the instant the
-- facts were read: replace_day_segments only clears the dirty mark if nothing
-- re-marked the day after it.
--
-- Facts from before the day that still matter come along: sessions, breaks, pauses
-- and status periods that overlap the day, and the check-ins and project switches
-- since the earliest of those sessions began (an unverified stretch or a project
-- carries over midnight; the previous shift's don't).
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
      -- Manager project edits (TS-13), oldest first so a later one wins. Applied last.
      'projectEdits', coalesce((
        select jsonb_agg(jsonb_build_object(
          'start', floor(extract(epoch from e.start_at))::bigint,
          'end', floor(extract(epoch from e.end_at))::bigint,
          'projectId', e.project_id) order by e.seq)
        from public.timesheet_edits e
        where e.user_id = p_user_id and e.kind = 'project'
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

-- Replaces the day's auto segments with `p_segments` (an array of
-- { start, end (Unix seconds), type, project_id, counted, flagged }) and clears the
-- day's dirty mark, in one transaction under an advisory lock on (user, day). A
-- locked day (approved week) is left alone and returns null (its mark is dropped too:
-- reopening or returning the week marks it again). Otherwise re-applies the manager's
-- exclusions to the new rows and returns how many segments were written.
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
    org_id, user_id, day, start_at, end_at, type, project_id, counted, flagged, source
  )
  select v_org, p_user_id, p_day, to_timestamp(s.start), to_timestamp(s."end"), s.type,
         s.project_id, s.counted, s.flagged, 'auto'
  from jsonb_to_recordset(p_segments) as s(
    start bigint, "end" bigint, type text, project_id uuid, counted boolean, flagged boolean
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

  delete from public.dirty_days d
  where d.user_id = p_user_id and d.day = p_day and d.marked_at <= p_loaded_at;
  return v_n;
end;
$$;
