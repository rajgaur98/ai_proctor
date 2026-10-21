-- #67: late clock-ins recorded (SHF-06), top apps per employee (ACT-04) and the
-- managers' daily digest email (ALR-03).
--
-- Late clock-ins (SHF-06) ----------------------------------------------------------------
-- Until now a late clock-in was only computed: report_rows counts them from the current
-- shifts (so editing a shift rewrote history), and alert_eval raises an alert when
-- nobody has clocked in by the end of the grace. Now each one is stored in
-- late_clock_ins when the clock session is written (trigger on clock_sessions), with
-- the shift's start and the grace that applied then. The rule is report_rows':
--   a shift occurrence (shifts.days, the shift's own time zone; a shift past midnight
--   belongs to the day it starts on) is late when a clock session starts more than
--   late_clock_in_min (default 15, 5..60, the alert's setting) after the shift start
--   and before the shift ends, and no session covered the start (started by the end
--   of the grace and still open at the start).
-- One row per shift occurrence: the first late session. A session synced late that
-- covers the start removes the row (offline sessions arrive out of order). The alert
-- is unchanged. report_rows still computes its count (open PRs redefine it); the two
-- agree unless a shift was edited after the fact.
--
-- Top apps (ACT-04) ------------------------------------------------------------------------
-- top_apps: seconds per app name over a span (a day on the day page and My data), the
-- top N by time. Time only: no score, no category. Nothing when the person's effective
-- collection has activity sampling off (internal.effective_collection), and only for
-- people the caller may view (can_view_user, which includes themselves).
--
-- Daily digest (ALR-03) ---------------------------------------------------------------------
-- digest_eval runs every 15 minutes (pg_cron job `digest`). Each active person with at
-- least one direct report (users.manager_id) gets one email a day about yesterday in
-- their own time zone: per report, hours worked, flagged time, missed check-ins and late
-- clock-ins (seconds raw in the payload; the email rounds for display). It goes out from
-- 09:00 local (reminder_send_at on local midnight: the send window's start), and is not
-- sent after 18:00 local, so a stopped job never mails at night; the day is then skipped.
-- It waits up to two hours while a report's day is still queued for a rebuild
-- (dirty_days), so the numbers are final; after that it goes with what is stored.
-- Who:
--   * direct reports only. Active delegates do not get it (they get the alerts); an
--     owner or admin gets it only for their own direct reports.
--   * deactivated recipients get nothing. A deactivated report is listed only when
--     they have numbers for the day.
--   * a day where no report has anything (a weekend) sends nothing.
-- Opt-out per person: notification_prefs.daily_digest (default on; no row = on), set by
-- the person with set_daily_digest. Not an org policy key.
-- digests_sent keeps (recipient, day) so a manager gets at most one digest a day, and
-- records the empty days too so they are not looked at again.

-- Late clock-ins ------------------------------------------------------------------------------

create table public.late_clock_ins (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  user_id uuid not null references public.users (id) on delete cascade,
  -- The first session that started late for this shift occurrence.
  clock_session_id uuid not null references public.clock_sessions (id) on delete cascade,
  -- The shift's local start date (its own time zone).
  day date not null,
  shift_start timestamptz not null,
  clocked_in_at timestamptz not null,
  -- clocked_in_at - shift_start, whole seconds.
  late_s int not null check (late_s > 0),
  -- The grace (late_clock_in_min) that applied when it was recorded.
  grace_min int not null,
  created_at timestamptz not null default now(),
  constraint late_clock_ins_one_per_shift unique (user_id, shift_start)
);

create index late_clock_ins_user_day_idx on public.late_clock_ins (user_id, day);
alter table public.late_clock_ins enable row level security;

create policy "Visible per can_view_user"
on public.late_clock_ins for select to authenticated
using (org_id = (select internal.jwt_org_id()) and public.can_view_user(user_id));

revoke all on public.late_clock_ins from anon, authenticated;
grant select on public.late_clock_ins to authenticated;

-- Records (or clears) the late clock-ins one clock session decides.
create function internal.record_late_clock_in(p_session public.clock_sessions)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_grace int;
begin
  select internal.alert_policy_int(o.policy, 'late_clock_in_min', 15, 5, 60) into v_grace
  from public.orgs o where o.id = p_session.org_id;

  -- A session that covers a recorded shift start (it came in late, out of order) means
  -- the person was on time after all.
  delete from public.late_clock_ins l
  where l.user_id = p_session.user_id
    and l.clock_session_id <> p_session.id
    and p_session.start_at <= l.shift_start + make_interval(mins => l.grace_min)
    and coalesce(p_session.end_at, 'infinity'::timestamptz) > l.shift_start;

  insert into public.late_clock_ins (org_id, user_id, clock_session_id, day, shift_start,
    clocked_in_at, late_s, grace_min)
  select p_session.org_id, p_session.user_id, p_session.id, o.day, o.starts_at,
         p_session.start_at,
         floor(extract(epoch from p_session.start_at - o.starts_at))::int, v_grace
  from public.shifts s
  cross join lateral (
    select unnest(array[(p_session.start_at at time zone s.timezone)::date - 1,
                        (p_session.start_at at time zone s.timezone)::date]) as day
  ) d
  cross join lateral (
    select d.day,
           (d.day + s.start_time) at time zone s.timezone as starts_at,
           ((d.day + case when s.end_time <= s.start_time then 1 else 0 end) + s.end_time)
             at time zone s.timezone as ends_at
  ) o
  where s.user_id = p_session.user_id
    and extract(isodow from d.day)::int = any (s.days)
    and p_session.start_at > o.starts_at + make_interval(mins => v_grace)
    and p_session.start_at < o.ends_at
    and not exists (
      select 1 from public.clock_sessions cs
      where cs.user_id = p_session.user_id
        and cs.id <> p_session.id
        and cs.start_at <= o.starts_at + make_interval(mins => v_grace)
        and coalesce(cs.end_at, 'infinity'::timestamptz) > o.starts_at
    )
  on conflict on constraint late_clock_ins_one_per_shift do update
    set clock_session_id = excluded.clock_session_id,
        clocked_in_at = excluded.clocked_in_at,
        late_s = excluded.late_s
    where excluded.clocked_in_at < public.late_clock_ins.clocked_in_at;
end;
$$;

create function internal.clock_session_late_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform internal.record_late_clock_in(new);
  return null;
end;
$$;

create trigger clock_sessions_late
after insert on public.clock_sessions
for each row execute function internal.clock_session_late_trigger();

-- Sessions already stored, oldest first.
do $$
declare
  r public.clock_sessions;
begin
  for r in select * from public.clock_sessions order by start_at, id loop
    perform internal.record_late_clock_in(r);
  end loop;
end;
$$;

revoke all on function internal.record_late_clock_in(public.clock_sessions) from public, anon, authenticated;
revoke all on function internal.clock_session_late_trigger() from public, anon, authenticated;

-- Top apps -------------------------------------------------------------------------------------

-- The top p_limit apps by seconds over [p_from, p_to) (at most 31 days). Empty when the
-- caller may not view the person or the person's activity sampling is off.
create function public.top_apps(
  p_user_id uuid,
  p_from timestamptz,
  p_to timestamptz,
  p_limit int default 5
)
returns table (app_name text, seconds bigint)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_from is null or p_to is null or p_to <= p_from or p_to - p_from > interval '31 days' then
    raise exception 'invalid_range' using errcode = '22023';
  end if;
  if not public.can_view_user(p_user_id) then
    return;
  end if;
  if not coalesce((internal.effective_collection(p_user_id) ->> 'activity_sampling')::boolean, false) then
    return;
  end if;
  return query
    select s.app_name, sum(s.seconds)::bigint as seconds
    from public.activity_samples s
    where s.user_id = p_user_id and s.minute >= p_from and s.minute < p_to
    group by s.app_name
    order by sum(s.seconds) desc, s.app_name
    limit least(greatest(coalesce(p_limit, 5), 1), 20);
end;
$$;

revoke all on function public.top_apps(uuid, timestamptz, timestamptz, int) from public, anon;
grant execute on function public.top_apps(uuid, timestamptz, timestamptz, int) to authenticated;

-- Notification preferences -----------------------------------------------------------------------

create table public.notification_prefs (
  user_id uuid primary key references public.users (id) on delete cascade,
  org_id uuid not null references public.orgs (id) on delete cascade,
  -- The daily digest email (ALR-03). No row = on.
  daily_digest boolean not null default true,
  updated_at timestamptz not null default now()
);

alter table public.notification_prefs enable row level security;

create policy "Own preferences"
on public.notification_prefs for select to authenticated
using (user_id = (select auth.uid()));

revoke all on public.notification_prefs from anon, authenticated;
grant select on public.notification_prefs to authenticated;

-- The caller turns their daily digest on or off. Returns the new value.
create function public.set_daily_digest(p_enabled boolean)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me public.users := internal.current_app_user();
begin
  if p_enabled is null then
    raise exception 'invalid_value' using errcode = '22023';
  end if;
  insert into public.notification_prefs (user_id, org_id, daily_digest, updated_at)
  values (v_me.id, v_me.org_id, p_enabled, now())
  on conflict (user_id) do update
    set daily_digest = excluded.daily_digest, updated_at = excluded.updated_at;
  return p_enabled;
end;
$$;

revoke all on function public.set_daily_digest(boolean) from public, anon;
grant execute on function public.set_daily_digest(boolean) to authenticated;

-- Daily digest -------------------------------------------------------------------------------------

create table public.digests_sent (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  recipient_id uuid not null references public.users (id) on delete cascade,
  -- The day it is about (the recipient's yesterday).
  day date not null,
  -- Null when the day had nothing to report and no email was sent.
  email_id uuid references public.email_outbox (id) on delete set null,
  sent_at timestamptz not null default now(),
  constraint digests_sent_once unique (recipient_id, day)
);

alter table public.digests_sent enable row level security;
-- Internal bookkeeping: no policies, no grants.
revoke all on public.digests_sent from anon, authenticated;

-- One report line per direct report of p_manager_id for p_day (each report's own local
-- day), by name. Raw seconds; worked and flagged as report_rows adds them up.
create function internal.digest_rows(p_manager_id uuid, p_day date)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'user_id', x.id,
      'full_name', x.full_name,
      'worked_s', x.worked_s,
      'flagged_s', x.flagged_s,
      'misses', x.misses,
      'late_clock_ins', x.late
    ) order by x.full_name, x.id), '[]'::jsonb)
  from (
    select e.id, e.full_name, e.active, seg.worked_s, seg.flagged_s, chk.misses, late.n as late
    from public.users m
    join public.users e on e.manager_id = m.id and e.org_id = m.org_id and e.id <> m.id
    cross join lateral (
      select
        coalesce(round(sum(extract(epoch from t.end_at - t.start_at))
          filter (where t.counted and not t.excluded)), 0)::bigint as worked_s,
        coalesce(round(sum(extract(epoch from t.end_at - t.start_at))
          filter (where t.flagged and not t.excluded)), 0)::bigint as flagged_s
      from public.time_segments t
      where t.user_id = e.id and t.day = p_day
    ) seg
    cross join lateral (
      select count(*)::int as misses
      from public.checkin_events c
      where c.user_id = e.id and c.outcome::text = 'miss'
        and coalesce(c.shown_at, c.scheduled_at) >= p_day::timestamp at time zone e.timezone
        and coalesce(c.shown_at, c.scheduled_at) < (p_day + 1)::timestamp at time zone e.timezone
    ) chk
    cross join lateral (
      select count(*)::int as n
      from public.late_clock_ins l
      where l.user_id = e.id and l.day = p_day
    ) late
    where m.id = p_manager_id
  ) x
  where x.active or x.worked_s > 0 or x.flagged_s > 0 or x.misses > 0 or x.late > 0;
