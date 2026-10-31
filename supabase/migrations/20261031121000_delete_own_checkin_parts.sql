-- #253: an employee deletes parts of their own check-ins (EMP-06, CAP-09, AUD-01).
--
-- On My data, for one of their own passed check-ins, the employee picks any of:
--   webcam   the webcam frame (webcam.webp)
--   screen   the screen captures (screen-<n>.webp, one per display)
--   apps     the app activity of the check-in's minute: the activity_samples rows of
--            the minute it was answered in (what the day view and My data show as the
--            check-in's "Active app"), and the app, title and domain in the raw
--            app_session events behind them
--   domains  the browser domains of that minute: the domain, and the page title of
--            browser rows (a page title names the site), on the samples and the raw events
-- Only the person the check-in belongs to can do it: not a manager, an admin or the
-- owner, for anyone else. An admin can for their own check-ins, like anyone.
--
-- The delete-checkin-parts Edge Function calls delete_checkin_parts with the
-- employee's own token (the checks, the tombstone, the database rows and the audit
-- rows happen here, in one transaction), then removes the returned files through the
-- Storage API with the service role, and checks with checkin_removed_paths that none
-- are left. Calling the RPC directly instead hides the files from every viewer and
-- blocks their upload, and the retention job removes them with the rest.
--
-- The check-in keeps a tombstone per part (when it was removed). Removing evidence
-- doesn't change the check-in: a pass stays a pass, its time still counts, and it is
-- not a flag. The day view says "Webcam and screen removed by <employee> on <date>".
--
-- Redefined, from their latest definitions:
--   internal.can_upload_capture   20261020140000_retention_jobs.sql
--   public.capture_view           20261020140000_retention_jobs.sql
--   internal.record_activity      20261020153000_monitoring_notice.sql

alter table public.checkin_events
  add column webcam_deleted_at timestamptz,
  add column screen_deleted_at timestamptz,
  add column apps_deleted_at timestamptz,
  add column domains_deleted_at timestamptz;

comment on column public.checkin_events.webcam_deleted_at is
  'When the employee removed the webcam frame of this check-in (#253). The check-in result is unchanged.';
comment on column public.checkin_events.screen_deleted_at is
  'When the employee removed the screen captures of this check-in (#253). The check-in result is unchanged.';
comment on column public.checkin_events.apps_deleted_at is
  'When the employee removed the app activity of the minute this check-in was answered in (#253).';
comment on column public.checkin_events.domains_deleted_at is
  'When the employee removed the browser domains of the minute this check-in was answered in (#253).';

-- Helpers -----------------------------------------------------------------------------------

-- Which part a capture file is: the webcam frame or a screen capture.
create function internal.capture_part(p_name text)
returns text
language sql
immutable
set search_path = ''
as $$ select case when p_name = 'webcam.webp' then 'webcam' else 'screen' end $$;

-- The minute a check-in was answered in, as activity_samples count it; the same minute
-- capture_view and My data show the check-in's app for.
create function internal.checkin_minute(p_responded_at timestamptz, p_scheduled_at timestamptz)
returns timestamptz
language sql
immutable
set search_path = ''
as $$ select date_trunc('minute', coalesce(p_responded_at, p_scheduled_at)) $$;

