-- #34: opening a check-in's captures (DSH-04, AUD-01, NFR-SEC-02).
--
-- The capture-url Edge Function calls capture_view with the viewer's own token:
-- the access check (can_view_user) and the audit row happen here, in one place
-- that can't be skipped, on every view including repeats. The function then signs
-- the returned paths for at most 5 minutes with the service role.

create function public.capture_view(p_checkin_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me public.users := internal.current_app_user();
  v_c public.checkin_events;
  v_retention int;
  v_app record;
begin
  select * into v_c from public.checkin_events where id = p_checkin_id;
  if not found or v_c.org_id <> v_me.org_id
    or v_c.org_id <> internal.jwt_org_id() or not public.can_view_user(v_c.user_id)
  then
    -- Same answer whether it doesn't exist or isn't yours.
    raise exception 'checkin_not_found' using errcode = '42501';
  end if;

  perform internal.audit(v_c.org_id, v_me.id, 'capture.viewed', v_c.user_id,
    jsonb_build_object('checkin_id', v_c.id, 'objects', v_c.object_keys));

  v_retention := coalesce(
    (select (o.policy ->> 'image_retention_days')::int from public.orgs o where o.id = v_c.org_id), 30);

  -- The app in front when the card was answered (#25), if sampled.
  select a.app_name, a.domain into v_app
  from public.activity_samples a
  where a.user_id = v_c.user_id
    and a.minute = date_trunc('minute', coalesce(v_c.responded_at, v_c.scheduled_at))
  order by a.seconds desc
  limit 1;

  return jsonb_build_object(
    'checkin_id', v_c.id,
    'user_id', v_c.user_id,
    'scheduled_at', v_c.scheduled_at,
    'responded_at', v_c.responded_at,
    'project_id', v_c.project_id,
    'app', v_app.app_name,
    'domain', v_app.domain,
    'capture_errors', v_c.capture_errors,
    -- Past retention the files are gone (or about to be): don't sign anything.
    'expired', v_c.scheduled_at < now() - make_interval(days => v_retention),
    'objects', coalesce((
      select jsonb_agg(jsonb_build_object(
        'name', name,
        'path', format('%s/%s/%s/%s/%s', v_c.org_id, v_c.user_id,
          to_char(v_c.scheduled_at at time zone 'UTC', 'YYYY-MM-DD'), v_c.id, name)
      ) order by name)
      from unnest(v_c.object_keys) as name
    ), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.capture_view(uuid) from public, anon;
grant execute on function public.capture_view(uuid) to authenticated;
