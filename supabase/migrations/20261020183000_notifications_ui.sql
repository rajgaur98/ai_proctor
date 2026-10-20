-- In-app notifications list (#138; TS-13, TS-18): mark some of the caller's
-- notifications read, not only all of them. Same shape as mark_alerts_read: no ids
-- marks every unread one; ids that are not the caller's are ignored.

drop function public.mark_notifications_read();

create function public.mark_notifications_read(p_ids uuid[] default null)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me public.users := internal.current_app_user();
  v_n int;
begin
  update public.notifications n
  set read_at = now()
  where n.user_id = v_me.id
    and n.read_at is null
    and (p_ids is null or n.id = any(p_ids));
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

revoke all on function public.mark_notifications_read(uuid[]) from public, anon;
grant execute on function public.mark_notifications_read(uuid[]) to authenticated;
