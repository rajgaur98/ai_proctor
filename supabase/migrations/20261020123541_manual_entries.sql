-- #42: manual time entries with manager approval (TS-07..09).
--
-- An employee asks for time that wasn't captured (offline work, a client visit).
-- The entry stays pending, shown but not counted, until the direct manager (or their
-- active delegate, LLD section 05) approves or rejects it. Approved entries reach
-- buildSegments() through segment_inputs as 'manual' segments. Entries never overlap
-- clocked time or each other: request_manual_entry and decide_manual_entry both
-- check. Every request, decision and cancellation is written to audit_log (AUD-01).

create table public.manual_entries (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  user_id uuid not null references public.users (id) on delete cascade,
  start_at timestamptz not null,
  end_at timestamptz not null,
  -- Null is Unassigned (TS-04).
  project_id uuid references public.projects (id) on delete set null,
  reason text not null check (length(reason) between 1 and 500),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  decided_by uuid references public.users (id) on delete set null,
  decided_at timestamptz,
  decision_note text check (length(decision_note) <= 500),
  created_at timestamptz not null default now(),
  constraint manual_entries_end_after_start check (end_at > start_at),
  constraint manual_entries_decided check ((status = 'pending') = (decided_at is null))
);

create index manual_entries_user_start_idx on public.manual_entries (user_id, start_at);
alter table public.manual_entries enable row level security;

-- Same rule as the other per-employee tables: the person, their manager and delegate,
-- and owners/admins (view only). Writes only through the functions below.
create policy "Visible per can_view_user"
on public.manual_entries for select to authenticated
using (org_id = (select internal.jwt_org_id()) and public.can_view_user(user_id));

revoke insert, update, delete on public.manual_entries from anon, authenticated;

-- Helpers ---------------------------------------------------------------------------

-- True when any employee-local day touched by [p_from, p_to) is locked (TS-11).
create function internal.range_locked(p_user_id uuid, p_from timestamptz, p_to timestamptz)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.users u,
      generate_series((p_from at time zone u.timezone)::date,
        ((p_to - interval '1 microsecond') at time zone u.timezone)::date, interval '1 day') d
    where u.id = p_user_id and internal.day_locked(p_user_id, d::date)
  );
$$;

-- The first overlap of [p_start, p_end) with the person's clocked time (open sessions
-- run to now) or with another pending or approved entry (TS-09); null if none.
create function internal.manual_entry_overlap(
  p_user_id uuid,
  p_start timestamptz,
  p_end timestamptz,
  p_except uuid default null
)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when exists (
      select 1 from public.clock_sessions cs
      where cs.user_id = p_user_id and cs.start_at < p_end
        and coalesce(cs.end_at, clock_timestamp()) > p_start
    ) then 'overlaps_clocked_time'
    when exists (
      select 1 from public.manual_entries me
      where me.user_id = p_user_id and me.status in ('pending', 'approved')
        and me.id is distinct from p_except and me.start_at < p_end and me.end_at > p_start
    ) then 'overlaps_manual_entry'
  end;
$$;

-- The employee's direct manager, or that manager's active delegate (LLD section 05).
-- Other owners and admins only view; nobody decides their own entries.
create function internal.is_entry_decider(p_decider public.users, p_employee_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.users e
    where e.id = p_employee_id
      and e.org_id = p_decider.org_id
      and e.id <> p_decider.id
      and p_decider.active
      and (
        e.manager_id = p_decider.id
        or exists (
          select 1 from public.delegations d
          where d.manager_id = e.manager_id
            and d.delegate_id = p_decider.id
            and current_date between d.starts_on and d.ends_on
        )
      )
  );
$$;

revoke all on function internal.range_locked(uuid, timestamptz, timestamptz) from public, anon, authenticated;
revoke all on function internal.manual_entry_overlap(uuid, timestamptz, timestamptz, uuid) from public, anon, authenticated;
revoke all on function internal.is_entry_decider(public.users, uuid) from public, anon, authenticated;

-- Dirty marking ---------------------------------------------------------------------

-- Only approved entries are counted, so only they move segments: an entry that turns
-- approved, or stops being approved, or changes while approved, marks the days it
-- touches (the old range too, like internal.mark_dirty_interval).
create function internal.mark_dirty_manual_entry()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and old.status = 'approved' then
    perform internal.mark_dirty(old.user_id, old.start_at, old.end_at);
  end if;
  if new.status = 'approved' then
    perform internal.mark_dirty(new.user_id, new.start_at, new.end_at);
  end if;
  return null;
end;
$$;

revoke all on function internal.mark_dirty_manual_entry() from public, anon, authenticated;

create trigger manual_entries_mark_dirty
after insert or update on public.manual_entries
for each row execute function internal.mark_dirty_manual_entry();

-- RPCs ------------------------------------------------------------------------------

