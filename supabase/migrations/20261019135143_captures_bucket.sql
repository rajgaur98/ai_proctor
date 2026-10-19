-- Captures bucket and upload policy (#24; CAP-06, NFR-SEC-02).
--
-- Path (tech-stack 2, "Key flows"): {org_id}/{user_id}/{YYYY-MM-DD}/{checkin_id}/{file}.webp
-- where the date is the check-in's scheduled date in UTC. The agent uploads only
-- after agent_events acked the check-in, and Storage accepts a file only when:
--   * the org and user folders are the caller's own,
--   * the check-in exists, belongs to the caller, passed, and has that date,
--   * the file name is one the check-in event declared in object_keys.
-- Nobody can read, overwrite or delete through the API: the dashboard gets
-- short-lived signed URLs from the capture-url Edge Function (#34), and retention
-- deletes through the Storage API with the service role (#51).

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('captures', 'captures', false, 1048576, array['image/webp'])
on conflict (id) do update
set public = false, file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

create function internal.can_upload_capture(p_name text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  parts text[] := string_to_array(p_name, '/');
  v_checkin_id uuid;
begin
  if auth.uid() is null or cardinality(parts) <> 5 then
    return false;
  end if;
  begin
    v_checkin_id := parts[4]::uuid;
  exception when invalid_text_representation then
    return false;
  end;

  return exists (
    select 1
    from public.checkin_events c
    join public.users u on u.id = c.user_id
    where c.id = v_checkin_id
      and c.user_id = auth.uid()
      and u.active
      and c.outcome = 'pass'
      and c.org_id::text = parts[1]
      and c.user_id::text = parts[2]
      and to_char(c.scheduled_at at time zone 'UTC', 'YYYY-MM-DD') = parts[3]
      and parts[5] = any (c.object_keys)
  );
end;
$$;

-- Storage policies run as the caller, so `authenticated` needs to reach this one
-- function. Every other internal function revokes EXECUTE explicitly, and from now
-- on new ones get no PUBLIC EXECUTE by default; a pgTAP test checks both.
alter default privileges in schema internal revoke execute on functions from public;
revoke all on function internal.can_upload_capture(text) from public, anon, authenticated;
grant usage on schema internal to authenticated;
grant execute on function internal.can_upload_capture(text) to authenticated;

create policy "Agents upload captures for their own passed check-ins"
on storage.objects
for insert
to authenticated
with check (bucket_id = 'captures' and internal.can_upload_capture(name));
