-- #329: shift history and one leave rule (SHF-01, LV-04, LV-05, INS-02, INS-04).
--
-- Shift history (SHF-01) ------------------------------------------------------------------
-- public.shifts stays the person's current shifts (set_shifts replaces them all; the agent,
-- the shift editor, the API and everything about today read it). public.shift_history keeps
-- every shift with the local days it applied to: valid_from (first day) and valid_to
-- (first day it no longer applies; null while current), as dates in the person's time
-- zone (users.timezone). A trigger on public.shifts writes it: a new shift applies from
-- the person's today, a removed one up to their yesterday, so editing a shift today
-- changes today and later and leaves every earlier day as it was. A shift added and
-- removed on the same day never applied to a whole day and is dropped. Shifts that
-- existed before this migration apply all along (valid_from -infinity), as they did.
-- A shift occurrence is matched against the history by its own local start date.
--
-- internal.shift_occurrences(people, from, to) lists the occurrences from the history:
-- one per shift version and local start date in the range on its weekdays, with its
-- start and end instants (a shift past midnight belongs to the day it starts on). Read
-- by everything that looks at a past day:
--   * insights_days: scheduled hours, shift days, no clock-in, leave shift days;
--   * leave_days: the shift hours a whole day of leave or a holiday counts (so the
--     timesheet's Leave row, the export and Reports' leave_s);
--   * record_late_clock_in: a clock session that arrives late (synced from a past day)
--     is checked against the shift of that day.
-- Still on public.shifts, because they are about now: agent_config (auto clock-in),
-- alert_eval (late clock-in alerts while they happen), team_live.scheduled_today,
-- submit_reminder_due (this week's reminder), api_list_shifts and the shift editor.
--
-- One leave rule (LV-04) ------------------------------------------------------------------
-- internal.leave_periods(people, from, to): the approved requests and the holidays that
-- apply to the people (a holiday is the person's whole local day) overlapping [from, to]
-- (both ends included, so from = to asks about one instant). It is plain SQL (not
-- security definer, no settings), so the planner inlines it where it is used and a
-- per-row use costs what the hand-written rule did. on_leave_at, leave_spans,
-- leave_days and insights_days all read it, so they can't drift apart.
--
-- Redefined here, each copied from its latest definition with only this change:
--   on_leave_at          (20261105110000_time_off): reads leave_periods
--   leave_spans          (20261105110000_time_off): reads leave_periods
--   leave_days           (20261105400000_leave_on_timesheets): leave_periods, shift history
--   record_late_clock_in (20261105110000_time_off): shift history
--   retention_purge_rows (20261105110000_time_off): + shift_history

-- Shift history ----------------------------------------------------------------------------

create table public.shift_history (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  user_id uuid not null references public.users (id) on delete cascade,
  -- The public.shifts row it was (gone once the shift is replaced).
  shift_id uuid not null,
  days int[] not null,
  start_time time not null,
  end_time time not null,
  timezone text not null,
  -- Local dates (users.timezone): the first day it applies to, and the first day it no
  -- longer does (null: it still applies).
  valid_from date not null,
  valid_to date,
  created_at timestamptz not null default now(),
  constraint shift_history_valid_range check (valid_to is null or valid_to > valid_from)
);

create index shift_history_user_idx on public.shift_history (user_id, valid_from);
create index shift_history_current_idx on public.shift_history (shift_id) where valid_to is null;
alter table public.shift_history enable row level security;
-- Internal: no policies, no grants. Read through the functions below.
revoke all on public.shift_history from anon, authenticated;

-- What there is now applied all along.
insert into public.shift_history (org_id, user_id, shift_id, days, start_time, end_time, timezone,
  valid_from, created_at)
select s.org_id, s.user_id, s.id, s.days, s.start_time, s.end_time, s.timezone, '-infinity', s.created_at
from public.shifts s;

create function internal.shifts_history()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_today date;
begin
  select (now() at time zone u.timezone)::date into v_today
  from public.users u
  where u.id = case when tg_op = 'DELETE' then old.user_id else new.user_id end;
  -- The person is being deleted: their history goes with them.
  if v_today is null then
    return null;
  end if;

  if tg_op in ('UPDATE', 'DELETE') then
    -- Applied to no whole day yet: it never was.
    delete from public.shift_history h
    where h.shift_id = old.id and h.valid_to is null and h.valid_from >= v_today;
    update public.shift_history h set valid_to = v_today
    where h.shift_id = old.id and h.valid_to is null;
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    insert into public.shift_history (org_id, user_id, shift_id, days, start_time, end_time,
      timezone, valid_from)
    values (new.org_id, new.user_id, new.id, new.days, new.start_time, new.end_time,
      new.timezone, v_today);
  end if;
  return null;
end;
$$;

create trigger shifts_history
after insert or update or delete on public.shifts
for each row execute function internal.shifts_history();

revoke all on function internal.shifts_history() from public, anon, authenticated;

-- The occurrences of the people's shifts whose local start date (the shift's own zone) is
-- from p_from to p_to, each from the version that applied that day. Plain SQL so callers
-- inline it.
create function internal.shift_occurrences(p_user_ids uuid[], p_from date, p_to date)
returns table (user_id uuid, day date, starts_at timestamptz, ends_at timestamptz)
language sql
stable
as $$
  select s.user_id, d.day,
    (d.day + s.start_time) at time zone s.timezone,
    ((d.day + case when s.end_time <= s.start_time then 1 else 0 end) + s.end_time)
      at time zone s.timezone
  from public.shift_history s
  cross join lateral generate_series(greatest(s.valid_from, p_from)::timestamp,
    least(s.valid_to - 1, p_to)::timestamp, interval '1 day') g (d)
  cross join lateral (select g.d::date as day) d
  where s.user_id = any (p_user_ids)
    and s.valid_from <= p_to
    and (s.valid_to is null or s.valid_to > p_from)
    and extract(isodow from d.day)::int = any (s.days);
$$;

revoke all on function internal.shift_occurrences(uuid[], date, date) from public, anon, authenticated;

-- One leave rule ---------------------------------------------------------------------------

-- The people's approved requests and the holidays that apply to them (their whole local
-- day) overlapping [p_from, p_to], both ends included. Plain SQL so callers inline it.
create function internal.leave_periods(p_user_ids uuid[], p_from timestamptz, p_to timestamptz)
returns table (user_id uuid, start_at timestamptz, end_at timestamptz, kind text, paid boolean,
  name text, holiday boolean)
