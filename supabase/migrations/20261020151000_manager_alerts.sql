-- Manager alerts and email batching (#50; ALR-01, ALR-02).
--
-- alert_eval runs every minute (pg_cron, LLD jobs table) and writes `alerts` rows
-- for five conditions. Each alert goes to the employee's direct manager and to any
-- active delegate of that manager (one row per recipient). send_emails (also every
-- minute) calls the send-emails Edge Function when mail is waiting.
--
-- Org policy keys read here (orgs.policy; all optional; the settings page is #52).
-- Every kind has an enabled flag (default true: ALR-01 lists them as on). A kind
-- that is off raises no in-app alert and no email.
--   alert_consecutive_misses_enabled  boolean, default true
--   alert_consecutive_misses          int, default 3, clamped 1..10 (PRD section 6)
--   alert_offline_enabled             boolean, default true
--   alert_offline_min                 int, default 15, clamped 5..240: minutes in Offline
--                                     (status rule 3) during a shift before alerting
--   alert_tamper_enabled              boolean, default true
--   alert_late_clock_in_enabled       boolean, default true
--   late_clock_in_min           int, default 15, clamped 5..60 (PRD section 6; shared with reports, #47)
--   alert_pause_over_cap_enabled      boolean, default true
-- The pause cap itself is BRK-06's pause_daily_max_min (breaks_and_pause_caps).
--
-- Conditions (details are kept on the alert row):
--   consecutive_misses  The latest clock session has N or more check-ins in a row
--                       that were misses (a pass or a failed challenge ends the
--                       run; a new clock-in starts clean, as for status rule 7).
--                       Episode = the first miss of the run.
--   offline             presence.status is Offline, clocked in, and has been for
--                       alert_offline_min. Episode = when that Offline period began.
--   tamper              A Tamper status period (status rule 2), open or closed in
--                       the last hour. Episode = the status period.
--   late_clock_in       A shift's start plus the grace has passed, the shift is
--                       still running, and the person has no clock session that
--                       covered the start (open, or started within the grace).
--                       Only people with an active device. Episode = the shift's
--                       start. SHF-06 (recording late clock-ins) is #67; this
--                       alert doesn't wait for it.
--   pause_over_cap      The day's pauses (the open one counted up to now) add up to
--                       more than pause_daily_max_min, on the local day they
--                       started. Episode = that local date.
-- One condition raises one alert per episode (unique recipient/employee/kind/
-- episode), not one per minute. Conditions older than an hour when first seen are
-- not raised, so switching a kind on does not replay history.
--
-- Email batching (ALR-02): at most one email per recipient, employee and kind per
-- hour. When no email for that key was queued in the last hour, all of the key's
-- unemailed, unread alerts go out together in one email (the first alert is not
-- delayed). Alerts raised while the hour is running are held and folded into the
-- next email, queued by the first alert_eval run after the hour is over. Read
-- alerts need no email. A day-old alert is no longer emailed.

create type public.alert_kind as enum (
  'consecutive_misses',
  'offline',
  'tamper',
  'late_clock_in',
  'pause_over_cap'
);

-- Policy helpers ---------------------------------------------------------------------

create function internal.alert_policy_int(
  p_policy jsonb, p_key text, p_default int, p_min int, p_max int
)
returns int
language sql
immutable
set search_path = ''
as $$
  select least(greatest(
    case when jsonb_typeof(p_policy -> p_key) = 'number'
         then floor((p_policy ->> p_key)::numeric) else p_default end,
    p_min), p_max)::int;
$$;

create function internal.alert_enabled(p_policy jsonb, p_kind public.alert_kind)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select case
    when jsonb_typeof(p_policy -> ('alert_' || p_kind::text || '_enabled')) = 'boolean'
    then (p_policy ->> ('alert_' || p_kind::text || '_enabled'))::boolean
    else true
  end;
$$;

-- Tables ---------------------------------------------------------------------------------

create table public.email_outbox (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  to_email text not null,
  -- Picks the layout in the send-emails function; 'alert' for now.
  template text not null,
  payload jsonb not null default '{}'::jsonb,
  -- recipient:employee:kind for alerts; at most one per key per hour.
  batch_key text,
  created_at timestamptz not null default now(),
  -- Not picked up before this time: the retry backoff (1, 2, 4, 8 min) after a claim.
  send_after timestamptz not null default now(),
  sent_at timestamptz,
  -- Counted when the function claims the row. At 5 the row is given up on.
  attempts int not null default 0 check (attempts >= 0),
  last_error text
);

create index email_outbox_pending_idx on public.email_outbox (send_after) where sent_at is null;
create index email_outbox_batch_idx on public.email_outbox (batch_key, created_at desc);
alter table public.email_outbox enable row level security;
-- Service role only (the Edge Function, through the RPCs below): no policies, no grants.
revoke all on public.email_outbox from anon, authenticated;

create table public.alerts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  -- The employee the alert is about.
  user_id uuid not null references public.users (id) on delete cascade,
  -- Who gets it: the direct manager or an active delegate.
  recipient_id uuid not null references public.users (id) on delete cascade,
  kind public.alert_kind not null,
  -- What makes this occurrence one episode (see the header); the dedup key.
  episode text not null,
  details jsonb not null default '{}'::jsonb,
  triggered_at timestamptz not null default now(),
  read_at timestamptz,
  -- The email this alert went out in (or is waiting in); null = not queued.
  email_id uuid references public.email_outbox (id) on delete set null,
  constraint alerts_one_per_episode unique (recipient_id, user_id, kind, episode)
);

create index alerts_recipient_idx on public.alerts (recipient_id, triggered_at desc);
create index alerts_unread_idx on public.alerts (recipient_id) where read_at is null;
create index alerts_unemailed_idx on public.alerts (triggered_at) where email_id is null and read_at is null;
alter table public.alerts enable row level security;

-- Recipients read their alerts. Whoever can view the employee (their manager, a
-- delegate, owners and admins) reads them too, but not the employee: an alert is
-- the manager's, not part of the employee's own record.
create policy "Recipients and viewers read alerts"
on public.alerts for select to authenticated
using (
  org_id = (select internal.jwt_org_id())
  and (
    recipient_id = (select auth.uid())
    or (user_id <> (select auth.uid()) and public.can_view_user(user_id))
  )
);

revoke all on public.alerts from anon, authenticated;
grant select on public.alerts to authenticated;

-- A recipient marks their own alerts read: the ids given, or all when null.
create function public.mark_alerts_read(p_ids uuid[] default null)
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
    and (p_ids is null or a.id = any(p_ids));
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

revoke all on function public.mark_alerts_read(uuid[]) from public, anon;
grant execute on function public.mark_alerts_read(uuid[]) to authenticated;

-- Raising ---------------------------------------------------------------------------------

-- One alert per recipient for an episode; a repeat is ignored. Recipients: the direct
-- manager and the manager's active delegates, if active themselves. Returns the number
-- of new rows.
create function internal.raise_alert(
  p_user_id uuid,
  p_kind public.alert_kind,
  p_episode text,
  p_details jsonb,
  p_now timestamptz default now()
)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_n int;
begin
  with e as (
    select u.id, u.org_id, u.manager_id from public.users u where u.id = p_user_id and u.active
  ),
  recipients as (
    select e.manager_id as id from e where e.manager_id is not null
    union
    select d.delegate_id
    from e
    join public.delegations d on d.manager_id = e.manager_id
    where (p_now at time zone 'UTC')::date between d.starts_on and d.ends_on
  ),
  ins as (
    insert into public.alerts (org_id, user_id, recipient_id, kind, episode, details, triggered_at)
    select e.org_id, e.id, r.id, p_kind, p_episode, coalesce(p_details, '{}'::jsonb), p_now
    from e
    join recipients r on true
    join public.users ru on ru.id = r.id and ru.active and ru.org_id = e.org_id and ru.id <> e.id
    on conflict on constraint alerts_one_per_episode do nothing
    returning 1
  )
  select count(*) into v_n from ins;
  return v_n;
end;
$$;

-- The evaluation (every minute). Returns the number of alerts raised. `p_now` is for
-- tests; cron uses the default.
create function internal.alert_eval(p_now timestamptz default now())
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
  v_n int := 0;
  -- Conditions older than this when first seen are not raised.
  v_recent interval := interval '1 hour';
begin
  -- A slow run must not overlap the next one.
  if not pg_try_advisory_xact_lock(hashtext('alert_eval')) then
    return 0;
  end if;

  -- N consecutive misses -------------------------------------------------------------
  for r in
    select u.id as user_id, o.policy,
           run.misses, run.first_miss_id, run.first_miss_at, n.n as threshold
    from public.users u
    join public.orgs o on o.id = u.org_id
    cross join lateral (
      select internal.alert_policy_int(o.policy, 'alert_consecutive_misses', 3, 1, 10) as n
    ) n
    cross join lateral (
      select cs.start_at from public.clock_sessions cs
      where cs.user_id = u.id order by cs.start_at desc limit 1
    ) cs
    cross join lateral (
      with last_ok as (
        select max(c.scheduled_at) as at
        from public.checkin_events c
        where c.user_id = u.id and c.scheduled_at >= cs.start_at and c.outcome <> 'miss'
      ),
      misses as (
        select c.id, c.scheduled_at, c.created_at
        from public.checkin_events c, last_ok
        where c.user_id = u.id and c.scheduled_at >= cs.start_at and c.outcome = 'miss'
          and (last_ok.at is null or c.scheduled_at > last_ok.at)
      )
      select count(*)::int as misses,
             (array_agg(m.id order by m.scheduled_at))[1] as first_miss_id,
             min(m.scheduled_at) as first_miss_at,
             max(m.created_at) as last_seen_at
      from misses m
    ) run
    where u.active
      and internal.alert_enabled(o.policy, 'consecutive_misses')
      and run.misses >= n.n
      and run.last_seen_at > p_now - v_recent
  loop
    v_n := v_n + internal.raise_alert(r.user_id, 'consecutive_misses', r.first_miss_id::text,
      jsonb_build_object('misses', r.misses, 'threshold', r.threshold,
                         'first_miss_at', r.first_miss_at), p_now);
  end loop;

  -- Offline during a shift --------------------------------------------------------------
  for r in
    select p.user_id, p.since, m.minutes
    from public.presence p
    join public.users u on u.id = p.user_id
    join public.orgs o on o.id = u.org_id
    cross join lateral (
      select internal.alert_policy_int(o.policy, 'alert_offline_min', 15, 5, 240) as minutes
    ) m
    where p.status = 'offline' and u.active
      and internal.alert_enabled(o.policy, 'offline')
      and p.since <= p_now - make_interval(mins => m.minutes)
      and exists (
        select 1 from public.clock_sessions cs where cs.user_id = p.user_id and cs.end_at is null
      )
  loop
    v_n := v_n + internal.raise_alert(r.user_id, 'offline',
      (extract(epoch from r.since) * 1000000)::bigint::text,
      jsonb_build_object('since', r.since, 'threshold_min', r.minutes), p_now);
  end loop;

  -- Tamper -----------------------------------------------------------------------------
  for r in
    select sp.id, sp.user_id, sp.start_at, sp.end_at
    from public.status_periods sp
    join public.users u on u.id = sp.user_id
    join public.orgs o on o.id = u.org_id
    where sp.status = 'tamper' and u.active
      and internal.alert_enabled(o.policy, 'tamper')
      and (sp.end_at is null or sp.end_at > p_now - v_recent)
  loop
    v_n := v_n + internal.raise_alert(r.user_id, 'tamper', r.id::text,
      jsonb_build_object('since', r.start_at, 'until', r.end_at), p_now);
  end loop;

  -- Late clock-in -----------------------------------------------------------------------
  -- Shift occurrences that started today or yesterday in the shift's own time zone
  -- (a shift past midnight belongs to the day it starts on).
  for r in
    select u.id as user_id, g.grace, s.start_at
    from public.users u
    join public.orgs o on o.id = u.org_id
    join public.shifts sh on sh.user_id = u.id
    cross join lateral (
      select internal.alert_policy_int(o.policy, 'late_clock_in_min', 15, 5, 60) as grace
    ) g
    cross join lateral (
      select unnest(array[(p_now at time zone sh.timezone)::date - 1,
                          (p_now at time zone sh.timezone)::date]) as day
    ) d
    cross join lateral (
      select ((d.day + sh.start_time) at time zone sh.timezone) as start_at,
             (((d.day + case when sh.end_time < sh.start_time then 1 else 0 end) + sh.end_time)
                at time zone sh.timezone) as end_at
    ) s
    where u.active
      and internal.alert_enabled(o.policy, 'late_clock_in')
      and extract(isodow from d.day)::int = any (sh.days)
      and p_now >= s.start_at + make_interval(mins => g.grace)
      and p_now < s.end_at
      and exists (
        select 1 from public.devices dv where dv.user_id = u.id and dv.revoked_at is null
      )
      and not exists (
        select 1 from public.clock_sessions cs
        where cs.user_id = u.id
          and cs.start_at <= s.start_at + make_interval(mins => g.grace)
          and (cs.end_at is null or cs.end_at > s.start_at)
      )
  loop
    v_n := v_n + internal.raise_alert(r.user_id, 'late_clock_in',
      (extract(epoch from r.start_at) * 1000000)::bigint::text,
      jsonb_build_object('shift_start', r.start_at, 'grace_min', r.grace), p_now);
  end loop;

  -- Pause time over the daily cap ---------------------------------------------------------
  for r in
    select t.user_id, t.day, t.total_s, pol.pause_daily_max_min as cap_min
    from (
      select p.user_id, p.org_id,
             (p.start_at at time zone u.timezone)::date as day,
             sum(floor(extract(epoch from coalesce(p.end_at, p_now) - p.start_at)))::int as total_s
      from public.pauses p
      join public.users u on u.id = p.user_id
      where u.active
        and exists (
          select 1 from public.pauses recent
          where recent.user_id = p.user_id
            and coalesce(recent.end_at, p_now) > p_now - v_recent
            and (recent.start_at at time zone u.timezone)::date
              = (p.start_at at time zone u.timezone)::date
        )
      group by p.user_id, p.org_id, (p.start_at at time zone u.timezone)::date
    ) t
    join public.orgs o on o.id = t.org_id
    cross join lateral internal.break_pause_policy(t.org_id) pol
    where internal.alert_enabled(o.policy, 'pause_over_cap')
      and t.total_s > pol.pause_daily_max_min * 60
  loop
    v_n := v_n + internal.raise_alert(r.user_id, 'pause_over_cap', r.day::text,
      jsonb_build_object('day', r.day, 'total_s', r.total_s, 'cap_min', r.cap_min), p_now);
  end loop;

  perform internal.queue_alert_emails(p_now);
  return v_n;
end;
$$;

-- Email batching ----------------------------------------------------------------------------

-- Queues one email per recipient, employee and kind that has no email queued in the
-- last hour (ALR-02), carrying every unemailed, unread alert of that key.
create function internal.queue_alert_emails(p_now timestamptz default now())
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  g record;
  v_key text;
  v_email_id uuid;
  v_n int := 0;
begin
  for g in
    select a.org_id, a.recipient_id, a.user_id, a.kind,
           array_agg(a.id order by a.triggered_at) as ids,
           min(r.email) as to_email, min(r.full_name) as recipient_name,
           min(e.full_name) as employee_name, min(e.timezone) as employee_timezone
    from public.alerts a
    join public.users r on r.id = a.recipient_id and r.active
    join public.users e on e.id = a.user_id
    where a.email_id is null and a.read_at is null
      and a.triggered_at > p_now - interval '1 day'
    group by a.org_id, a.recipient_id, a.user_id, a.kind
  loop
    v_key := g.recipient_id || ':' || g.user_id || ':' || g.kind;
    continue when exists (
      select 1 from public.email_outbox o
      where o.batch_key = v_key and o.created_at > p_now - interval '1 hour'
    );
    insert into public.email_outbox (org_id, to_email, template, payload, batch_key, created_at, send_after)
    values (
      g.org_id, g.to_email, 'alert',
      jsonb_build_object(
        'recipient_name', g.recipient_name,
        'employee_id', g.user_id,
        'employee_name', g.employee_name,
        'employee_timezone', g.employee_timezone,
        'kind', g.kind,
        'alerts', (
          select jsonb_agg(jsonb_build_object('id', a.id, 'triggered_at', a.triggered_at,
                                              'details', a.details) order by a.triggered_at)
          from public.alerts a where a.id = any (g.ids)
        )
      ),
      v_key, p_now, p_now
    )
    returning id into v_email_id;
    update public.alerts set email_id = v_email_id where id = any (g.ids);
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;

-- What the send-emails function calls (service role only) ---------------------------------

-- Hands out up to p_limit emails that are due, counting the attempt and pushing
-- send_after out (1, 2, 4, 8 min), so overlapping runs never take the same row and a
-- failed one retries later. After 5 attempts a row is left alone (last_error says why).
create function public.email_claim(p_limit int default 50)
returns setof public.email_outbox
language sql
security definer
set search_path = ''
as $$
  update public.email_outbox o
  set attempts = o.attempts + 1,
      send_after = now() + make_interval(mins => 1 << least(o.attempts, 6))
  where o.id in (
    select q.id from public.email_outbox q
    where q.sent_at is null and q.attempts < 5 and q.send_after <= now()
    order by q.created_at
    limit least(greatest(p_limit, 1), 200)
    for update skip locked
  )
  returning o.*;
$$;

create function public.email_mark_sent(p_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.email_outbox set sent_at = now(), last_error = null where id = p_id;
$$;

create function public.email_mark_failed(p_id uuid, p_error text)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.email_outbox set last_error = left(p_error, 500) where id = p_id and sent_at is null;
$$;

-- Cron --------------------------------------------------------------------------------------

create extension if not exists pg_net with schema extensions;

-- Every minute, when an email is due: ask the send-emails function to deliver. The
-- project URL and service-role key are Vault secrets (names project_url and
-- service_role_key), set per environment and never in a migration or the seed. With
-- mail waiting and a secret missing this raises, which shows in cron.job_run_details.
create function internal.send_emails_kick()
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_url text;
  v_key text;
begin
  if not exists (
    select 1 from public.email_outbox o
    where o.sent_at is null and o.attempts < 5 and o.send_after <= now()
  ) then
    return null;
  end if;
  select s.decrypted_secret into v_url from vault.decrypted_secrets s where s.name = 'project_url';
  select s.decrypted_secret into v_key from vault.decrypted_secrets s where s.name = 'service_role_key';
  if coalesce(v_url, '') = '' or coalesce(v_key, '') = '' then
    raise exception 'vault secrets project_url and service_role_key are not set';
  end if;
  return net.http_post(
    url := rtrim(v_url, '/') || '/functions/v1/send-emails',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || v_key
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  );
end;
$$;

revoke all on function internal.alert_policy_int(jsonb, text, int, int, int) from public, anon, authenticated;
revoke all on function internal.alert_enabled(jsonb, public.alert_kind) from public, anon, authenticated;
revoke all on function internal.raise_alert(uuid, public.alert_kind, text, jsonb, timestamptz) from public, anon, authenticated;
revoke all on function internal.alert_eval(timestamptz) from public, anon, authenticated;
revoke all on function internal.queue_alert_emails(timestamptz) from public, anon, authenticated;
revoke all on function internal.send_emails_kick() from public, anon, authenticated;
revoke all on function public.email_claim(int) from public, anon, authenticated;
revoke all on function public.email_mark_sent(uuid) from public, anon, authenticated;
revoke all on function public.email_mark_failed(uuid, text) from public, anon, authenticated;
grant execute on function public.email_claim(int) to service_role;
grant execute on function public.email_mark_sent(uuid) to service_role;
grant execute on function public.email_mark_failed(uuid, text) to service_role;

select cron.schedule('alert_eval', '* * * * *', 'select internal.alert_eval()');
select cron.schedule('send_emails', '* * * * *', 'select internal.send_emails_kick()');
