-- #51: retention purge and partition maintenance (ADM-03, ADM-04, AUD-03).
--
-- Settings live in orgs.policy (jsonb); anything missing, not a number or out of
-- range falls back to the default or is clamped, so a bad value can never purge
-- more than the range allows:
--   image_retention_days      30 (7-90)    capture files in Storage          ADM-03
--   event_retention_months    12 (3-36)    check-ins, raw events, activity
--                                          samples, status periods           ADM-03
--   timesheet_retention_years  3 (3-10)    shift records (clock sessions,
--                                          breaks, pauses); timesheets and
--                                          segments join them when they land ADM-03
-- The audit log is never purged, whatever the policy says (AUD-03): nothing here
-- touches it and no role gets a delete grant on it.
--
-- Two nightly/weekly jobs (LLD pg_cron table):
--   retention   02:00 UTC daily    pg_net calls the retention-purge Edge Function,
--                                  which deletes expired capture files through the
--                                  Storage API, then calls retention_purge_rows
--   partitions  Mondays 03:00 UTC  pure SQL: creates the next weekly partitions and
--                                  drops the ones past every org's event retention
-- Every purge is counted in retention_runs, and per org in audit_log
-- (retention.purged, no actor).

create extension if not exists pg_net;

-- Settings ---------------------------------------------------------------------------

-- A policy number clamped to [p_min, p_max]; p_default when absent or not a number.
create function internal.policy_int(p_policy jsonb, p_key text, p_default int, p_min int, p_max int)
returns int
language sql
immutable
set search_path = ''
as $$
  select least(greatest(
    case when jsonb_typeof(p_policy -> p_key) = 'number'
      then floor((p_policy ->> p_key)::numeric)
      else p_default::numeric
    end, p_min::numeric), p_max::numeric)::int;
$$;

create function internal.image_retention_days(p_policy jsonb)
returns int
language sql
immutable
set search_path = ''
as $$ select internal.policy_int(p_policy, 'image_retention_days', 30, 7, 90) $$;

create function internal.event_retention_months(p_policy jsonb)
returns int
language sql
immutable
set search_path = ''
as $$ select internal.policy_int(p_policy, 'event_retention_months', 12, 3, 36) $$;

create function internal.timesheet_retention_years(p_policy jsonb)
returns int
language sql
immutable
set search_path = ''
as $$ select internal.policy_int(p_policy, 'timesheet_retention_years', 3, 3, 10) $$;