language sql
stable
as $$
  select r.user_id, r.start_at, r.end_at, r.kind, r.paid, t.name, false
  from public.leave_requests r
  join public.leave_types t on t.id = r.leave_type_id
  where r.user_id = any (p_user_ids) and r.status = 'approved'
    and r.start_at <= p_to and r.end_at > p_from
  union all
  select u.id, h.day::timestamp at time zone u.timezone, (h.day + 1)::timestamp at time zone u.timezone,
    'days', true, h.name, true
  from public.users u
  join public.holidays h on h.org_id = u.org_id
  where u.id = any (p_user_ids)
    and h.day between (p_from at time zone u.timezone)::date and (p_to at time zone u.timezone)::date
    and internal.holiday_applies(h.country, h.state, u.work_country, u.work_state);
$$;

revoke all on function internal.leave_periods(uuid[], timestamptz, timestamptz) from public, anon, authenticated;

-- LV-04: whether the person is on leave at p_at.
create or replace function internal.on_leave_at(p_user_id uuid, p_at timestamptz)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from internal.leave_periods(array[p_user_id], p_at, p_at));
$$;

-- The person's leave from p_from on, as spans for the agent (SHF-03). Unmerged; at most 200
-- of each kind.
create or replace function internal.leave_spans(p_user_id uuid, p_from timestamptz)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object('start', s.start_at, 'end', s.end_at)
    order by s.start_at), '[]'::jsonb)
  from (
    (select l.start_at, l.end_at
     from internal.leave_periods(array[p_user_id], p_from, 'infinity') l
     where not l.holiday
     order by l.start_at limit 200)
    union all
    (select l.start_at, l.end_at
     from internal.leave_periods(array[p_user_id], p_from, 'infinity') l
     where l.holiday
     order by l.start_at limit 200)
  ) s;
$$;