$$;

-- The evaluation (every 15 minutes). Returns the number of digests queued. `p_now` is for
-- tests; cron uses the default.
create function internal.digest_eval(p_now timestamptz default now())
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
  v_rows jsonb;
  v_email_id uuid;
  v_n int := 0;
begin
  -- A slow run must not overlap the next one.
  if not pg_try_advisory_xact_lock(hashtext('digest_eval')) then
    return 0;
  end if;

  for r in
    select m.id, m.org_id, m.email, m.full_name, m.timezone, l.today - 1 as day, s.send_at
    from public.users m
    cross join lateral (select (p_now at time zone m.timezone)::date as today) l
    cross join lateral (
      select internal.reminder_send_at(l.today::timestamp at time zone m.timezone, m.timezone) as send_at
    ) s
    where m.active
      and p_now >= s.send_at
      and (p_now at time zone m.timezone)::time < time '18:00'
      and coalesce((select np.daily_digest from public.notification_prefs np where np.user_id = m.id), true)
      and exists (
        select 1 from public.users e
        where e.manager_id = m.id and e.org_id = m.org_id and e.id <> m.id
      )
      and not exists (
        select 1 from public.digests_sent d where d.recipient_id = m.id and d.day = l.today - 1
      )
  loop
    -- Final numbers first: a report's day still waiting for its rebuild holds the digest,
    -- for up to two hours.
    continue when p_now < r.send_at + interval '2 hours' and exists (
      select 1 from public.dirty_days dd
      join public.users e on e.id = dd.user_id
      where e.manager_id = r.id and dd.day = r.day
    );

    v_rows := internal.digest_rows(r.id, r.day);
    v_email_id := null;
    if exists (
      select 1 from jsonb_array_elements(v_rows) x
      where (x ->> 'worked_s')::bigint > 0 or (x ->> 'flagged_s')::bigint > 0
         or (x ->> 'misses')::int > 0 or (x ->> 'late_clock_ins')::int > 0
    ) then
      insert into public.email_outbox (org_id, to_email, template, payload, batch_key, created_at, send_after)
      values (
        r.org_id, r.email, 'digest',
        jsonb_build_object(
          'recipient_name', r.full_name,
          'recipient_timezone', r.timezone,
          'day', r.day,
          'reports', v_rows
        ),
        'digest:' || r.id || ':' || r.day, p_now, p_now
      )
      returning id into v_email_id;
      v_n := v_n + 1;
    end if;
    insert into public.digests_sent (org_id, recipient_id, day, email_id, sent_at)
    values (r.org_id, r.id, r.day, v_email_id, p_now);
  end loop;

  return v_n;
end;
$$;

-- A person's data deletion (#54, internal.delete_user_data) removes the emails about them
-- by payload.employee_id; a digest names its reports in payload.reports instead, so the
-- digests that list the person go when their users row does. Their own digests (to their
-- address), their preference and their late clock-ins go with the deletion's other rows
-- and the cascades.
create function internal.users_digest_cleanup()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.email_outbox o
  where o.org_id = old.org_id and o.template = 'digest'
    and o.payload -> 'reports' @> jsonb_build_array(jsonb_build_object('user_id', old.id));
  return old;
end;
$$;

create trigger users_digest_cleanup
before delete on public.users
for each row execute function internal.users_digest_cleanup();

revoke all on function internal.digest_rows(uuid, date) from public, anon, authenticated;
revoke all on function internal.digest_eval(timestamptz) from public, anon, authenticated;
revoke all on function internal.users_digest_cleanup() from public, anon, authenticated;

select cron.schedule('digest', '*/15 * * * *', 'select internal.digest_eval()');
