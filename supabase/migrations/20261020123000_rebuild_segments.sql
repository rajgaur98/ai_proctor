-- #41: time_segments, dirty_days and the rebuild-segments plumbing (TS-01..06,
-- LLD section 06).
--
-- time_segments is derived data: the rebuild-segments Edge Function loads one
-- employee-day (segment_inputs), runs buildSegments() from packages/core, and
-- replaces that day's auto segments (replace_day_segments). Triggers on the source
-- tables mark the employee-local days they touch in dirty_days; a pg_cron job
-- (segments_kick, every 5 minutes) calls the function while any are left. The
-- dashboard can also ask for one day when it opens (the function checks
-- can_view_user).
--
-- Activity is not an input: activity_samples (#90) is already partitioned weekly,
-- and the engine doesn't read it.

create extension if not exists pg_net with schema extensions;

-- Tables ----------------------------------------------------------------------------

create table public.time_segments (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  user_id uuid not null references public.users (id) on delete cascade,
  -- The employee's local calendar day (users.timezone) the segment falls in.
  day date not null,
  start_at timestamptz not null,
  end_at timestamptz not null,
  -- SegmentType in packages/core/src/segments.ts.
  type text not null check (
    type in ('verified', 'meeting', 'idle', 'unverified', 'away', 'offline', 'pause',
             'pause_over_cap', 'break', 'manual')
  ),
  -- FK to projects is added with the projects table (#38).
  project_id uuid,
  -- Counted as worked time (TS-01); breaks only when the org pays them.
  counted boolean not null,
  -- Highlighted for the manager; never deducted automatically (TS-02).
  flagged boolean not null,
  -- Rebuilds replace 'auto' rows only. Everything buildSegments() returns is 'auto',
  -- including approved manual entries (#42) that it turns into 'manual'-type segments.
  source text not null default 'auto' check (source in ('auto', 'manual')),
  -- Manager exclusions (TS-10, #44): rebuilds delete and re-insert auto rows, so #44
  -- re-applies them from timesheet_edits.
  excluded boolean not null default false,
  excluded_reason text,
  excluded_by uuid references public.users (id) on delete set null,
  constraint time_segments_end_after_start check (end_at > start_at)
);

create index time_segments_user_day_idx on public.time_segments (user_id, day, start_at);
create index time_segments_org_day_idx on public.time_segments (org_id, day);
alter table public.time_segments enable row level security;

-- Same rule as status_periods. No write policies: only replace_day_segments writes.
create policy "Visible per can_view_user"
on public.time_segments for select to authenticated
using (org_id = (select internal.jwt_org_id()) and public.can_view_user(user_id));

-- Employee-days whose segments need rebuilding. Internal: RLS on, no policies, so
-- only the service role and the functions below touch it.
create table public.dirty_days (
  user_id uuid not null references public.users (id) on delete cascade,
  day date not null,
  marked_at timestamptz not null default clock_timestamp(),
  primary key (user_id, day)
);

create index dirty_days_marked_at_idx on public.dirty_days (marked_at);
alter table public.dirty_days enable row level security;
revoke all on public.dirty_days from anon, authenticated;

-- Marking ---------------------------------------------------------------------------

-- Marks every employee-local day in [p_from, p_to] (half open at the end, so a range
-- ending exactly at midnight doesn't touch the next day).
create function internal.mark_dirty(p_user_id uuid, p_from timestamptz, p_to timestamptz)
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
  insert into public.dirty_days (user_id, day, marked_at)
  select p_user_id, d::date, clock_timestamp()
  from generate_series(v_first, v_last, interval '1 day') d
  on conflict (user_id, day) do update set marked_at = excluded.marked_at;
end;
$$;

-- clock_sessions, breaks, pauses, status_periods: a row spans start_at..end_at, or
-- up to now while it's open. An update marks the old range too (a session that just
-- closed no longer covers the days after it).
create function internal.mark_dirty_interval()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and (old.start_at, old.end_at) is distinct from (new.start_at, new.end_at) then
    perform internal.mark_dirty(old.user_id, old.start_at, coalesce(old.end_at, clock_timestamp()));
  end if;
  perform internal.mark_dirty(new.user_id, new.start_at, coalesce(new.end_at, clock_timestamp()));
  return null;
end;
$$;

-- A check-in counts from when its card was shown (TS-01).
create function internal.mark_dirty_checkin()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    perform internal.mark_dirty(old.user_id, coalesce(old.shown_at, old.scheduled_at),
      coalesce(old.shown_at, old.scheduled_at));
  end if;
  perform internal.mark_dirty(new.user_id, coalesce(new.shown_at, new.scheduled_at),
    coalesce(new.shown_at, new.scheduled_at));
  return null;
end;
$$;

-- A project switch applies from its moment to the end of the clock session it
-- happened in, which may run on into later days.
create function internal.mark_dirty_project_switch()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform internal.mark_dirty(new.user_id, new.at, coalesce(
    (select coalesce(cs.end_at, clock_timestamp())
     from public.clock_sessions cs
     where cs.user_id = new.user_id and cs.start_at <= new.at
       and (cs.end_at is null or cs.end_at > new.at)
     order by cs.start_at desc
     limit 1),
    new.at));
  return null;
end;
$$;

create trigger clock_sessions_mark_dirty
after insert or update on public.clock_sessions
for each row execute function internal.mark_dirty_interval();

create trigger breaks_mark_dirty
after insert or update on public.breaks
for each row execute function internal.mark_dirty_interval();

create trigger pauses_mark_dirty
after insert or update on public.pauses
for each row execute function internal.mark_dirty_interval();

create trigger status_periods_mark_dirty
after insert or update on public.status_periods
for each row execute function internal.mark_dirty_interval();

create trigger checkin_events_mark_dirty
after insert or update on public.checkin_events
for each row execute function internal.mark_dirty_checkin();

-- agent_events_raw is partitioned; the trigger is cloned onto every partition,
-- including the weekly ones created later.
create trigger agent_events_raw_project_switch_mark_dirty
after insert on public.agent_events_raw
for each row when (new.type = 'project_switch')
execute function internal.mark_dirty_project_switch();

-- Locked days ------------------------------------------------------------------------

-- True when the employee-day sits in a submitted or approved timesheet, which a
-- rebuild must not touch (TS-11). There is no timesheets table yet: #43 replaces
-- this with the real check, and must mark the days dirty again when a week is
-- returned to draft (replace_day_segments drops the mark of a locked day).
create function internal.day_locked(p_user_id uuid, p_day date)
returns boolean
language sql
stable
set search_path = ''
as $$ select false $$;

-- Rebuild ---------------------------------------------------------------------------

-- The start of an employee-local day, as an instant.
create function internal.local_day_start(p_user_id uuid, p_day date)
returns timestamptz
language sql
stable
set search_path = ''
as $$
  select p_day::timestamp at time zone u.timezone from public.users u where u.id = p_user_id;
$$;

-- Everything buildSegments() needs for one employee-day, as DayInput (camelCase,
-- whole Unix seconds), wrapped as { input, loaded_at }. loaded_at is the instant the
-- facts were read: replace_day_segments only clears the dirty mark if nothing
-- re-marked the day after it.
--
-- Facts from before the day that still matter come along: sessions, breaks, pauses
-- and status periods that overlap the day, and the check-ins and project switches
-- since the earliest of those sessions began (an unverified stretch or a project
-- carries over midnight; the previous shift's don't).
create function public.segment_inputs(p_user_id uuid, p_day date)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user public.users;
  v_now timestamptz := clock_timestamp();
  v_start timestamptz;
  v_end timestamptz;
  v_from timestamptz;
  v_policy jsonb;
begin
  select * into v_user from public.users u where u.id = p_user_id;
  if not found then
    raise exception 'user_not_found' using errcode = '22023';
  end if;
  v_start := p_day::timestamp at time zone v_user.timezone;
  v_end := (p_day + 1)::timestamp at time zone v_user.timezone;
  select least(v_start, min(cs.start_at)) into v_from
  from public.clock_sessions cs
  where cs.user_id = p_user_id and cs.start_at < v_end and coalesce(cs.end_at, v_now) > v_start;
  v_from := coalesce(v_from, v_start);
  select o.policy into v_policy from public.orgs o where o.id = v_user.org_id;

  return jsonb_build_object(
    'loaded_at', v_now,
    'input', jsonb_build_object(
      'day', jsonb_build_object(
        'start', floor(extract(epoch from v_start))::bigint,
        'end', floor(extract(epoch from v_end))::bigint
      ),
      'now', floor(extract(epoch from v_now))::bigint,
      'clockSessions', coalesce((
        select jsonb_agg(jsonb_build_object(
          'start', floor(extract(epoch from cs.start_at))::bigint,
          'end', floor(extract(epoch from cs.end_at))::bigint,
          'projectId', cs.project_id) order by cs.start_at)
        from public.clock_sessions cs
        where cs.user_id = p_user_id and cs.start_at < v_end and coalesce(cs.end_at, v_now) > v_start
      ), '[]'::jsonb),
      -- manual_entries (approved only, TS-08) arrives with #42.
      'manualEntries', '[]'::jsonb,
      'breaks', coalesce((
        select jsonb_agg(jsonb_build_object(
          'start', floor(extract(epoch from b.start_at))::bigint,
          'end', floor(extract(epoch from b.end_at))::bigint) order by b.start_at)
        from public.breaks b
        where b.user_id = p_user_id and b.start_at < v_end and coalesce(b.end_at, v_now) > v_start
      ), '[]'::jsonb),
      'pauses', coalesce((
        select jsonb_agg(jsonb_build_object(
          'start', floor(extract(epoch from p.start_at))::bigint,
          'end', floor(extract(epoch from p.end_at))::bigint) order by p.start_at)
        from public.pauses p
        where p.user_id = p_user_id and p.start_at < v_end and coalesce(p.end_at, v_now) > v_start
      ), '[]'::jsonb),
      'statusPeriods', coalesce((
        select jsonb_agg(jsonb_build_object(
          'status', sp.status,
          'start', floor(extract(epoch from sp.start_at))::bigint,
          'end', floor(extract(epoch from sp.end_at))::bigint) order by sp.start_at)
        from public.status_periods sp
        where sp.user_id = p_user_id and sp.start_at < v_end and coalesce(sp.end_at, v_now) > v_start
      ), '[]'::jsonb),
      'checkins', coalesce((
        select jsonb_agg(jsonb_build_object(
          'at', floor(extract(epoch from coalesce(c.shown_at, c.scheduled_at)))::bigint,
          'outcome', c.outcome) order by coalesce(c.shown_at, c.scheduled_at))
        from public.checkin_events c
        where c.user_id = p_user_id
          and coalesce(c.shown_at, c.scheduled_at) >= v_from
          and coalesce(c.shown_at, c.scheduled_at) < v_end
      ), '[]'::jsonb),
      'projectSwitches', coalesce((
        select jsonb_agg(jsonb_build_object(
          'at', floor(extract(epoch from r.at))::bigint,
          'projectId', nullif(r.payload ->> 'project_id', '')) order by r.at, r.seq)
        from public.agent_events_raw r
        where r.user_id = p_user_id and r.type = 'project_switch' and r.at >= v_from and r.at < v_end
      ), '[]'::jsonb),
      -- Employee re-assignments of a draft week (PRJ-04) arrive with #38/#44.
      'projectEdits', '[]'::jsonb,
      'policy', jsonb_build_object(
        'breaksPaid', coalesce((v_policy ->> 'breaks_paid')::boolean, false),
        -- BRK-06 defaults: 15 minutes per pause, 60 per day.
        'pauseMaxS', coalesce((v_policy ->> 'pause_max_min')::int, 15) * 60,
        'pauseDailyMaxS', coalesce((v_policy ->> 'pause_daily_max_min')::int, 60) * 60
      )
    )
  );
end;
$$;

-- Replaces the day's auto segments with `p_segments` (an array of
-- { start, end (Unix seconds), type, project_id, counted, flagged }) and clears the
-- day's dirty mark, in one transaction under an advisory lock on (user, day). A
-- locked day is left alone and returns null (its mark is dropped too: nothing to
-- rebuild until it's unlocked). Otherwise returns how many segments were written.
create function internal.replace_day_segments(
  p_user_id uuid,
  p_day date,
  p_segments jsonb,
  p_loaded_at timestamptz default clock_timestamp()
)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid;
  v_start timestamptz;
  v_end timestamptz;
  v_n int;
begin
  select u.org_id into v_org from public.users u where u.id = p_user_id;
  if v_org is null then
    raise exception 'user_not_found' using errcode = '22023';
  end if;
  if jsonb_typeof(p_segments) is distinct from 'array' then
    raise exception 'segments_not_array' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtext(p_user_id::text || p_day::text));

  if internal.day_locked(p_user_id, p_day) then
    delete from public.dirty_days d where d.user_id = p_user_id and d.day = p_day;
    return null;
  end if;

  v_start := internal.local_day_start(p_user_id, p_day);
  v_end := internal.local_day_start(p_user_id, p_day + 1);

  delete from public.time_segments t
  where t.user_id = p_user_id and t.day = p_day and t.source = 'auto';

  insert into public.time_segments (
    org_id, user_id, day, start_at, end_at, type, project_id, counted, flagged, source
  )
  select v_org, p_user_id, p_day, to_timestamp(s.start), to_timestamp(s."end"), s.type,
         s.project_id, s.counted, s.flagged, 'auto'
  from jsonb_to_recordset(p_segments) as s(
    start bigint, "end" bigint, type text, project_id uuid, counted boolean, flagged boolean
  );
  get diagnostics v_n = row_count;

  if exists (
    select 1 from public.time_segments t
    where t.user_id = p_user_id and t.day = p_day and t.source = 'auto'
      and (t.start_at < v_start or t.end_at > v_end)
  ) then
    raise exception 'segment_outside_day' using errcode = '22023';
  end if;

  delete from public.dirty_days d
  where d.user_id = p_user_id and d.day = p_day and d.marked_at <= p_loaded_at;
  return v_n;
end;
$$;

-- What the Edge Function calls (service role only; it holds no user session for a
-- cron run).
create function public.replace_day_segments(
  p_user_id uuid,
  p_day date,
  p_segments jsonb,
  p_loaded_at timestamptz default clock_timestamp()
)
returns int
language sql
security definer
set search_path = ''
as $$ select internal.replace_day_segments(p_user_id, p_day, p_segments, p_loaded_at) $$;

-- Cron -------------------------------------------------------------------------------

-- Every 5 minutes: when days are waiting, ask rebuild-segments to work through them.
-- The project URL and the service-role key come from Vault (names project_url and
-- service_role_key), set once per environment: `scripts/stack-secrets.sh` locally,
-- at deploy in production (M6). Never put a key in a migration or the seed. Without
-- both secrets this does nothing.
create function internal.segments_kick()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_url text;
  v_key text;
begin
  if not exists (select 1 from public.dirty_days) then
    return;
  end if;
  select s.decrypted_secret into v_url from vault.decrypted_secrets s where s.name = 'project_url';
  select s.decrypted_secret into v_key from vault.decrypted_secrets s where s.name = 'service_role_key';
  if coalesce(v_url, '') = '' or coalesce(v_key, '') = '' then
    return;
  end if;
  perform net.http_post(
    url := rtrim(v_url, '/') || '/functions/v1/rebuild-segments',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || v_key
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  );
end;
$$;

revoke all on function internal.mark_dirty(uuid, timestamptz, timestamptz) from public, anon, authenticated;
revoke all on function internal.mark_dirty_interval() from public, anon, authenticated;
revoke all on function internal.mark_dirty_checkin() from public, anon, authenticated;
revoke all on function internal.mark_dirty_project_switch() from public, anon, authenticated;
revoke all on function internal.day_locked(uuid, date) from public, anon, authenticated;
revoke all on function internal.local_day_start(uuid, date) from public, anon, authenticated;
revoke all on function internal.replace_day_segments(uuid, date, jsonb, timestamptz) from public, anon, authenticated;
revoke all on function internal.segments_kick() from public, anon, authenticated;
revoke all on function public.segment_inputs(uuid, date) from public, anon, authenticated;
revoke all on function public.replace_day_segments(uuid, date, jsonb, timestamptz) from public, anon, authenticated;
grant execute on function public.segment_inputs(uuid, date) to service_role;
grant execute on function public.replace_day_segments(uuid, date, jsonb, timestamptz) to service_role;

select cron.schedule('segments_kick', '*/5 * * * *', 'select internal.segments_kick()');