-- Leave seconds (LV-05): as before, from leave_periods and the shift that applied each day.
create or replace function internal.leave_days(p_user_ids uuid[], p_from date, p_to date)
returns table (user_id uuid, day date, seconds bigint, items jsonb)
language sql
stable
security definer
set search_path = ''
as $$
  with people as (
    select u.id, u.org_id, u.timezone, u.work_country, u.work_state
    from public.users u
    where u.id = any (p_user_ids)
  ),
  -- Approved requests and applicable holidays around the range: margin on each side for
  -- time zones and for a night shift that runs into the next day.
  src as (
    select l.user_id, l.kind, l.paid, l.name, l.holiday, l.start_at, l.end_at
    from internal.leave_periods(p_user_ids, (p_from - 2)::timestamp at time zone 'UTC',
      (p_to + 3)::timestamp at time zone 'UTC') l
  ),
  -- The local days in the range each one touches, and the day before it (a shift that
  -- starts that evening can run into it).
  days as (
    select distinct s.user_id, d.day
    from src s
    join people p on p.id = s.user_id
    cross join lateral (
      select g::date as day
      from generate_series(
        (s.start_at at time zone p.timezone)::date - 1,
        ((s.end_at - interval '1 microsecond') at time zone p.timezone)::date,
        interval '1 day') g
    ) d
    where d.day between p_from and p_to
  ),
  per_day as (
    select dd.user_id, dd.day,
      -- Shift hours inside paid whole-day leave or a holiday ...
      (sh.mr * coalesce((select range_agg(tstzrange(s.start_at, s.end_at))
                         from src s
                         where s.user_id = dd.user_id and s.paid and s.kind = 'days'),
                        '{}'::tstzmultirange))
      -- ... and paid part days that start that day, each instant once.
      + coalesce((select range_agg(tstzrange(s.start_at, s.end_at))
                  from src s
                  where s.user_id = dd.user_id and s.paid and s.kind = 'part_day'
                    and (s.start_at at time zone p.timezone)::date = dd.day),
                 '{}'::tstzmultirange) as leave,
      -- What the day's leave is: what touches the day, or the day's shifts. Holidays
      -- first, then requests in time order.
      (select jsonb_agg(jsonb_build_object('name', s.name, 'paid', s.paid, 'holiday', s.holiday,
                'part_day', s.kind = 'part_day')
              order by s.holiday desc, s.start_at, s.name)
       from src s
       where s.user_id = dd.user_id
         and ((s.start_at < (dd.day + 1)::timestamp at time zone p.timezone
               and s.end_at > dd.day::timestamp at time zone p.timezone)
              or (s.kind = 'days' and sh.mr && tstzrange(s.start_at, s.end_at)))) as items
    from days dd
    join people p on p.id = dd.user_id
    -- The person's shifts that start that day (each in its own zone, SHF-01), as they
    -- were that day (shift history).
    cross join lateral (
      select coalesce(range_agg(tstzrange(o.starts_at, o.ends_at)), '{}'::tstzmultirange) as mr
      from internal.shift_occurrences(array[dd.user_id], dd.day, dd.day) o
    ) sh
  )
  select pd.user_id, pd.day, x.seconds, coalesce(pd.items, '[]'::jsonb)
  from per_day pd
  cross join lateral (
    select coalesce(round(sum(extract(epoch from upper(r) - lower(r)))), 0)::bigint as seconds
    from unnest(pd.leave) r
  ) x
  where pd.items is not null or x.seconds > 0;
$$;