-- Whether the person removed the apps or the domains of a check-in answered in this
-- minute, so a sample or raw event that arrives later isn't kept.
create function internal.minute_parts_removed(p_user_id uuid, p_minute timestamptz)
returns table (apps boolean, domains boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(bool_or(c.apps_deleted_at is not null), false),
         coalesce(bool_or(c.domains_deleted_at is not null), false)
  from public.checkin_events c
  where c.user_id = p_user_id
    and c.outcome = 'pass'
    and (c.apps_deleted_at is not null or c.domains_deleted_at is not null)
    and c.scheduled_at > p_minute - interval '1 day'
    and c.scheduled_at < p_minute + interval '1 minute'
    and internal.checkin_minute(c.responded_at, c.scheduled_at) = p_minute;
$$;

-- The Storage paths of a check-in's removed files that are still in Storage.
create function internal.removed_capture_paths(p_c public.checkin_events)
returns text[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(o.name order by o.name), '{}')
  from unnest(p_c.object_keys) k
  join storage.objects o
    on o.bucket_id = 'captures'
   and o.name = internal.capture_path(p_c.org_id, p_c.user_id, p_c.scheduled_at, p_c.id, k)
  where (internal.capture_part(k) = 'webcam' and p_c.webcam_deleted_at is not null)
     or (internal.capture_part(k) = 'screen' and p_c.screen_deleted_at is not null);
$$;

revoke all on function internal.capture_part(text) from public, anon, authenticated;
revoke all on function internal.checkin_minute(timestamptz, timestamptz) from public, anon, authenticated;
revoke all on function internal.minute_parts_removed(uuid, timestamptz) from public, anon, authenticated;
revoke all on function internal.removed_capture_paths(public.checkin_events)
  from public, anon, authenticated;

-- The request -------------------------------------------------------------------------------

-- Removes `p_parts` of the caller's own passed check-in. Parts already removed are left
-- as they were (their time stays), so running it again is safe and is how the function
-- finishes a removal whose Storage step failed. Returns the parts now removed, the
-- Storage paths left to remove and the counts. One audit row per kind of data, for
-- the parts this call removed: capture.deleted (webcam, screen) and activity.deleted
-- (apps, domains), the employee as both actor and subject.
create function public.delete_checkin_parts(p_checkin_id uuid, p_parts text[])
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me public.users := internal.current_app_user();
  v_c public.checkin_events;
  v_parts text[];
  v_new text[];
  v_capture_parts text[];
  v_activity_parts text[];
  v_files text[];
  v_objects int := 0;
  v_minute timestamptz;
  v_samples_deleted bigint := 0;
  v_samples_cleared bigint := 0;
  v_raw bigint := 0;
  v_n bigint;
begin
  if p_parts is null or cardinality(p_parts) = 0 or cardinality(p_parts) > 4 or exists (
    select 1 from unnest(p_parts) p where p is null or p not in ('webcam', 'screen', 'apps', 'domains')
  ) then
    raise exception 'invalid_parts' using errcode = '22023';
  end if;
  v_parts := array(select distinct p from unnest(p_parts) p order by p);

  select * into v_c from public.checkin_events c where c.id = p_checkin_id for update;
  -- Only the person it belongs to; the same answer whether it doesn't exist or isn't theirs.
  if not found or v_c.user_id <> v_me.id or v_c.org_id is distinct from internal.jwt_org_id() then
    raise exception 'checkin_not_found' using errcode = '42501';
  end if;
  if v_c.outcome <> 'pass' then
    raise exception 'not_a_pass' using errcode = '22023';
  end if;

  v_new := array(
    select p from unnest(v_parts) p
    where (p = 'webcam' and v_c.webcam_deleted_at is null)
       or (p = 'screen' and v_c.screen_deleted_at is null)
       or (p = 'apps' and v_c.apps_deleted_at is null)
       or (p = 'domains' and v_c.domains_deleted_at is null)
  );
  v_capture_parts := array(select p from unnest(v_new) p where p in ('screen', 'webcam'));
  v_activity_parts := array(select p from unnest(v_new) p where p in ('apps', 'domains'));

  -- The tombstone. Only the new columns change: outcome, times and flags stay.
  update public.checkin_events c
  set webcam_deleted_at = coalesce(c.webcam_deleted_at, case when 'webcam' = any (v_new) then now() end),
      screen_deleted_at = coalesce(c.screen_deleted_at, case when 'screen' = any (v_new) then now() end),
      apps_deleted_at = coalesce(c.apps_deleted_at, case when 'apps' = any (v_new) then now() end),
      domains_deleted_at = coalesce(c.domains_deleted_at, case when 'domains' = any (v_new) then now() end)
  where c.id = v_c.id
  returning * into v_c;

  -- Captures: the declared files of the new parts, and how many are in Storage now.
  if cardinality(v_capture_parts) > 0 then
    v_files := array(
      select k from unnest(v_c.object_keys) k
      where internal.capture_part(k) = any (v_capture_parts) order by k
    );
    select count(*)::int into v_objects
    from unnest(v_files) k
    join storage.objects o
      on o.bucket_id = 'captures'
     and o.name = internal.capture_path(v_c.org_id, v_c.user_id, v_c.scheduled_at, v_c.id, k);
    perform internal.audit(v_c.org_id, v_me.id, 'capture.deleted', v_me.id,
      jsonb_build_object('checkin_id', v_c.id, 'parts', to_jsonb(v_capture_parts),
        'files', to_jsonb(v_files), 'objects', v_objects));
  end if;

  -- Activity of the minute the check-in was answered in.
  if cardinality(v_activity_parts) > 0 then
    v_minute := internal.checkin_minute(v_c.responded_at, v_c.scheduled_at);
    if 'apps' = any (v_activity_parts) then
      delete from public.activity_samples s
      where s.user_id = v_c.user_id and s.minute = v_minute;
      get diagnostics v_samples_deleted = row_count;
      update public.agent_events_raw r
      set payload = r.payload - 'app' - 'title' - 'domain'
      where r.user_id = v_c.user_id and r.type = 'app_session'
        and r.at >= v_minute - interval '1 hour' and r.at < v_minute + interval '1 hour'
        and date_trunc('minute', (r.payload ->> 'start')::timestamptz) = v_minute
        and (r.payload ? 'app' or r.payload ? 'title' or r.payload ? 'domain');
      get diagnostics v_n = row_count;
      v_raw := v_raw + v_n;
    end if;
    if 'domains' = any (v_activity_parts) then
      update public.activity_samples s
      set domain = null, window_title = null
      where s.user_id = v_c.user_id and s.minute = v_minute and s.domain is not null;
      get diagnostics v_samples_cleared = row_count;
      update public.agent_events_raw r
      set payload = r.payload - 'title' - 'domain'
      where r.user_id = v_c.user_id and r.type = 'app_session'
        and r.at >= v_minute - interval '1 hour' and r.at < v_minute + interval '1 hour'
        and date_trunc('minute', (r.payload ->> 'start')::timestamptz) = v_minute
        and nullif(r.payload ->> 'domain', '') is not null;
      get diagnostics v_n = row_count;
      v_raw := v_raw + v_n;
    end if;
    perform internal.audit(v_c.org_id, v_me.id, 'activity.deleted', v_me.id,
      jsonb_build_object('checkin_id', v_c.id, 'parts', to_jsonb(v_activity_parts),
        'minute', v_minute, 'samples_deleted', v_samples_deleted,
        'samples_cleared', v_samples_cleared, 'raw_events', v_raw));
  end if;

  return jsonb_build_object(
    'checkin_id', v_c.id,
    'removed', jsonb_build_object(
      'webcam', v_c.webcam_deleted_at, 'screen', v_c.screen_deleted_at,
      'apps', v_c.apps_deleted_at, 'domains', v_c.domains_deleted_at),
    'new_parts', to_jsonb(v_new),
    'objects', v_objects,
    'samples_deleted', v_samples_deleted,
    'samples_cleared', v_samples_cleared,
    -- Every removed file still in Storage, this call's and any an earlier call left.
    'paths', to_jsonb(internal.removed_capture_paths(v_c))
  );
end;
$$;

-- The removed files of the caller's own check-in still in Storage (the function checks
-- it is empty after removing them). Read-only.
create function public.checkin_removed_paths(p_checkin_id uuid)
returns text[]
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_me public.users := internal.current_app_user();
  v_c public.checkin_events;
