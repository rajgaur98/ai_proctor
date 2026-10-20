-- Alerts over Realtime and the alerts page (#135; ALR-01).
--
-- The bell subscribes to INSERTs on public.alerts for the signed-in recipient. Realtime
-- applies the table's RLS to each subscriber's JWT, so a recipient only receives the
-- alerts they could select (the "Recipients and viewers read alerts" policy).
alter publication supabase_realtime add table public.alerts;

-- Marks the caller's own unread alerts read that match a filter: the alerts page's
-- "mark all matching read" (mark_alerts_read takes ids, which the page doesn't have for
-- rows it hasn't loaded). Every argument is optional; p_to is exclusive. Returns the
-- number marked.
create function public.mark_alerts_read_matching(
  p_kind public.alert_kind default null,
  p_user_id uuid default null,
  p_from timestamptz default null,
  p_to timestamptz default null
)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_n int;
begin
  update public.alerts a
  set read_at = now()
  where a.recipient_id = auth.uid()
    and a.read_at is null
    and (p_kind is null or a.kind = p_kind)
    and (p_user_id is null or a.user_id = p_user_id)
    and (p_from is null or a.triggered_at >= p_from)
    and (p_to is null or a.triggered_at < p_to);
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

revoke all on function public.mark_alerts_read_matching(public.alert_kind, uuid, timestamptz, timestamptz)
  from public, anon;
grant execute on function public.mark_alerts_read_matching(public.alert_kind, uuid, timestamptz, timestamptz)
  to authenticated;
