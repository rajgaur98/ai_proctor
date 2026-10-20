-- #39: reasons for missed check-ins (CHK-23). The employee picks a quick reason
-- and/or writes a short note on any of their own misses; their manager sees it
-- next to the miss. Editable until the week's timesheet is submitted: timesheets
-- come with #43, which adds that lock to this function.

alter table public.checkin_events
  add column missed_reason_kind text check (
    missed_reason_kind in ('meeting', 'phone_call', 'break', 'away', 'other')
  );

create function public.set_miss_reason(p_checkin_id uuid, p_kind text, p_note text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me public.users := internal.current_app_user();
  v_c public.checkin_events;
  v_note text := nullif(trim(coalesce(p_note, '')), '');
begin
  select * into v_c from public.checkin_events where id = p_checkin_id;
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
  if length(coalesce(v_note, '')) > 500 then
    raise exception 'note_too_long' using errcode = '22023';
  end if;

  update public.checkin_events
  set missed_reason_kind = p_kind, missed_reason = v_note
  where id = p_checkin_id;
end;
$$;

revoke all on function public.set_miss_reason(uuid, text, text) from public, anon;
grant execute on function public.set_miss_reason(uuid, text, text) to authenticated;