begin
  select * into v_c from public.checkin_events c where c.id = p_checkin_id;
  if not found or v_c.user_id <> v_me.id or v_c.org_id is distinct from internal.jwt_org_id() then
    raise exception 'checkin_not_found' using errcode = '42501';
  end if;
  return internal.removed_capture_paths(v_c);
end;
$$;

revoke all on function public.delete_checkin_parts(uuid, text[]) from public, anon;
revoke all on function public.checkin_removed_paths(uuid) from public, anon;
grant execute on function public.delete_checkin_parts(uuid, text[]) to authenticated;
grant execute on function public.checkin_removed_paths(uuid) to authenticated;

-- Uploads -----------------------------------------------------------------------------------

-- A removed part can't come back: the agent may upload after the employee removed it
-- (it uploads after the check-in is acknowledged, maybe much later when it was offline).
-- Otherwise unchanged from 20261020140000_retention_jobs.sql.
create or replace function internal.can_upload_capture(p_name text)
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
      and c.captures_purged_at is null
      and c.org_id::text = parts[1]
      and c.user_id::text = parts[2]
      and to_char(c.scheduled_at at time zone 'UTC', 'YYYY-MM-DD') = parts[3]
      and parts[5] = any (c.object_keys)
      and not (internal.capture_part(parts[5]) = 'webcam' and c.webcam_deleted_at is not null)
      and not (internal.capture_part(parts[5]) = 'screen' and c.screen_deleted_at is not null)
  );
