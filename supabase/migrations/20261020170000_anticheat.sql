-- Anti-cheat flags (#26; ANT-02, ANT-04, ANT-08).
--
-- Three kinds of flag, all of them "needs review" for the manager and nothing
-- more (ANT-08): a flag never changes status, segments, timesheet totals or the
-- outcome of a check-in. Nothing in the status engine or segment builder reads
-- anticheat_flags.
--
--   injected_click  ANT-02. The Windows agent swallowed injected mouse clicks
--                   (LLMHF_INJECTED) on the card and reports them as a flag on
--                   the check-in event: `injected_click:<count>` (a bare
--                   `injected_click` counts as one). A trigger on checkin_events
--                   turns that into one row per employee and local day, adding
--                   up the clicks and listing the check-ins.
--                   details: {clicks, checkin_ids}
--   fast_response   ANT-04. A passed check-in answered in under 300 ms from the
--                   moment the card was shown (response_ms; fixed by the PRD).
--                   details: {count, min_response_ms, threshold_ms, checkin_ids}
--   low_variance    ANT-04. Implausibly even response times across a day: at
--                   least N passes whose coefficient of variation (sample
--                   standard deviation / mean of response_ms) is below a limit.
--                   details: {passes, mean_ms, stddev_ms, cv, min_passes, max_cv}
--
-- Org policy keys read here (orgs.policy; optional; the settings page is #52):
--   anticheat_min_passes  int, default 5, clamped 3..50: passes in a day before
--                         the variance rule applies (fewer say nothing)
--   anticheat_max_cv      number, default 0.1, clamped 0.01..0.5: a day whose
--                         coefficient of variation is below this is flagged
--
-- Day = the employee's local calendar day (users.timezone) the check-in was
-- scheduled on, as for the day page. anticheat_daily (03:30 UTC) evaluates each
-- employee's previous local day; at that hour a US employee's "yesterday" is the
-- day before the UTC date, so a day is flagged between about 22 and 46 hours
-- after it ends. Re-running a day is safe: one row per (employee, day, kind); an
-- unreviewed flag is refreshed if the numbers changed (late-synced check-ins), a
-- reviewed one is left alone.
--
-- Who sees them: whoever can view the employee (can_view_user: their manager, an
-- active delegate, owners and admins) and the employee about themselves. Nothing
-- is hidden from the person (EMP-02/03 spirit), so unlike manager alerts the
-- employee reads their own flags, including whether and how a manager reviewed
-- them. Reviewing goes through anticheat_mark_reviewed (audit-logged); only
-- someone who can view the employee, and never the employee, can review.

create type public.anticheat_kind as enum ('injected_click', 'fast_response', 'low_variance');

-- Number-valued policy key, clamped; a missing or non-numeric value is the default.
create function internal.anticheat_policy_num(
  p_policy jsonb, p_key text, p_default numeric, p_min numeric, p_max numeric
)
returns numeric
language sql
immutable
set search_path = ''
as $$
  select least(greatest(
    case when jsonb_typeof(p_policy -> p_key) = 'number'
         then (p_policy ->> p_key)::numeric else p_default end,
    p_min), p_max);
$$;

revoke all on function internal.anticheat_policy_num(jsonb, text, numeric, numeric, numeric) from public, anon, authenticated;

create table public.anticheat_flags (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  user_id uuid not null references public.users (id) on delete cascade,
  -- The employee's local day (see the header).
  day date not null,
  kind public.anticheat_kind not null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  reviewed_by uuid references public.users (id) on delete set null,
  reviewed_at timestamptz,
  review_note text check (review_note is null or length(review_note) <= 500),
  constraint anticheat_flags_one_per_day_and_kind unique (user_id, day, kind)
);

create index anticheat_flags_org_day_idx on public.anticheat_flags (org_id, day desc);
create index anticheat_flags_unreviewed_idx on public.anticheat_flags (org_id) where reviewed_at is null;
alter table public.anticheat_flags enable row level security;

create policy "Visible per can_view_user"
on public.anticheat_flags for select to authenticated
using (org_id = (select internal.jwt_org_id()) and public.can_view_user(user_id));

revoke all on public.anticheat_flags from anon, authenticated;
grant select on public.anticheat_flags to authenticated;

-- ANT-02: agent-reported injected clicks --------------------------------------------------

-- Fires for each new check-in (checkin_events rows are only inserted, once per
-- event id). Anything but `injected_click` or `injected_click:<1-6 digits>` is
-- ignored, so a malformed flag can never fail the event.
create function internal.anticheat_from_checkin()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_clicks int;
  v_day date;
begin
  select coalesce(sum(coalesce(substring(f from '^injected_click:([0-9]{1,6})$')::int, 1)), 0)::int
  into v_clicks
  from unnest(new.flags) as f
  where f ~ '^injected_click(:[0-9]{1,6})?$';
  if v_clicks <= 0 then
    return new;
  end if;

  select (new.scheduled_at at time zone u.timezone)::date into v_day
  from public.users u where u.id = new.user_id;

  insert into public.anticheat_flags as a (org_id, user_id, day, kind, details)
  values (new.org_id, new.user_id, v_day, 'injected_click',
          jsonb_build_object('clicks', v_clicks, 'checkin_ids', jsonb_build_array(new.id)))
  on conflict on constraint anticheat_flags_one_per_day_and_kind do update
  set details = jsonb_build_object(
    'clicks', (a.details ->> 'clicks')::int + v_clicks,
    'checkin_ids', a.details -> 'checkin_ids' || jsonb_build_array(new.id)
  )
  where not (a.details -> 'checkin_ids' @> jsonb_build_array(new.id));
  return new;
end;
$$;

revoke all on function internal.anticheat_from_checkin() from public, anon, authenticated;

create trigger checkin_events_anticheat
after insert on public.checkin_events
for each row
when (new.flags <> '{}')
execute function internal.anticheat_from_checkin();

-- ANT-04: response-time analysis ---------------------------------------------------------

-- Evaluates one local day for every employee: `p_day`, or when null each employee's
-- previous local day as of `p_now`. Returns the number of new flags. `p_now` is for
-- tests; cron uses the defaults.
create function internal.anticheat_eval(p_day date default null, p_now timestamptz default now())
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_fast int;
  v_var int;
begin
  -- A slow run must not overlap the next one.
  if not pg_try_advisory_xact_lock(hashtext('anticheat_eval')) then
    return 0;
  end if;

  with passes as materialized (
    select u.id as user_id, u.org_id, d.day, c.id, c.response_ms,
           internal.alert_policy_int(o.policy, 'anticheat_min_passes', 5, 3, 50) as min_passes,
           internal.anticheat_policy_num(o.policy, 'anticheat_max_cv', 0.1, 0.01, 0.5) as max_cv
    from public.users u
    join public.orgs o on o.id = u.org_id
    cross join lateral (
      select coalesce(p_day, (p_now at time zone u.timezone)::date - 1) as day
    ) d
    join public.checkin_events c
      on c.user_id = u.id
     and c.outcome = 'pass'
     and c.response_ms is not null
     and c.scheduled_at >= (d.day::timestamp at time zone u.timezone)
     and c.scheduled_at < ((d.day + 1)::timestamp at time zone u.timezone)
  ),
  -- Under 300 ms from show to click. Unreviewed rows are refreshed, reviewed ones kept.
  fast_found as (
    select p.user_id, p.org_id, p.day,
           jsonb_build_object(
             'count', count(*),
             'min_response_ms', min(p.response_ms),
             'threshold_ms', 300,
             'checkin_ids', jsonb_agg(p.id order by p.response_ms, p.id)
           ) as details
    from passes p
    where p.response_ms < 300
    group by p.user_id, p.org_id, p.day
  ),
  fast_up as (
    insert into public.anticheat_flags as a (org_id, user_id, day, kind, details)
    select f.org_id, f.user_id, f.day, 'fast_response', f.details from fast_found f
    on conflict on constraint anticheat_flags_one_per_day_and_kind do update
    set details = excluded.details
    where a.reviewed_at is null and a.details is distinct from excluded.details
    returning (xmax = 0) as inserted
  ),
  -- Implausibly even response times: enough passes, low coefficient of variation.
  var_found as (
    select p.user_id, p.org_id, p.day,
           count(*) as n, avg(p.response_ms) as mean, stddev_samp(p.response_ms) as sd,
           min(p.min_passes) as min_passes, min(p.max_cv) as max_cv
    from passes p
    group by p.user_id, p.org_id, p.day
  ),
  var_hits as (
    select f.*, f.sd / f.mean as cv
    from var_found f
    where f.n >= f.min_passes and f.mean > 0 and f.sd / f.mean < f.max_cv
  ),
  var_up as (
    insert into public.anticheat_flags as a (org_id, user_id, day, kind, details)
    select h.org_id, h.user_id, h.day, 'low_variance',
           jsonb_build_object(
             'passes', h.n,
             'mean_ms', round(h.mean),
             'stddev_ms', round(h.sd),
             'cv', round(h.cv, 4),
             'min_passes', h.min_passes,
             'max_cv', h.max_cv
           )
    from var_hits h
    on conflict on constraint anticheat_flags_one_per_day_and_kind do update
    set details = excluded.details
    where a.reviewed_at is null and a.details is distinct from excluded.details
    returning (xmax = 0) as inserted
  )
  select (select count(*) filter (where inserted) from fast_up),
         (select count(*) filter (where inserted) from var_up)
  into v_fast, v_var;

  return v_fast + v_var;
end;
$$;

revoke all on function internal.anticheat_eval(date, timestamptz) from public, anon, authenticated;

select cron.schedule('anticheat_daily', '30 3 * * *', 'select internal.anticheat_eval()');

-- ANT-08: reviewing ------------------------------------------------------------------------

-- A manager (or whoever can view the employee, never the employee) marks a flag
-- reviewed, with an optional note. Audited. A flag is reviewed once.
create function public.anticheat_mark_reviewed(p_flag_id uuid, p_note text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me public.users := internal.current_app_user();
  v_f public.anticheat_flags;
  v_note text := nullif(trim(coalesce(p_note, '')), '');
begin
  select * into v_f from public.anticheat_flags where id = p_flag_id;
  -- Same answer whether it doesn't exist or isn't yours to review.
  if not found or v_f.org_id <> v_me.org_id or v_f.org_id <> internal.jwt_org_id()
    or v_f.user_id = v_me.id or not public.can_view_user(v_f.user_id)
  then
    raise exception 'flag_not_found' using errcode = '42501';
  end if;
  if v_f.reviewed_at is not null then
    raise exception 'already_reviewed' using errcode = '22023';
  end if;
  if length(coalesce(v_note, '')) > 500 then
    raise exception 'note_too_long' using errcode = '22023';
  end if;

  update public.anticheat_flags
  set reviewed_by = v_me.id, reviewed_at = now(), review_note = v_note
  where id = p_flag_id;

  perform internal.audit(v_f.org_id, v_me.id, 'anticheat.reviewed', v_f.user_id,
    jsonb_build_object('flag_id', v_f.id, 'kind', v_f.kind, 'day', v_f.day, 'note', v_note));
end;
$$;

revoke all on function public.anticheat_mark_reviewed(uuid, text) from public, anon;
grant execute on function public.anticheat_mark_reviewed(uuid, text) to authenticated;
