-- #263 (#254 part 4): the day list of a week changes the employee's own manual entries:
-- edit their times, task and note; split one at a time into two; merge two adjacent ones;
-- duplicate one to another day. Duplicating is a new request (the web app calls
-- request_manual_entry with the entry's details on the chosen day), so a copy follows
-- every rule of a request and is audit-logged as one.
--
-- Who and when, as #254 part 1 decided for entry details: only the employee, on their own
-- entries, while the week the entry starts in is a draft or returned. A submitted week is
-- with the manager (timesheet_submitted); an approved one is locked (timesheet_locked,
-- TS-18), and so is an entry with any day in an approved week (day_locked). The manager
-- changes entries with adjust_time (TS-13). A rejected entry doesn't change.
--
-- Approval (TS-08):
--   - edit_manual_entry: new times are time to approve again, so an approved entry whose
--     times change goes back to pending (approved at once for a person who needs no
--     approval, TS-16). A task or note change alone keeps the status, as in
--     update_manual_entry_details.
--   - split_manual_entry: no time is added or removed. Both parts keep the entry's status,
--     decision, project, task, reason and note. The parts are [start, at) and [at, end),
--     so their seconds sum to the entry's exactly (TS-05).
--   - merge_manual_entries: two entries that touch (the first ends where the second
--     starts), start on the same local day, have the same project and task and together
--     last at most 24 hours. The earlier one is kept and runs to the later one's end; the
--     later one is deleted. Approved only when both were (no new time) or the person needs
--     no approval; else pending. Reasons and notes that differ are joined with a line
--     break (a reason that would pass 500 characters keeps the earlier one's; joined notes
--     past 2,000 are refused, the employee shortens one first).
-- Every change is audit-logged with the entries before and after (AUD-01).
--
-- No existing function is redefined.

-- The employee's own week holding `p_day`, created as a draft if new, open for their
-- changes: a draft or returned week. Refuses a submitted or approved one.
create function internal.own_open_week(p_me public.users, p_day date)
returns public.timesheets
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_ts public.timesheets;
begin
  select t.id into v_id from public.timesheets t
  where t.user_id = p_me.id and p_day >= t.period_start and p_day < t.period_start + 7;
  if not found then
    v_id := public.ensure_timesheet(p_me.id, internal.week_start(p_me.org_id, p_day));
  end if;
  v_ts := internal.load_timesheet(v_id, p_me);
  if v_ts.status = 'submitted' then
    raise exception 'timesheet_submitted' using errcode = '55000';
  end if;
  if v_ts.status = 'approved' then
    raise exception 'timesheet_locked' using errcode = '55000';
  end if;
  return v_ts;
end;
$$;

-- Loads and locks one of the caller's own entries for a change, after checking it may
-- change now (see the header).
create function internal.own_entry_for_change(p_me public.users, p_id uuid)
returns public.manual_entries
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_e public.manual_entries;
begin
  select * into v_e from public.manual_entries where id = p_id for update;
  if not found or v_e.org_id <> p_me.org_id or not public.can_view_user(v_e.user_id) then
    raise exception 'entry_not_found' using errcode = '42501';
  end if;
  if v_e.user_id <> p_me.id then
    raise exception 'not_your_entry' using errcode = '42501';
  end if;
  if v_e.status = 'rejected' then
    raise exception 'not_adjustable' using errcode = '55000';
  end if;
  perform internal.own_open_week(p_me, (v_e.start_at at time zone p_me.timezone)::date);
  if internal.range_locked(p_me.id, v_e.start_at, v_e.end_at) then
    raise exception 'day_locked' using errcode = '55000';
  end if;
  return v_e;
end;
$$;

revoke all on function internal.own_open_week(public.users, date) from public, anon, authenticated;
revoke all on function internal.own_entry_for_change(public.users, uuid) from public, anon, authenticated;

-- The audit snapshot of an entry.
create function internal.entry_snapshot(p_e public.manual_entries)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object('entry_id', p_e.id, 'start_at', p_e.start_at, 'end_at', p_e.end_at,
    'project_id', p_e.project_id, 'task_id', p_e.task_id, 'note', p_e.note,
    'status', p_e.status);
$$;

revoke all on function internal.entry_snapshot(public.manual_entries) from public, anon, authenticated;

-- TS-07, TS-24: the employee changes the times, task and note of their own entry (its
-- project stays: another project is a new request). Same checks as a request for the new
-- times, against every other entry. Changed times need approving again (see the header).
create function public.edit_manual_entry(
  p_id uuid,
  p_start_at timestamptz,
  p_end_at timestamptz,
  p_task_id uuid,
  p_note text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me public.users := internal.current_app_user();
  v_note text := nullif(trim(coalesce(p_note, '')), '');
  v_auto boolean := not v_me.approval_required or v_me.manager_id is null;
  v_e public.manual_entries;
  v_after public.manual_entries;
  v_ts public.timesheets;
  v_moved boolean;
  v_overlap text;
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
  if length(v_note) > 2000 then
    raise exception 'invalid_note' using errcode = '22023';
  end if;

  -- Serialises this person's entry changes so two can't both pass the overlap check.
  perform pg_advisory_xact_lock(hashtext('manual_entry:' || v_me.id::text));
  v_e := internal.own_entry_for_change(v_me, p_id);
  v_ts := internal.own_open_week(v_me, (v_e.start_at at time zone v_me.timezone)::date);
  -- The new times may be on another day: that week must be open too.
  perform internal.own_open_week(v_me, (p_start_at at time zone v_me.timezone)::date);
  if internal.range_locked(v_me.id, p_start_at, p_end_at) then
    raise exception 'day_locked' using errcode = '55000';
  end if;
  -- An archived task the entry already has may stay on it.
  if p_task_id is distinct from v_e.task_id
     and not internal.task_allowed(v_e.project_id, p_task_id) then
    raise exception 'task_not_allowed' using errcode = '22023';
  end if;
  v_moved := p_start_at <> v_e.start_at or p_end_at <> v_e.end_at;
  if not v_moved and p_task_id is not distinct from v_e.task_id
     and v_note is not distinct from v_e.note then
    return;
  end if;
  if v_moved then
    v_overlap := internal.manual_entry_overlap(v_me.id, p_start_at, p_end_at, v_e.id);
    if v_overlap is not null then
      raise exception '%', v_overlap using errcode = '23P01';
    end if;
  end if;

  update public.manual_entries
  set start_at = p_start_at, end_at = p_end_at, task_id = p_task_id, note = v_note,
      status = case when v_moved and v_e.status = 'approved' and not v_auto then 'pending'
                    else status end,
      decided_by = case when v_moved and v_e.status = 'approved' then
                     case when v_auto then v_me.id end
                   else decided_by end,
      decided_at = case when v_moved and v_e.status = 'approved' then
                     case when v_auto then now() end
                   else decided_at end,
      decision_note = case when v_moved and v_e.status = 'approved' then null
                      else decision_note end
  where id = v_e.id
  returning * into v_after;

  perform internal.audit(v_me.org_id, v_me.id, 'manual_entry.edited', v_me.id,
    jsonb_build_object('entry_id', v_e.id, 'timesheet_id', v_ts.id,
      'before', internal.entry_snapshot(v_e), 'after', internal.entry_snapshot(v_after)));
end;
$$;

-- Splits the caller's own entry at `p_at` into [start, at) and [at, end). The entry keeps
-- the first part; a new entry with everything else the same takes the second. Returns the
-- new entry's id.
create function public.split_manual_entry(p_id uuid, p_at timestamptz)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me public.users := internal.current_app_user();
  v_e public.manual_entries;
  v_ts public.timesheets;
  v_id uuid;
begin
  if p_at is null then
    raise exception 'invalid_split' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtext('manual_entry:' || v_me.id::text));
  v_e := internal.own_entry_for_change(v_me, p_id);
  v_ts := internal.own_open_week(v_me, (v_e.start_at at time zone v_me.timezone)::date);
  if p_at <= v_e.start_at or p_at >= v_e.end_at then
    raise exception 'invalid_split' using errcode = '22023';
  end if;

  update public.manual_entries set end_at = p_at where id = v_e.id;
  insert into public.manual_entries (org_id, user_id, start_at, end_at, project_id, task_id,
    note, reason, status, decided_by, decided_at, decision_note)
  values (v_e.org_id, v_e.user_id, p_at, v_e.end_at, v_e.project_id, v_e.task_id, v_e.note,
    v_e.reason, v_e.status, v_e.decided_by, v_e.decided_at, v_e.decision_note)
  returning id into v_id;

  perform internal.audit(v_me.org_id, v_me.id, 'manual_entry.split', v_me.id,
    jsonb_build_object('entry_id', v_e.id, 'new_entry_id', v_id, 'timesheet_id', v_ts.id,
      'at', p_at, 'before', internal.entry_snapshot(v_e),
      'seconds', jsonb_build_array(extract(epoch from p_at - v_e.start_at),
        extract(epoch from v_e.end_at - p_at))));
  return v_id;
end;
$$;

-- Merges two of the caller's own entries that touch (see the header) into the earlier
-- one, in either order. Returns the kept entry's id.
create function public.merge_manual_entries(p_first uuid, p_second uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me public.users := internal.current_app_user();
  v_auto boolean := not v_me.approval_required or v_me.manager_id is null;
  v_a public.manual_entries;
  v_b public.manual_entries;
  v_x public.manual_entries;
  v_ts public.timesheets;
  v_after public.manual_entries;
  v_both_approved boolean;
  v_reason text;
  v_note text;
begin
  if p_first is null or p_second is null or p_first = p_second then
    raise exception 'invalid_merge' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtext('manual_entry:' || v_me.id::text));
  -- Locked in id order, then put in time order.
  v_a := internal.own_entry_for_change(v_me, least(p_first, p_second));
  v_b := internal.own_entry_for_change(v_me, greatest(p_first, p_second));
  if v_b.start_at < v_a.start_at then
    v_x := v_a;
    v_a := v_b;
    v_b := v_x;
  end if;
  v_ts := internal.own_open_week(v_me, (v_a.start_at at time zone v_me.timezone)::date);

  if v_a.end_at <> v_b.start_at then
    raise exception 'not_adjacent' using errcode = '22023';
  end if;
  if (v_a.start_at at time zone v_me.timezone)::date
     <> (v_b.start_at at time zone v_me.timezone)::date then
    raise exception 'not_same_day' using errcode = '22023';
  end if;
  if v_a.project_id is distinct from v_b.project_id or v_a.task_id is distinct from v_b.task_id then
    raise exception 'not_same_assignment' using errcode = '22023';
  end if;
  if v_b.end_at - v_a.start_at > interval '24 hours' then
    raise exception 'range_too_long' using errcode = '22023';
  end if;

  v_reason := case
    when v_a.reason = v_b.reason then v_a.reason
    when length(v_a.reason || E'\n' || v_b.reason) <= 500 then v_a.reason || E'\n' || v_b.reason
    else v_a.reason
  end;
  v_note := case
    when v_a.note is null or v_a.note = v_b.note then coalesce(v_a.note, v_b.note)
    when v_b.note is null then v_a.note
    else v_a.note || E'\n' || v_b.note
  end;
  if length(v_note) > 2000 then
    raise exception 'invalid_note' using errcode = '22023';
  end if;
  v_both_approved := v_a.status = 'approved' and v_b.status = 'approved';

  delete from public.manual_entries where id = v_b.id;
  -- The delete doesn't mark days; counted time it held is rebuilt with the kept entry's.
  if v_b.status = 'approved' then
    perform internal.mark_dirty(v_b.user_id, v_b.start_at, v_b.end_at);
  end if;
  update public.manual_entries
  set end_at = v_b.end_at, reason = v_reason, note = v_note,
      status = case when v_both_approved or v_auto then 'approved' else 'pending' end,
      decided_by = case when v_both_approved then decided_by when v_auto then v_me.id end,
      decided_at = case when v_both_approved then decided_at when v_auto then now() end,
      decision_note = case when v_both_approved then decision_note end
  where id = v_a.id
  returning * into v_after;

  perform internal.audit(v_me.org_id, v_me.id, 'manual_entry.merged', v_me.id,
    jsonb_build_object('entry_id', v_a.id, 'merged_entry_id', v_b.id, 'timesheet_id', v_ts.id,
      'before', jsonb_build_array(internal.entry_snapshot(v_a), internal.entry_snapshot(v_b)),
      'after', internal.entry_snapshot(v_after)));
  return v_a.id;
end;
$$;

revoke all on function public.edit_manual_entry(uuid, timestamptz, timestamptz, uuid, text) from public, anon;
revoke all on function public.split_manual_entry(uuid, timestamptz) from public, anon;
revoke all on function public.merge_manual_entries(uuid, uuid) from public, anon;
grant execute on function public.edit_manual_entry(uuid, timestamptz, timestamptz, uuid, text) to authenticated;
grant execute on function public.split_manual_entry(uuid, timestamptz) to authenticated;
grant execute on function public.merge_manual_entries(uuid, uuid) to authenticated;