end;
$$;

-- Viewing -----------------------------------------------------------------------------------

-- capture_view with the removed parts: their files are neither listed nor signed (nor
-- in the view's audit row), and `removed` says when each part was removed, for the
-- tombstone. Otherwise unchanged from 20261020140000_retention_jobs.sql.
create or replace function public.capture_view(p_checkin_id uuid)
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
  v_keys text[];
begin
  select * into v_c from public.checkin_events where id = p_checkin_id;
  if not found or v_c.org_id <> v_me.org_id
    or v_c.org_id <> internal.jwt_org_id() or not public.can_view_user(v_c.user_id)
  then
    -- Same answer whether it doesn't exist or isn't yours.
    raise exception 'checkin_not_found' using errcode = '42501';
  end if;

  -- The files that are still there to see.
  v_keys := array(
    select k from unnest(v_c.object_keys) k
    where not (internal.capture_part(k) = 'webcam' and v_c.webcam_deleted_at is not null)
      and not (internal.capture_part(k) = 'screen' and v_c.screen_deleted_at is not null)
  );

  perform internal.audit(v_c.org_id, v_me.id, 'capture.viewed', v_c.user_id,
    jsonb_build_object('checkin_id', v_c.id, 'objects', v_keys));

  v_retention := internal.image_retention_days(
    (select o.policy from public.orgs o where o.id = v_c.org_id));

  -- The app in front when the card was answered (#25), if sampled and not removed.
  select a.app_name, a.domain into v_app
  from public.activity_samples a
  where a.user_id = v_c.user_id
    and a.minute = date_trunc('minute', coalesce(v_c.responded_at, v_c.scheduled_at))
    and v_c.apps_deleted_at is null
  order by a.seconds desc
  limit 1;

  return jsonb_build_object(
    'checkin_id', v_c.id,
    'user_id', v_c.user_id,
    'scheduled_at', v_c.scheduled_at,
    'responded_at', v_c.responded_at,
    'project_id', v_c.project_id,
    'app', v_app.app_name,
    'domain', case when v_c.domains_deleted_at is null then v_app.domain end,
    'capture_errors', v_c.capture_errors,
    -- Deleted by retention-purge, or past retention and about to be: don't sign anything.
    'expired', v_c.captures_purged_at is not null
      or v_c.scheduled_at < now() - make_interval(days => v_retention),
    'removed', jsonb_build_object(
      'webcam', v_c.webcam_deleted_at, 'screen', v_c.screen_deleted_at,
      'apps', v_c.apps_deleted_at, 'domains', v_c.domains_deleted_at),
    'objects', coalesce((
      select jsonb_agg(jsonb_build_object(
        'name', name,
        'path', internal.capture_path(v_c.org_id, v_c.user_id, v_c.scheduled_at, v_c.id, name)
      ) order by name)
      from unnest(v_keys) as name
    ), '[]'::jsonb)
  );
end;
$$;

-- Activity that arrives after a removal ------------------------------------------------------

-- The minute's app_session may sync after the employee removed the check-in's apps or
-- domains: it is accepted (the agent can forget it) but not kept, or kept without the
-- domain and title. Otherwise unchanged from 20261020153000_monitoring_notice.sql.
create or replace function internal.record_activity(
  p_device public.devices,
  p_event_id uuid,
  p_payload jsonb
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_start timestamptz := (p_payload ->> 'start')::timestamptz;
  v_end timestamptz := (p_payload ->> 'end')::timestamptz;
  v_minute timestamptz := date_trunc('minute', v_start);
  v_seconds int := round(extract(epoch from v_end - v_start))::int;
  v_policy jsonb := internal.effective_collection(p_device.user_id);
  v_app text := p_payload ->> 'app';
  v_title text := nullif(p_payload ->> 'title', '');
  v_domain text := nullif(lower(p_payload ->> 'domain'), '');
  v_removed record;
begin
  -- One bucket: inside a single minute, at least a second long.
  if v_end < v_start or v_end > v_minute + interval '1 minute' or v_seconds < 1 then
    return 'invalid_app_session';
  end if;
  -- ACT-01: only time spent working, never on a break or pause.
  if not exists (
    select 1 from public.clock_sessions cs
    where cs.user_id = p_device.user_id and cs.start_at <= v_start
      and coalesce(cs.end_at, 'infinity') >= v_end
  ) or exists (
    select 1 from public.breaks b
    where b.user_id = p_device.user_id and b.start_at < v_end and coalesce(b.end_at, 'infinity') > v_start
  ) or exists (
    select 1 from public.pauses p
    where p.user_id = p_device.user_id and p.start_at < v_end and coalesce(p.end_at, 'infinity') > v_start
  ) then
    return 'not_working';
  end if;
  -- Activity sampling off for this person (AGT-05): accepted, not stored.
  if not (v_policy ->> 'activity_sampling')::boolean then
    return null;
  end if;
  -- #253: removed by the employee for the check-in of this minute.
  select * into v_removed from internal.minute_parts_removed(p_device.user_id, v_minute);
  if v_removed.apps then
    return null;
  end if;
  if v_removed.domains and v_domain is not null then
    v_domain := null;
    v_title := null;
  end if;
  if not (v_policy ->> 'window_titles')::boolean
    or exists (
      select 1 from jsonb_array_elements_text(v_policy -> 'excluded_apps') e
      where lower(e) = lower(v_app)
    )
  then
    v_title := null;
  end if;
  perform internal.ensure_weekly_partitions('public.activity_samples', v_minute, v_minute);
  insert into public.activity_samples (
    id, org_id, user_id, device_id, minute, app_name, window_title, domain, seconds
  )
  values (
    p_event_id, p_device.org_id, p_device.user_id, p_device.id, v_minute, v_app, v_title,
    v_domain, least(v_seconds, 60)
  )
  on conflict do nothing;
  return null;
end;
$$;

-- The raw app_session event of such a minute is stored without what was removed (the
-- sync keeps every accepted event, for its acknowledgement and deduplication).
create function internal.strip_removed_app_session()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_start timestamptz;
  v_removed record;
begin
  begin
    v_start := (new.payload ->> 'start')::timestamptz;
  exception when others then
    return new;
  end;
  if v_start is null then
    return new;
  end if;
  select * into v_removed from internal.minute_parts_removed(new.user_id, date_trunc('minute', v_start));
  if v_removed.apps then
    new.payload := new.payload - 'app' - 'title' - 'domain';
  elsif v_removed.domains and nullif(new.payload ->> 'domain', '') is not null then
    new.payload := new.payload - 'title' - 'domain';
  end if;
  return new;
end;
$$;

revoke all on function internal.strip_removed_app_session() from public, anon, authenticated;

create trigger agent_events_raw_strip_removed
before insert on public.agent_events_raw
for each row when (new.type = 'app_session')
execute function internal.strip_removed_app_session();
