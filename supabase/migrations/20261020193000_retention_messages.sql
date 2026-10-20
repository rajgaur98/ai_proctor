-- #185: retention for alerts, sent email and the segment rebuild log (ADM-03).
--
-- retention_purge_rows (from #51, last replaced in #130) also deletes, per org by its
-- clamped event_retention_months (3-36, default 12):
--   alerts                  by triggered_at
--   email_outbox            by created_at, only rows that are sent or given up on
--                           (attempts >= 5); mail still waiting to go out is never
--                           purged, however old
--   internal.segment_rebuilds
--                           by rebuilt_at, through the user's org
-- Counts are logged per org and category in retention_runs and in the org's
-- retention.purged audit row, as for the other tables. Still not purged, on purpose:
-- audit_log (AUD-03).
--
-- The function below is the #130 one with the #126 TODO filled in and the three
-- tables added. The grants stay as they were (create or replace keeps them): service
-- role only.

-- Deletes each org's expired rows by that org's settings and logs the counts.
-- Returns the totals per category. retention-purge calls it after the files are gone.
--
-- Partitioned tables (agent_events_raw, activity_samples): an org on the longest
-- event retention is left to the partitions job, which drops whole weeks; only orgs
-- on a shorter setting get row deletes here.
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
