-- #156: how fast is report_rows for a big org? Seeds N synthetic people (default 500, the
-- PRD pilot size, NFR-PERF-03) with `history` days (default 28) of segments, check-ins,
-- shifts and clock sessions, runs the report as the owner and as a manager over a week and
-- over a month, prints the timings, and rolls everything back. Run it with
-- scripts/it-reports-scale.sh.
--   psql "$DB_URL" -X -v people=500 -v history=28 -f scripts/it-reports-scale.sql
\set ON_ERROR_STOP on
\if :{?people}
\else
  \set people 500
\endif
\if :{?history}
\else
  \set history 28
\endif
\timing off
begin;
set local client_min_messages = warning;

\set org '''00000000-0000-4000-8000-000000000001'''
\set ada '''00000000-0000-4000-8000-0000000000a1'''
\set max '''00000000-0000-4000-8000-0000000000b1'''

-- Nothing the seed holds may count: only the synthetic people are reported on below,
-- and every one of them reports to Max.
create temp table scale_users as
select gen_random_uuid() as id, g as n,
  (array['America/Los_Angeles', 'America/Chicago', 'America/New_York', 'UTC'])[1 + g % 4] as tz
from generate_series(1, :people) g;

insert into auth.users (id, email) select id, 'scale' || n || '@scale.test' from scale_users;
insert into public.users (id, org_id, full_name, email, role, manager_id, active, timezone)
select id, :org, 'Scale Person ' || lpad(n::text, 4, '0'), 'scale' || n || '@scale.test',
  'employee', :max, n % 50 <> 0, tz
from scale_users;
insert into public.devices (id, org_id, user_id, platform, os_version, agent_version, hardware_hash)
select id, :org, id, 'macos', '26.0', '0.1.0', 'scale-' || n from scale_users;

-- `history` days up to today, weekdays only: verified, idle (flagged), break, verified, pause.
create temp table scale_days as
select d::date as day from generate_series(current_date - (:history - 1), current_date, interval '1 day') d
where extract(isodow from d) < 6;

insert into public.time_segments (org_id, user_id, day, start_at, end_at, type, counted, flagged, excluded)
select :org, u.id, d.day, (d.day + s.a)::timestamp at time zone u.tz,
  (d.day + s.b)::timestamp at time zone u.tz, s.type, s.counted, s.flagged, false
from scale_users u cross join scale_days d
cross join (values
  ('09:00'::time, '11:00'::time, 'verified', true, false),
  ('11:00', '11:20', 'idle', true, true),
  ('11:20', '11:40', 'break', false, false),
  ('11:40', '15:00', 'verified', true, false),
  ('15:00', '15:10', 'pause', true, false)
) s (a, b, type, counted, flagged);

-- Eight check-ins a day: six passes, a miss and a failure.
insert into public.checkin_events (id, org_id, user_id, device_id, scheduled_at, shown_at, outcome, response_ms)
select gen_random_uuid(), :org, u.id, u.id,
  ((d.day + time '09:00') + c * interval '40 minutes')::timestamp at time zone u.tz,
  ((d.day + time '09:00') + c * interval '40 minutes' + interval '2 seconds')::timestamp at time zone u.tz,
  (case when c < 6 then 'pass' when c = 6 then 'miss' else 'failed' end)::public.checkin_outcome,
  case when c < 6 then 1000 + (u.n * 37 + c * 911) % 9000 end
from scale_users u cross join scale_days d cross join generate_series(0, 7) c;

insert into public.shifts (org_id, user_id, days, start_time, end_time, timezone)
select :org, id, '{1,2,3,4,5}', '09:00', '17:00', tz from scale_users;
-- A clock-in a day, every third one late.
insert into public.clock_sessions (org_id, user_id, device_id, start_at, end_at, start_event_id)
select :org, u.id, u.id,
  (d.day + time '09:00' + case when (u.n + extract(doy from d.day)::int) % 3 = 0 then interval '25 minutes' else interval '5 minutes' end)::timestamp at time zone u.tz,
  (d.day + time '15:10')::timestamp at time zone u.tz, gen_random_uuid()
from scale_users u cross join scale_days d;

analyze public.users, public.devices, public.time_segments, public.checkin_events,
  public.shifts, public.clock_sessions;

select 'people' as seeded, count(*) from scale_users
union all select 'time_segments', count(*) from public.time_segments
union all select 'checkin_events', count(*) from public.checkin_events
union all select 'clock_sessions', count(*) from public.clock_sessions;

create function pg_temp.act_as(uid uuid) returns void
language sql as $$
  select set_config('role', 'postgres', true);
  select set_config('request.jwt.claims',
    (internal.custom_access_token_hook(jsonb_build_object(
      'user_id', uid, 'claims', jsonb_build_object('sub', uid, 'role', 'authenticated')
    )) -> 'claims')::text, true);
  select set_config('role', 'authenticated', true);
$$;

-- Wall-clock ms of one report_rows call, best of three after a warm-up.
create function pg_temp.time_report(p_from date, p_to date, p_manager uuid default null)
returns table (rows_returned int, best_ms numeric)
language plpgsql as $$
declare
  t timestamptz; best numeric := null; ms numeric; n int;
begin
  perform public.report_rows(p_from, p_to, null, p_manager);
  for i in 1..3 loop
    t := clock_timestamp();
    n := (public.report_rows(p_from, p_to, null, p_manager) ->> 'row_count')::int;
    ms := extract(epoch from clock_timestamp() - t) * 1000;
    best := least(coalesce(best, ms), ms);
  end loop;
  return query select n, round(best, 1);
end;
$$;

select 'owner, a week' as scenario, * from (select pg_temp.act_as(:ada)) a,
  lateral pg_temp.time_report(date_trunc('week', current_date)::date - 7,
    date_trunc('week', current_date)::date - 1);
select 'owner, 28 days' as scenario, * from (select pg_temp.act_as(:ada)) a,
  lateral pg_temp.time_report(current_date - 27, current_date);
select 'manager, a week' as scenario, * from (select pg_temp.act_as(:max)) a,
  lateral pg_temp.time_report(date_trunc('week', current_date)::date - 7,
    date_trunc('week', current_date)::date - 1);

rollback;