-- Late clock-ins (SHF-06): as before, against the shift that applied on the occurrence's
-- day (a session synced days later is checked against that day's shift).
create or replace function internal.record_late_clock_in(p_session public.clock_sessions)
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

  -- The occurrences the session can start in begin on its local date or the day before
  -- in their own zone; two days on each side of its UTC date cover every zone.
  insert into public.late_clock_ins (org_id, user_id, clock_session_id, day, shift_start,
    clocked_in_at, late_s, grace_min)
  select p_session.org_id, p_session.user_id, p_session.id, o.day, o.starts_at,
         p_session.start_at,
         floor(extract(epoch from p_session.start_at - o.starts_at))::int, v_grace
  from internal.shift_occurrences(array[p_session.user_id],
    (p_session.start_at at time zone 'UTC')::date - 2,
    (p_session.start_at at time zone 'UTC')::date + 1) o
  where p_session.start_at > o.starts_at + make_interval(mins => v_grace)
    and p_session.start_at < o.ends_at
    and not exists (
      select 1 from public.clock_sessions cs
      where cs.user_id = p_session.user_id
        and cs.id <> p_session.id
        and cs.start_at <= o.starts_at + make_interval(mins => v_grace)
        and coalesce(cs.end_at, 'infinity'::timestamptz) > o.starts_at
    )
    -- LV-04: a shift that starts on an approved leave or a holiday is not late.
    and not internal.on_leave_at(p_session.user_id, o.starts_at)
  on conflict on constraint late_clock_ins_one_per_shift do update
    set clock_session_id = excluded.clock_session_id,
        clocked_in_at = excluded.clocked_in_at,
        late_s = excluded.late_s
    where excluded.clocked_in_at < public.late_clock_ins.clocked_in_at;
end;
$$;

-- Retention (copied from 20261105110000_time_off; + shift_history) ----------------------------

create or replace function public.retention_purge_rows()
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
  v_day date;
begin
  for o in select id, policy from public.orgs loop
    v_events := now() - make_interval(months => internal.event_retention_months(o.policy));
    v_timesheets := now() - make_interval(years => internal.timesheet_retention_years(o.policy));
    v_day := (v_timesheets at time zone 'UTC')::date - 1;
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

    -- Timesheet window (#130). Whole days and weeks only, and only once they ended
    -- everywhere before the cutoff: v_day is the UTC date of the cutoff less one day,
    -- so a local day (UTC-12 to UTC+14) or a week of them is over by then. Children
    -- before parents. A draft or submitted week that old goes too: nobody can still
    -- approve three years on, and the window is the promise made to the org.
    delete from public.dirty_days d
    using public.users u
    where u.id = d.user_id and u.org_id = o.id and d.day < v_day;
    get diagnostics n = row_count;
    v_counts := v_counts || jsonb_build_object('dirty_days', n);

    delete from public.time_segments where org_id = o.id and day < v_day;
    get diagnostics n = row_count;
    v_counts := v_counts || jsonb_build_object('time_segments', n);

    -- Reminder bookkeeping of a week (kept by its week, like the sheet it was about).
    delete from public.reminders_sent where org_id = o.id and period_start + 6 < v_day;
    get diagnostics n = row_count;
    v_counts := v_counts || jsonb_build_object('reminders_sent', n);

    -- #265: a week's comments go with it.
    delete from public.timesheet_comments c
    using public.timesheets t
    where t.id = c.timesheet_id and c.org_id = o.id and t.period_start + 6 < v_day;
    get diagnostics n = row_count;
    v_counts := v_counts || jsonb_build_object('timesheet_comments', n);
    delete from public.timesheet_edits e
    using public.timesheets t
    where t.id = e.timesheet_id and e.org_id = o.id and t.period_start + 6 < v_day;
    get diagnostics n = row_count;
    v_counts := v_counts || jsonb_build_object('timesheet_edits', n);
    delete from public.timesheets where org_id = o.id and period_start + 6 < v_day;
    get diagnostics n = row_count;
    v_counts := v_counts || jsonb_build_object('timesheets', n);

    -- By end time, whatever the status: a pending request is as old as the others.
    delete from public.manual_entries where org_id = o.id and end_at < v_timesheets;
    get diagnostics n = row_count;
    v_counts := v_counts || jsonb_build_object('manual_entries', n);

    -- #304 (LV-07): time-off requests keep the timesheet window too, by end time.
    delete from public.leave_requests where org_id = o.id and end_at < v_timesheets;
    get diagnostics n = row_count;
    v_counts := v_counts || jsonb_build_object('leave_requests', n);
    -- #329: shifts that stopped applying before the window (past days only use them).
    delete from public.shift_history where org_id = o.id and valid_to is not null and valid_to < v_day;
    get diagnostics n = row_count;
    v_counts := v_counts || jsonb_build_object('shift_history', n);

    -- In-app notifications are transient, so they follow the events window, not
    -- the timesheet one.
    delete from public.notifications where org_id = o.id and created_at < v_events;
    get diagnostics n = row_count;
    v_counts := v_counts || jsonb_build_object('notifications', n);

    -- Messages (#185), on the events window like notifications. Alerts first: they
    -- point at their email (on delete set null), and an alert is always older than
    -- its email, so none outlives the email it went out in.
    delete from public.alerts where org_id = o.id and triggered_at < v_events;
    get diagnostics n = row_count;
    v_counts := v_counts || jsonb_build_object('alerts', n);

    -- Only mail that is done: sent, or given up on (5 attempts, see email_claim). A
    -- row still waiting to go out stays however old, so nothing undelivered is lost.
    delete from public.email_outbox
    where org_id = o.id and created_at < v_events
      and (sent_at is not null or attempts >= 5);
    get diagnostics n = row_count;
    v_counts := v_counts || jsonb_build_object('email_outbox', n);

    -- The rebuild log (when each employee-day was last rebuilt) only matters while a
    -- day can still be rebuilt, which needs its raw events: the events window. The
    -- kick only looks at days of an open shift, so a purged entry is never read.
    delete from internal.segment_rebuilds r
    using public.users u
    where u.id = r.user_id and u.org_id = o.id and r.rebuilt_at < v_events;
    get diagnostics n = row_count;
    v_counts := v_counts || jsonb_build_object('segment_rebuilds', n);

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