-- TS-07: the caller asks for time they weren't clocked in for. Pending until the
-- direct manager decides (TS-08), unless the person needs no approval (TS-16: the
-- owner at the top of the org, or approval_required off), which approves at once.
-- Returns the entry id. A project the person can't log to is refused (unlike
-- clock-in, nothing is lost by asking them to pick another).
create function public.request_manual_entry(
  p_start_at timestamptz,
  p_end_at timestamptz,
  p_project_id uuid,
  p_reason text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me public.users := internal.current_app_user();
  v_reason text := trim(coalesce(p_reason, ''));
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

  -- Serialises this person's requests so two can't both pass the overlap check.
  perform pg_advisory_xact_lock(hashtext('manual_entry:' || v_me.id::text));
  if internal.range_locked(v_me.id, p_start_at, p_end_at) then
    raise exception 'day_locked' using errcode = '55000';
  end if;
  v_overlap := internal.manual_entry_overlap(v_me.id, p_start_at, p_end_at);
  if v_overlap is not null then
    raise exception '%', v_overlap using errcode = '23P01';
  end if;

  insert into public.manual_entries (org_id, user_id, start_at, end_at, project_id, reason,
    status, decided_by, decided_at)
  values (v_me.org_id, v_me.id, p_start_at, p_end_at, p_project_id, v_reason,
    case when v_auto then 'approved' else 'pending' end,
    case when v_auto then v_me.id end,
    case when v_auto then now() end)
  returning id into v_id;

  perform internal.audit(v_me.org_id, v_me.id, 'manual_entry.requested', v_me.id,
    jsonb_build_object('entry_id', v_id, 'start_at', p_start_at, 'end_at', p_end_at,
      'project_id', p_project_id));
  if v_auto then
    perform internal.audit(v_me.org_id, v_me.id, 'manual_entry.auto_approved', v_me.id,
      jsonb_build_object('entry_id', v_id));
  end if;
  return v_id;
end;
$$;

-- TS-08: the direct manager (or active delegate) approves or rejects a pending entry.
-- Approval checks the overlap again: the employee may have clocked in since.
create function public.decide_manual_entry(
  p_id uuid,
  p_approve boolean,
  p_note text default null
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
  v_overlap text;
begin
  if p_approve is null then
    raise exception 'invalid_decision' using errcode = '22023';
  end if;
  if length(v_note) > 500 then
    raise exception 'invalid_note' using errcode = '22023';
  end if;
  select * into v_e from public.manual_entries where id = p_id for update;
  if not found or v_e.org_id <> v_me.org_id or not public.can_view_user(v_e.user_id) then
    raise exception 'entry_not_found' using errcode = '42501';
  end if;
  if not internal.is_entry_decider(v_me, v_e.user_id) then
    raise exception 'not_the_manager' using errcode = '42501';
  end if;
  if v_e.status <> 'pending' then
    raise exception 'not_pending' using errcode = '55000';
  end if;
  if internal.range_locked(v_e.user_id, v_e.start_at, v_e.end_at) then
    raise exception 'day_locked' using errcode = '55000';
  end if;

  if p_approve then
    perform pg_advisory_xact_lock(hashtext('manual_entry:' || v_e.user_id::text));
    v_overlap := internal.manual_entry_overlap(v_e.user_id, v_e.start_at, v_e.end_at, v_e.id);
    if v_overlap is not null then
      raise exception '%', v_overlap using errcode = '23P01';
    end if;
  end if;

  update public.manual_entries
  set status = case when p_approve then 'approved' else 'rejected' end,
      decided_by = v_me.id, decided_at = now(), decision_note = v_note
  where id = v_e.id;

  perform internal.audit(v_e.org_id, v_me.id,
    case when p_approve then 'manual_entry.approved' else 'manual_entry.rejected' end,
    v_e.user_id,
    jsonb_build_object('entry_id', v_e.id, 'start_at', v_e.start_at, 'end_at', v_e.end_at,
      'project_id', v_e.project_id, 'note', v_note));
end;
$$;

-- The employee withdraws their own pending entry.
create function public.cancel_manual_entry(p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me public.users := internal.current_app_user();
  v_e public.manual_entries;
begin
  select * into v_e from public.manual_entries where id = p_id and user_id = v_me.id for update;
  if not found then
    raise exception 'entry_not_found' using errcode = '42501';
  end if;
  if v_e.status <> 'pending' then
    raise exception 'not_pending' using errcode = '55000';
  end if;
  delete from public.manual_entries where id = v_e.id;
  perform internal.audit(v_e.org_id, v_me.id, 'manual_entry.cancelled', v_me.id,
    jsonb_build_object('entry_id', v_e.id, 'start_at', v_e.start_at, 'end_at', v_e.end_at));
end;
$$;

revoke all on function public.request_manual_entry(timestamptz, timestamptz, uuid, text) from public, anon;
revoke all on function public.decide_manual_entry(uuid, boolean, text) from public, anon;
revoke all on function public.cancel_manual_entry(uuid) from public, anon;
grant execute on function public.request_manual_entry(timestamptz, timestamptz, uuid, text) to authenticated;
grant execute on function public.decide_manual_entry(uuid, boolean, text) to authenticated;
grant execute on function public.cancel_manual_entry(uuid) to authenticated;

-- Segment inputs (replaces #41's version) ---------------------------------------------

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
      -- Employee re-assignments of a draft week (PRJ-04) arrive with #38/#44.
      'projectEdits', '[]'::jsonb,
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
