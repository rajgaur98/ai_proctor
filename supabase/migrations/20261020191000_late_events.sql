-- #140: late events for an approved week (TS-18). Events that sync after a week is
-- approved are stored, but the week is locked, so the rebuild would only drop their
-- dirty mark. Instead of ignoring them silently, the timesheet notes that new data
-- arrived and the approver is told once. The approved numbers never change: the
-- manager reopens the week (reopen_timesheet marks its days dirty again), the rebuild
-- picks the new data up, and the flag goes away with the reopen.
--
-- The late data is recorded where the dirty mark is made (mark_dirty): every fact that
-- touches a day of an approved week goes through it, and a mark made while the week is
-- approved is by definition after approval. Facts that were already marked before the
-- approval but not rebuilt yet are not "late"; they are dropped like before.
--   late_data_at       first late fact since the approval (null: none)
--   late_data_last_at  the latest one
--   late_data_count    late facts so far. It counts changed rows (one agent event can
--                      change more than one: a clock-out closes a session and a status
--                      period), so it is a size hint, not an exact event count.
-- The approver (the employee's direct manager and their active delegates, the
-- is_entry_decider rule) is notified when late_data_at is first set, not per event.
-- Reopening clears all three, so a week approved again starts clean.

alter table public.timesheets
  add column late_data_at timestamptz,
  add column late_data_last_at timestamptz,
  add column late_data_count int not null default 0 check (late_data_count >= 0),
  add constraint timesheets_late_data_pair check ((late_data_at is null) = (late_data_count = 0));

-- Notes late facts for the approved weeks that overlap the local days p_first..p_last:
-- bumps the counters and, the first time, notifies the approvers. Called by mark_dirty
-- before it writes dirty_days, so every path takes the timesheet lock first and
-- reopen_timesheet (timesheet, then dirty_days) cannot deadlock with a sync.
create function internal.note_late_data(p_user_id uuid, p_first date, p_last date)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ts public.timesheets;
  v_emp public.users;
  v_now timestamptz := clock_timestamp();
  v_rec record;
begin
  for v_ts in
    select t.* from public.timesheets t
    where t.user_id = p_user_id and t.status = 'approved'
      and t.period_start <= p_last and t.period_start + 6 >= p_first
    order by t.period_start
    for update
  loop
    update public.timesheets t
    set late_data_at = coalesce(t.late_data_at, v_now),
        late_data_last_at = v_now,
        late_data_count = t.late_data_count + 1
    where t.id = v_ts.id;

    if v_ts.late_data_at is null then
      select * into v_emp from public.users u where u.id = v_ts.user_id;
      for v_rec in
        select u.id
        from public.users u
        where u.org_id = v_emp.org_id and u.active and u.id <> v_emp.id
          and (
            u.id = v_emp.manager_id
            or exists (
              select 1 from public.delegations d
              where d.manager_id = v_emp.manager_id and d.delegate_id = u.id
            )
          )
          and internal.is_entry_decider(u, v_emp.id)
      loop
        perform internal.notify(v_emp.org_id, v_rec.id, 'timesheet.late_data',
          jsonb_build_object('timesheet_id', v_ts.id, 'period_start', v_ts.period_start,
            'period_end', v_ts.period_start + 6, 'employee_id', v_emp.id,
            'employee_name', v_emp.full_name));
      end loop;
    end if;
  end loop;
end;
$$;

revoke all on function internal.note_late_data(uuid, date, date) from public, anon, authenticated;

-- Marking (replaces #126's version: facts for an approved week are noted as late) ----------
-- (Latest definition before this: segments_fresh.)
create or replace function internal.mark_dirty(p_user_id uuid, p_from timestamptz, p_to timestamptz)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tz text;
  v_first date;
  v_last date;
begin
  select u.timezone into v_tz from public.users u where u.id = p_user_id;
  if v_tz is null then
    return;
  end if;
  v_first := (p_from at time zone v_tz)::date;
  v_last := (greatest(p_from, p_to - interval '1 microsecond') at time zone v_tz)::date;
  perform internal.note_late_data(p_user_id, v_first, v_last);
  insert into public.dirty_days (user_id, day, marked_at, next_attempt_at)
  select p_user_id, d::date, clock_timestamp(), clock_timestamp()
  from generate_series(v_first, v_last, interval '1 day') d
  on conflict (user_id, day) do update
    set marked_at = excluded.marked_at,
        attempts = 0,
        next_attempt_at = excluded.next_attempt_at;
end;
$$;

-- Reopening (replaces #44's version: the late-data flag goes with the lock) ----------------
-- (Latest definition before this: delegation.)
create or replace function public.reopen_timesheet(p_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me public.users := internal.current_app_user();
  v_ts public.timesheets := internal.load_timesheet(p_id, v_me);
  v_self boolean := internal.is_own_auto_approved(v_me, v_ts);
  v_reason text := trim(coalesce(p_reason, ''));
begin
  if not v_self and not internal.is_entry_decider(v_me, v_ts.user_id) then
    raise exception 'not_the_manager' using errcode = '42501';
  end if;
  if length(v_reason) not between 1 and 500 then
    raise exception 'invalid_reason' using errcode = '22023';
  end if;
  if v_ts.status <> 'approved' then
    raise exception 'not_approved' using errcode = '55000';
  end if;

  update public.timesheets
  set status = case when v_self then 'draft' else 'submitted' end,
      submitted_at = case when v_self then null else submitted_at end,
      approver_id = null, approved_at = null,
      late_data_at = null, late_data_last_at = null, late_data_count = 0
  where id = v_ts.id;
  perform internal.mark_week_dirty(v_ts.user_id, v_ts.period_start);

  perform internal.audit(v_ts.org_id, v_me.id, 'timesheet.reopened', v_ts.user_id,
    jsonb_build_object('timesheet_id', v_ts.id, 'period_start', v_ts.period_start,
      'reason', v_reason, 'approved_by', v_ts.approver_id, 'own_week', v_self));
  if not v_self then
    perform internal.notify(v_ts.org_id, v_ts.user_id, 'timesheet.reopened',
      jsonb_build_object('timesheet_id', v_ts.id, 'period_start', v_ts.period_start,
        'reason', v_reason, 'by', v_me.id));
  end if;
end;
$$;
