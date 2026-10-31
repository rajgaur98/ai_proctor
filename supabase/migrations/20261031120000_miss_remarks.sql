-- #252: a typed remark on missed check-ins (CHK-23). Redefines set_miss_reason from
-- 20261020114608_miss_reasons.sql (its only earlier definition):
--   - any of the caller's own misses can be explained or changed until the week it falls
--     in is approved (internal.day_locked, the lock rebuilds and manual entries use);
--     after that it is refused with timesheet_locked. Submitted weeks stay open, as
--     manager edits do: the reason helps the manager review;
--   - "other" needs a remark (remark_required); the other quick picks keep it optional;
--   - every change is audit-logged as checkin.miss_reason_set with the quick pick before
--     and after and the remark's length before and after. Not the remark itself: it is the
--     employee's own words, and the audit log outlives the check-in (the same choice as
--     manual_entry.requested, which leaves out the employee's reason).
-- The remark stays in checkin_events.missed_reason (up to 500 characters).

create or replace function public.set_miss_reason(p_checkin_id uuid, p_kind text, p_note text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me public.users := internal.current_app_user();
  v_c public.checkin_events;
  v_note text := nullif(trim(coalesce(p_note, '')), '');
  v_day date;
begin
  select * into v_c from public.checkin_events where id = p_checkin_id for update;
  -- Only the employee, only their own misses; others get the same answer.
  if not found or v_c.user_id <> v_me.id then
    raise exception 'checkin_not_found' using errcode = '42501';
  end if;
  if v_c.outcome <> 'miss' then
    raise exception 'not_a_miss' using errcode = '22023';
  end if;
  if p_kind is null and v_note is null then
    raise exception 'reason_required' using errcode = '22023';
  end if;
  if p_kind is not null and p_kind not in ('meeting', 'phone_call', 'break', 'away', 'other') then
    raise exception 'invalid_reason' using errcode = '22023';
  end if;
  if p_kind = 'other' and v_note is null then
    raise exception 'remark_required' using errcode = '22023';
  end if;
  if length(coalesce(v_note, '')) > 500 then
    raise exception 'note_too_long' using errcode = '22023';
  end if;
  -- The employee-local day the miss belongs to, as time segments place it.
  v_day := (coalesce(v_c.shown_at, v_c.scheduled_at) at time zone v_me.timezone)::date;
  if internal.day_locked(v_me.id, v_day) then
    raise exception 'timesheet_locked' using errcode = '55000';
  end if;

  if v_c.missed_reason_kind is not distinct from p_kind
    and v_c.missed_reason is not distinct from v_note
  then
    return;
  end if;

  update public.checkin_events
  set missed_reason_kind = p_kind, missed_reason = v_note
  where id = p_checkin_id;

  perform internal.audit(v_me.org_id, v_me.id, 'checkin.miss_reason_set', v_me.id,
    jsonb_build_object(
      'checkin_id', v_c.id,
      'at', coalesce(v_c.shown_at, v_c.scheduled_at),
      'from_kind', v_c.missed_reason_kind,
      'to_kind', p_kind,
      'from_note_length', coalesce(length(v_c.missed_reason), 0),
      'to_note_length', coalesce(length(v_note), 0)
    ));
end;
$$;

revoke all on function public.set_miss_reason(uuid, text, text) from public, anon;
grant execute on function public.set_miss_reason(uuid, text, text) to authenticated;
