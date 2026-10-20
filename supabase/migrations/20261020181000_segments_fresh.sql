-- #126: keep segments fresh, and keep a failing day from starving the queue (TS-01,
-- BRK-06). Follow-ups from #41's rebuild-segments plumbing and #36's pause caps.
--
-- 1. Open days. A clocked-in day with no new rows was never re-marked, so its
--    segments stopped at the last rebuild (and the last stretch before midnight was
--    never closed out). segments_kick now marks the employee-local days of every open
--    clock session dirty first, unless the day was rebuilt in the last 4 minutes
--    (kicks are 5 minutes apart; the margin covers cron jitter and rebuild time) or
--    sits in an approved week (day_locked: a rebuild would only drop the mark again).
--    A past day is final once it has been rebuilt after it ended.
--
-- 2. Poison pill. dirty_days gets attempts / last_error / next_attempt_at. The
--    function takes days whose next_attempt_at has passed, oldest first
--    (due_segment_days); a failure goes through record_segment_failure, which backs
--    off 5 min x 2^attempts up to 6 h. A day is never dropped: after the 8th failure
--    the wait is the 6 h cap, so it keeps retrying every 6 h until it works or a
--    fact resets it. A new fact for the day (mark_dirty) resets attempts. Days with 3
--    or more failures are listed for admins by stuck_segment_days().
--    TODO(M6): report days that reach 10 attempts to Sentry once it is set up.
--
-- 3. Pauses across midnight (BRK-06). close_pause now splits a pause at the
--    employee's local midnight, like buildSegments() (packages/core/src/segments.ts,
--    splitPauses):
--      - the per-pause cap P covers the whole pause: only its first P seconds
--        (from its start, whichever day they fall on) are eligible to count;
--      - the daily cap D is per local day: on each day the eligible time counts while
--        that day's counted pause time stays under D.
--    Why anchored at the start: a day's answer then depends only on that day's own
--    pauses and the pauses' starts, never on what another day counted, which is what
--    lets buildSegments() rebuild one day from one day's facts. It also makes
--    "counted so far that day" a closed form: with pauses taken in start order,
--    counted(day) = min(D, sum of each pause's eligible seconds on that day), so
--    close_pause needs no per-day bookkeeping on the row.
--    For a pause of d seconds, C(x) the other pauses' eligible seconds on day x and
--    e(x) this pause's eligible seconds on day x:
--      counted  = sum over days x of min(e(x), max(0, D - C(x)))
--      over_cap = d - counted
--    A pause inside one day gives the same numbers as before:
--    min(d, P, max(0, D - C)). pauses.over_cap_s stays the whole pause's total.
--    Seconds are whole Unix seconds (floor of each timestamp), as in segment_inputs.

-- Queue columns ---------------------------------------------------------------------

alter table public.dirty_days
  add column attempts int not null default 0 check (attempts >= 0),
  add column last_error text,
  add column next_attempt_at timestamptz not null default clock_timestamp();

-- Rows already queued are due now, in the order they were marked.
update public.dirty_days set next_attempt_at = marked_at;

create index dirty_days_next_attempt_idx on public.dirty_days (next_attempt_at);

-- When each employee-day was last rebuilt (the kick uses it to rate-limit and to see
-- that a past day is final). Internal, like dirty_days.
create table internal.segment_rebuilds (
  user_id uuid not null references public.users (id) on delete cascade,
  day date not null,
  rebuilt_at timestamptz not null,
  primary key (user_id, day)
);

alter table internal.segment_rebuilds enable row level security;
revoke all on internal.segment_rebuilds from public, anon, authenticated;

-- Marking (replaces #41's version: a new fact resets the backoff) ------------------------

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
  insert into public.dirty_days (user_id, day, marked_at, next_attempt_at)
  select p_user_id, d::date, clock_timestamp(), clock_timestamp()
  from generate_series(v_first, v_last, interval '1 day') d
  on conflict (user_id, day) do update
    set marked_at = excluded.marked_at,
        attempts = 0,
        next_attempt_at = excluded.next_attempt_at;
end;
$$;

-- Open days -------------------------------------------------------------------------

-- Marks the employee-local days of every open clock session dirty, from the day it
-- started to today, for days that need it: never rebuilt, or rebuilt before the day
-- ended and more than p_min_age ago. Locked days and days already queued are left
-- alone (a queued day keeps its attempts and backoff: this is not a new fact).
-- Returns how many days it queued.
create function internal.mark_open_days(p_min_age interval default interval '4 minutes')
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_n int;
begin
  insert into public.dirty_days (user_id, day, marked_at, next_attempt_at)
  select s.user_id, d::date, v_now, v_now
  from (
    select cs.user_id, cs.start_at, u.timezone
    from public.clock_sessions cs
    join public.users u on u.id = cs.user_id
    where cs.end_at is null and u.active
  ) s
  cross join lateral generate_series(
    (s.start_at at time zone s.timezone)::date,
    (v_now at time zone s.timezone)::date,
    interval '1 day'
  ) d
  where not internal.day_locked(s.user_id, d::date)
    and not exists (
      select 1 from internal.segment_rebuilds r
      where r.user_id = s.user_id and r.day = d::date
        and (r.rebuilt_at > v_now - p_min_age
             or r.rebuilt_at >= ((d::date + 1)::timestamp at time zone s.timezone))
    )
  on conflict (user_id, day) do nothing;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- Rebuild (replaces #43's version: records when the day was rebuilt) ----------------------

-- Replaces the day's auto segments with `p_segments` (an array of
-- { start, end (Unix seconds), type, project_id, counted, flagged }) and clears the
-- day's dirty mark, in one transaction under an advisory lock on (user, day). A
-- locked day (approved week) is left alone and returns null (its mark is dropped too:
-- reopening or returning the week marks it again). Otherwise re-applies the manager's
-- exclusions to the new rows, notes the rebuild time and returns how many segments
-- were written.
create or replace function internal.replace_day_segments(
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

  perform internal.apply_decisions(p_user_id, v_start, v_end);

  insert into internal.segment_rebuilds (user_id, day, rebuilt_at)
  values (p_user_id, p_day, clock_timestamp())
  on conflict (user_id, day) do update set rebuilt_at = excluded.rebuilt_at;

  delete from public.dirty_days d
  where d.user_id = p_user_id and d.day = p_day and d.marked_at <= p_loaded_at;
  return v_n;
end;
$$;

-- The queue and its failures (service role: the Edge Function) ----------------------------

-- The days to rebuild now: next_attempt_at has passed, oldest first. A day that keeps
-- failing waits out its backoff instead of sitting at the front. picked_at is the
-- database clock when they were picked, for record_segment_failure's p_started_at.
create function public.due_segment_days(p_limit int default 50)
returns table (user_id uuid, day date, picked_at timestamptz)
language sql
volatile
security definer
set search_path = ''
as $$
  select d.user_id, d.day, clock_timestamp()
  from public.dirty_days d
  where d.next_attempt_at <= clock_timestamp()
  order by d.next_attempt_at, d.marked_at
  limit greatest(1, least(coalesce(p_limit, 50), 200));
$$;

-- A rebuild of the day failed: keep the error, count the attempt and back off,
-- 5 min x 2^attempts, at most 6 h. p_started_at is when this attempt began: a fact
-- marked since then is new, so the day stays due and nothing is recorded.
create function public.record_segment_failure(
  p_user_id uuid,
  p_day date,
  p_error text,
  p_started_at timestamptz default null
)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.dirty_days d
  set attempts = d.attempts + 1,
      last_error = left(coalesce(p_error, ''), 1000),
      next_attempt_at = clock_timestamp()
        + least(interval '6 hours', interval '5 minutes' * power(2, least(d.attempts, 10)))
  where d.user_id = p_user_id and d.day = p_day
    and (p_started_at is null or d.marked_at <= p_started_at);
$$;

-- Admin view of days that keep failing (3 or more attempts) in the caller's org, worst
-- first. Sentry isn't set up yet; this is where they surface until M6.
create function public.stuck_segment_days()
returns table (
  user_id uuid,
  full_name text,
  email text,
  day date,
  attempts int,
  last_error text,
  marked_at timestamptz,
  next_attempt_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_me public.users := internal.current_app_user();
begin
  if v_me.role not in ('owner', 'admin') then
    raise exception 'admin_only' using errcode = '42501';
  end if;
  return query
  select d.user_id, u.full_name, u.email, d.day, d.attempts, d.last_error, d.marked_at,
         d.next_attempt_at
  from public.dirty_days d
  join public.users u on u.id = d.user_id
  where u.org_id = v_me.org_id and d.attempts >= 3
  order by d.attempts desc, d.next_attempt_at, d.user_id, d.day;
end;
$$;

-- Cron -------------------------------------------------------------------------------

-- Every 5 minutes: queue the open days, then when days are due, ask rebuild-segments to
-- work through them. The project URL and the service-role key come from Vault (names
-- project_url and service_role_key), set once per environment:
-- `scripts/stack-secrets.sh` locally, at deploy in production (M6). Never put a key in
-- a migration or the seed. Without both secrets this only queues.
create or replace function internal.segments_kick()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_url text;
  v_key text;
begin
  perform internal.mark_open_days();
  if not exists (select 1 from public.dirty_days d where d.next_attempt_at <= clock_timestamp()) then
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

-- Closing a pause (replaces #36's version: split at local midnight) -----------------------

create or replace function internal.close_pause(p_pause_id uuid, p_end_at timestamptz)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_pause public.pauses;
  v_tz text;
  v_end timestamptz;
  v_per int;
  v_daily int;
  v_s bigint;
  v_e bigint;
  v_d int;
  v_day date;
  v_day_start timestamptz;
  v_day_end timestamptz;
  v_day_s bigint;
  v_day_e bigint;
  v_eligible int;
  v_others int;
  v_counted int := 0;
begin
  select * into v_pause from public.pauses where id = p_pause_id and end_at is null;
  if not found then return; end if;
  select u.timezone into v_tz from public.users u where u.id = v_pause.user_id;
  select pol.pause_max_min * 60, pol.pause_daily_max_min * 60 into v_per, v_daily
  from internal.break_pause_policy(v_pause.org_id) pol;

  v_end := greatest(v_pause.start_at, p_end_at);
  v_s := floor(extract(epoch from v_pause.start_at));
  v_e := floor(extract(epoch from v_end));
  v_d := (v_e - v_s)::int;

  -- One round per local day the pause touches (half open at the end, so a pause
  -- ending exactly at midnight doesn't touch the next day).
  for v_day in
    select d::date
    from generate_series(
      (v_pause.start_at at time zone v_tz)::date,
      (greatest(v_pause.start_at, v_end - interval '1 microsecond') at time zone v_tz)::date,
      interval '1 day'
    ) d
  loop
    v_day_start := v_day::timestamp at time zone v_tz;
    v_day_end := (v_day + 1)::timestamp at time zone v_tz;
    v_day_s := floor(extract(epoch from v_day_start));
    v_day_e := floor(extract(epoch from v_day_end));

    -- This pause's eligible seconds on the day: its first v_per seconds, clipped to it.
    v_eligible := greatest(0,
      least(v_s + least(v_d, v_per), v_day_e) - greatest(v_s, v_day_s))::int;

    -- The other pauses' eligible seconds on the day (the counted total so far is the
    -- smaller of that and the daily cap).
    select coalesce(sum(greatest(0,
      least(q.s + least(q.e - q.s, v_per), v_day_e) - greatest(q.s, v_day_s))), 0)::int
    into v_others
    from (
      select floor(extract(epoch from p.start_at))::bigint as s,
             floor(extract(epoch from p.end_at))::bigint as e
      from public.pauses p
      where p.user_id = v_pause.user_id and p.id <> v_pause.id and p.end_at is not null
        and p.start_at < v_day_end and p.end_at > v_day_start
    ) q;

    v_counted := v_counted + least(v_eligible, greatest(0, v_daily - v_others));
  end loop;

  update public.pauses set end_at = v_end, over_cap_s = v_d - v_counted where id = v_pause.id;
end;
$$;

-- Access ------------------------------------------------------------------------------

revoke all on function internal.mark_dirty(uuid, timestamptz, timestamptz) from public, anon, authenticated;
revoke all on function internal.mark_open_days(interval) from public, anon, authenticated;
revoke all on function internal.replace_day_segments(uuid, date, jsonb, timestamptz) from public, anon, authenticated;
revoke all on function internal.segments_kick() from public, anon, authenticated;
revoke all on function internal.close_pause(uuid, timestamptz) from public, anon, authenticated;
revoke all on function public.due_segment_days(int) from public, anon, authenticated;
revoke all on function public.record_segment_failure(uuid, date, text, timestamptz) from public, anon, authenticated;
revoke all on function public.stuck_segment_days() from public, anon;
grant execute on function public.due_segment_days(int) to service_role;
grant execute on function public.record_segment_failure(uuid, date, text, timestamptz) to service_role;
grant execute on function public.stuck_segment_days() to authenticated;