-- Where a capture lives in Storage (captures bucket layout, #24).
create function internal.capture_path(
  p_org_id uuid,
  p_user_id uuid,
  p_scheduled_at timestamptz,
  p_checkin_id uuid,
  p_name text
)
returns text
language sql
immutable
set search_path = ''
as $$
  select format('%s/%s/%s/%s/%s', p_org_id, p_user_id,
    to_char(p_scheduled_at at time zone 'UTC', 'YYYY-MM-DD'), p_checkin_id, p_name);
$$;

-- Log -------------------------------------------------------------------------------

create table public.retention_runs (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  -- Null for work that spans orgs (partitions created or dropped).
  org_id uuid references public.orgs (id) on delete cascade,
  -- captures (files) | partitions_created | partitions_dropped | the table purged
  category text not null,
  deleted bigint not null check (deleted > 0)
);

create index retention_runs_at_idx on public.retention_runs (at desc);
-- Read by the service role and migrations only until #52 decides who sees it.
alter table public.retention_runs enable row level security;

-- One row per non-zero count, and one audit row per org with the counts.
create function internal.log_retention(p_org_id uuid, p_counts jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_nonzero jsonb := coalesce((
    select jsonb_object_agg(key, value::bigint)
    from jsonb_each_text(p_counts)
    where value::bigint > 0
  ), '{}'::jsonb);
begin
  insert into public.retention_runs (org_id, category, deleted)
  select p_org_id, key, value::bigint from jsonb_each_text(v_nonzero);
  if p_org_id is not null and v_nonzero <> '{}'::jsonb then
    perform internal.audit(p_org_id, null, 'retention.purged', null, v_nonzero);
  end if;
end;
$$;

-- Capture files -------------------------------------------------------------------------

-- The check-in row keeps its object_keys (file names) and gets the purge time, so
-- the dashboard shows "deleted after the retention period" instead of a broken image.
alter table public.checkin_events add column captures_purged_at timestamptz;

-- Check-ins whose files are past their org's image retention and not yet deleted,
-- oldest first, with the Storage paths to delete. Called by retention-purge.
create function public.retention_expired_captures(p_limit int default 200)
returns table (checkin_id uuid, paths text[])
language sql
stable
security definer
set search_path = ''
as $$
  select c.id,
    array(
      select internal.capture_path(c.org_id, c.user_id, c.scheduled_at, c.id, k)
      from unnest(c.object_keys) k order by k
    )
  from public.checkin_events c
  join public.orgs o on o.id = c.org_id
  where c.captures_purged_at is null
    and cardinality(c.object_keys) > 0
    and c.scheduled_at < now() - make_interval(days => internal.image_retention_days(o.policy))
  order by c.scheduled_at
  limit greatest(p_limit, 1);
$$;

-- Called after the files were deleted from Storage. Returns the number of files.
create function public.retention_mark_captures_purged(p_checkin_ids uuid[])
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
  v_total bigint := 0;
begin
  for r in
    with marked as (
      update public.checkin_events c
      set captures_purged_at = now()
      where c.id = any (p_checkin_ids) and c.captures_purged_at is null
      returning c.org_id, cardinality(c.object_keys) as files
    )
    select org_id, sum(files)::bigint as files from marked group by org_id
  loop
    perform internal.log_retention(r.org_id, jsonb_build_object('captures', r.files));
    v_total := v_total + r.files;
  end loop;
  return v_total;
end;
$$;

-- An upload can't land after its check-in's files were purged (it would stay
-- forever); otherwise unchanged from #24.
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
  );
end;
$$;

-- capture_view (#34) with the org's clamped retention and the purge marker. The
-- capture-url function signs nothing for an expired check-in; the dashboard shows
-- the files as deleted.
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

  v_retention := internal.image_retention_days(
    (select o.policy from public.orgs o where o.id = v_c.org_id));

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
    -- Deleted by retention-purge, or past retention and about to be: don't sign anything.
    'expired', v_c.captures_purged_at is not null
      or v_c.scheduled_at < now() - make_interval(days => v_retention),
    'objects', coalesce((
      select jsonb_agg(jsonb_build_object(
        'name', name,
        'path', internal.capture_path(v_c.org_id, v_c.user_id, v_c.scheduled_at, v_c.id, name)
      ) order by name)
      from unnest(v_c.object_keys) as name
    ), '[]'::jsonb)
  );
end;
$$;

-- Rows ------------------------------------------------------------------------------------

-- Deletes each org's expired rows by that org's settings and logs the counts.
-- Returns the totals per category. retention-purge calls it after the files are gone.
--
-- Partitioned tables (agent_events_raw, activity_samples): an org on the longest
-- event retention is left to the partitions job, which drops whole weeks; only orgs
-- on a shorter setting get row deletes here.
create function public.retention_purge_rows()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  o record;
  n bigint;
  v_counts jsonb;
  v_from bigint := coalesce((select max(id) from public.retention_runs), 0);
  v_longest timestamptz := now() - make_interval(
    months => coalesce((select max(internal.event_retention_months(policy)) from public.orgs), 12));
  v_events timestamptz;
  v_timesheets timestamptz;
begin
  for o in select id, policy from public.orgs loop
    v_events := now() - make_interval(months => internal.event_retention_months(o.policy));
    v_timesheets := now() - make_interval(years => internal.timesheet_retention_years(o.policy));
    v_counts := '{}'::jsonb;

    if v_events > v_longest then
      delete from public.agent_events_raw where org_id = o.id and at < v_events;
      get diagnostics n = row_count;
      v_counts := v_counts || jsonb_build_object('agent_events_raw', n);
      delete from public.activity_samples where org_id = o.id and minute < v_events;
      get diagnostics n = row_count;
      v_counts := v_counts || jsonb_build_object('activity_samples', n);
    end if;

    -- A check-in whose files are still in Storage stays until they are gone.
    delete from public.checkin_events
    where org_id = o.id and scheduled_at < v_events
      and (cardinality(object_keys) = 0 or captures_purged_at is not null);
    get diagnostics n = row_count;
    v_counts := v_counts || jsonb_build_object('checkin_events', n);

    -- Closed periods only: an open one is the user's current state.
    delete from public.status_periods
    where org_id = o.id and end_at is not null and end_at < v_events;
    get diagnostics n = row_count;
    v_counts := v_counts || jsonb_build_object('status_periods', n);

    delete from public.agent_event_rejections r
    using public.devices d
    where d.id = r.device_id and d.org_id = o.id and r.received_at < v_events;
    get diagnostics n = row_count;
    v_counts := v_counts || jsonb_build_object('agent_event_rejections', n);

    -- Shift records are what timesheets are built from, so they keep the
    -- timesheet window. Breaks and pauses go first for their own counts.
    delete from public.breaks b
    using public.clock_sessions s
    where s.id = b.clock_session_id and s.org_id = o.id
      and s.end_at is not null and s.end_at < v_timesheets;
    get diagnostics n = row_count;
    v_counts := v_counts || jsonb_build_object('breaks', n);
    delete from public.pauses p
    using public.clock_sessions s
    where s.id = p.clock_session_id and s.org_id = o.id
      and s.end_at is not null and s.end_at < v_timesheets;
    get diagnostics n = row_count;
    v_counts := v_counts || jsonb_build_object('pauses', n);
    delete from public.clock_sessions
    where org_id = o.id and end_at is not null and end_at < v_timesheets;
    get diagnostics n = row_count;
    v_counts := v_counts || jsonb_build_object('clock_sessions', n);

    -- TODO: time_segments, timesheets, timesheet_edits and manual_entries are not on
    -- main yet. Each gets a delete here by v_timesheets (their day / period end),
    -- children before parents, with its count added to v_counts.

    perform internal.log_retention(o.id, v_counts);
  end loop;

  return coalesce((
    select jsonb_object_agg(category, total)
    from (
      select category, sum(deleted)::bigint as total
      from public.retention_runs where id > v_from and org_id is not null
      group by category
    ) t
  ), '{}'::jsonb);
end;
$$;

-- Partitions ------------------------------------------------------------------------------

-- Creates last week through four weeks ahead (as the migrations that made the
-- tables did) and drops every partition that ends before the longest event
-- retention of any org: past that point no org can still need a row in it. Counts
-- the rows it drops, per org. Returns the numbers of partitions created and dropped.
create function internal.maintain_partitions()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cutoff timestamptz := now() - make_interval(
    months => coalesce((select max(internal.event_retention_months(policy)) from public.orgs), 12));
  t regclass;
  part record;
  r record;
  v_created int := 0;
  v_dropped int := 0;
begin
  foreach t in array array['public.agent_events_raw', 'public.activity_samples']::regclass[] loop
    v_created := v_created
      + internal.ensure_weekly_partitions(t, now() - interval '7 days', now() + interval '4 weeks');
    for part in
      select c.relname::text as name,
        to_date(right(c.relname::text, 8), 'YYYYMMDD')::timestamp at time zone 'UTC' as week_start
      from pg_inherits i
      join pg_class c on c.oid = i.inhrelid
      join pg_namespace n on n.oid = c.relnamespace
      where i.inhparent = t and n.nspname = 'partitions' and c.relname ~ '_p[0-9]{8}$'
    loop
      if part.week_start + interval '1 week' <= v_cutoff then
        for r in
          execute format('select org_id, count(*) as n from partitions.%I group by org_id', part.name)
        loop
          perform internal.log_retention(
            r.org_id, jsonb_build_object((select relname::text from pg_class where oid = t), r.n));
        end loop;
        execute format('drop table partitions.%I', part.name);
        v_dropped := v_dropped + 1;
      end if;
    end loop;
  end loop;

  perform internal.log_retention(null,
    jsonb_build_object('partitions_created', v_created, 'partitions_dropped', v_dropped));
  return jsonb_build_object('created', v_created, 'dropped', v_dropped);
end;
$$;

-- Scheduling -----------------------------------------------------------------------------

-- Calls the retention-purge Edge Function with the service role key. The project URL
-- and key are Vault secrets named project_url and service_role_key, set per
-- environment (never in migrations or the seed); a missing one fails the cron run,
-- which shows in cron.job_run_details.
create function internal.invoke_retention_purge()
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_url text := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url');
  v_key text := (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key');
begin
  if v_url is null or v_key is null then
    raise exception 'vault secrets project_url and service_role_key are not set';
  end if;
  return net.http_post(
    url := rtrim(v_url, '/') || '/functions/v1/retention-purge',
    headers := jsonb_build_object(
      'Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_key),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
end;
$$;

revoke all on function internal.policy_int(jsonb, text, int, int, int) from public, anon, authenticated;
revoke all on function internal.image_retention_days(jsonb) from public, anon, authenticated;
revoke all on function internal.event_retention_months(jsonb) from public, anon, authenticated;
revoke all on function internal.timesheet_retention_years(jsonb) from public, anon, authenticated;
revoke all on function internal.capture_path(uuid, uuid, timestamptz, uuid, text)
  from public, anon, authenticated;
revoke all on function internal.log_retention(uuid, jsonb) from public, anon, authenticated;
revoke all on function internal.maintain_partitions() from public, anon, authenticated;
revoke all on function internal.invoke_retention_purge() from public, anon, authenticated;

-- The job's own RPCs: service role only (the Edge Function), nobody through a user token.
revoke all on function public.retention_expired_captures(int) from public, anon, authenticated;
revoke all on function public.retention_mark_captures_purged(uuid[]) from public, anon, authenticated;
revoke all on function public.retention_purge_rows() from public, anon, authenticated;
grant execute on function public.retention_expired_captures(int) to service_role;
grant execute on function public.retention_mark_captures_purged(uuid[]) to service_role;
grant execute on function public.retention_purge_rows() to service_role;

select cron.schedule('retention', '0 2 * * *', 'select internal.invoke_retention_purge()');
select cron.schedule('partitions', '0 3 * * 1', 'select internal.maintain_partitions()');
