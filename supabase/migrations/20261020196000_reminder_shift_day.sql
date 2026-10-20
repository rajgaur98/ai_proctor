-- #177: the submit reminder goes out on the employee's last shift day, and the org can
-- switch reminders off (#46; TS-17, #52).
--
-- Submit reminder time (internal.submit_reminder_due), for one person and one week of
-- seven local days from the org's week start:
--   with shifts   their last scheduled shift day of the week (shifts.days, ISO weekdays;
--                 the shift's own dates), one hour before the end of the latest-ending
--                 shift that day. A shift that crosses midnight belongs to the day it
--                 starts on, so its end is the next morning. The shift's own time zone
--                 gives the instant; a due time outside 09:00-18:00 in the person's
--                 zone waits for 09:00 there (reminder_send_at), as approval and
--                 escalation do, so nobody is mailed at night.
--   no shifts     the last day of the week at 16:00 in their own zone (as before).
-- The rest of the submit rules are unchanged (no submitted or approved week, time in
-- the week, 24 hour catch-up window after the due time).
--
-- Policy key reminders_enabled (bool, default true in every preset; an org that has not
-- stored it is on): when false, reminders_eval queues no reminder of any kind (submit,
-- approval, escalation) for the org. One switch for all three; reminders already queued
-- still go out.

-- Policy: the new key -----------------------------------------------------------------------

-- Copy of #52's with the new key.
create or replace function internal.region_preset(p_region public.region_preset)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object(
    'checkin_min_interval_min', case p_region when 'eu' then 45 else 20 end,
    'checkin_max_interval_min', case p_region when 'eu' then 120 else 90 end,
    'checkin_response_s', 90,
    'idle_threshold_min', 10,
    'screenshots', case p_region when 'eu' then 'blurred' else 'full' end,
    'webcam', p_region <> 'eu',
    'window_titles', p_region <> 'eu',
    'excluded_apps', jsonb_build_array(
      '1Password', 'Bitwarden', 'Dashlane', 'LastPass', 'KeePassXC', 'Keeper', 'NordPass',
      'Enpass', 'Keychain Access', 'Passwords'),
    'activity_sampling', true,
    'auto_clock_in', false,
    'forgotten_clock_out_min', 30,
    'breaks_paid', false,
    'break_daily_max_min', null,
    'pause_max_min', 15,
    'pause_daily_max_min', 60,
    'week_start', 'monday',
    'late_clock_in_min', 15,
    'alert_consecutive_misses_enabled', true,
    'alert_consecutive_misses', 3,
    'alert_offline_enabled', true,
    'alert_offline_min', 15,
    'alert_tamper_enabled', true,
    'alert_late_clock_in_enabled', true,
    'alert_pause_over_cap_enabled', true,
    'reminders_enabled', true,
    'image_retention_days', 30,
    'event_retention_months', 12,
    'timesheet_retention_years', 3,
    'anticheat_min_passes', 5,
    'anticheat_max_cv', 0.1,
    'require_admin_mfa', false
  );
$$;

-- Copy of #52's with the new key.
create or replace function internal.policy_spec()
returns table (key text, kind text, lo numeric, hi numeric, options text[])
language sql
immutable
set search_path = ''
as $$
  select * from (values
    ('checkin_min_interval_min', 'int', 10, 240, null::text[]),
    ('checkin_max_interval_min', 'int', 10, 240, null),
    ('checkin_response_s', 'int', 30, 300, null),
    ('idle_threshold_min', 'int', 3, 60, null),
    ('screenshots', 'enum', null, null, array['full', 'blurred', 'off']),
    ('webcam', 'bool', null, null, null),
    ('window_titles', 'bool', null, null, null),
    ('excluded_apps', 'apps', null, null, null),
    ('activity_sampling', 'bool', null, null, null),
    ('auto_clock_in', 'bool', null, null, null),
    ('forgotten_clock_out_min', 'int', 10, 120, null),
    ('breaks_paid', 'bool', null, null, null),
    ('break_daily_max_min', 'int', 1, 1440, null),
    ('pause_max_min', 'int', 0, 60, null),
    ('pause_daily_max_min', 'int', 0, 240, null),
    ('week_start', 'enum', null, null,
      array['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']),
    ('late_clock_in_min', 'int', 5, 60, null),
    ('alert_consecutive_misses_enabled', 'bool', null, null, null),
    ('alert_consecutive_misses', 'int', 1, 10, null),
    ('alert_offline_enabled', 'bool', null, null, null),
    ('alert_offline_min', 'int', 5, 240, null),
    ('alert_tamper_enabled', 'bool', null, null, null),
    ('alert_late_clock_in_enabled', 'bool', null, null, null),
    ('alert_pause_over_cap_enabled', 'bool', null, null, null),
    ('reminders_enabled', 'bool', null, null, null),
    ('image_retention_days', 'int', 7, 90, null),
    ('event_retention_months', 'int', 3, 36, null),
    ('timesheet_retention_years', 'int', 3, 10, null),
    ('anticheat_min_passes', 'int', 3, 50, null),
    ('anticheat_max_cv', 'num', 0.01, 0.5, null),
    ('require_admin_mfa', 'bool', null, null, null)
  ) as s(key, kind, lo, hi, options);
$$;

-- Reminders --------------------------------------------------------------------------------

-- Whether the org sends reminders (policy reminders_enabled; on when not stored).
create function internal.reminders_enabled(p_org_id uuid)
returns boolean
language sql
stable
set search_path = ''
as $$
  select coalesce((select (o.policy ->> 'reminders_enabled')::boolean
                   from public.orgs o where o.id = p_org_id), true);
$$;

-- When the submit reminder for p_user_id's week starting p_week (a local date in p_tz)
-- is due. See the header for the rule.
create function internal.submit_reminder_due(p_user_id uuid, p_week date, p_tz text)
returns timestamptz
language sql
stable
set search_path = ''
as $$
  with ends as (
    select p_week + g as day,
           ((p_week + g + case when s.end_time > s.start_time then 0 else 1 end) + s.end_time)
             at time zone s.timezone as end_at
    from public.shifts s
    cross join generate_series(0, 6) g
    where s.user_id = p_user_id
      and extract(isodow from p_week + g)::int = any (s.days)
  )
  select coalesce(
    (select internal.reminder_send_at(e.end_at - interval '1 hour', p_tz)
     from ends e
     where e.day = (select max(x.day) from ends x)
     order by e.end_at desc
     limit 1),
    (p_week + 6 + time '16:00') at time zone p_tz
  );
$$;

revoke all on function internal.reminders_enabled(uuid) from public, anon, authenticated;
revoke all on function internal.submit_reminder_due(uuid, date, text) from public, anon, authenticated;

-- The evaluation (copy of #46's with the due time and the switch) -----------------------------

create or replace function internal.reminders_eval(p_now timestamptz default now())
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
  v_n int := 0;
begin
  -- A slow run must not overlap the next one.
  if not pg_try_advisory_xact_lock(hashtext('reminders_eval')) then
    return 0;
  end if;

  -- Employee: submit your week ----------------------------------------------------------
  -- When it is due: internal.submit_reminder_due (the last shift day, else the last day).
  -- Candidate weeks: the one the employee's local date is in and the one before it, so
  -- a 24 hour window that crosses local midnight still finds its week.
  for r in
    select u.id as user_id, w.wk as period_start, (
      select t.id from public.timesheets t
      where t.user_id = u.id and t.period_start = w.wk
    ) as timesheet_id
    from public.users u
    cross join lateral (
      select (p_now at time zone u.timezone)::date as today
    ) l
    cross join lateral (
      select unnest(array[internal.week_start(u.org_id, l.today),
                          internal.week_start(u.org_id, l.today) - 7]) as wk
    ) w
    cross join lateral (
      select internal.submit_reminder_due(u.id, w.wk, u.timezone) as fire_at,
             (w.wk::timestamp) at time zone u.timezone as week_from,
             ((w.wk + 7)::timestamp) at time zone u.timezone as week_to
    ) f
    where u.active
      and internal.reminders_enabled(u.org_id)
      and w.wk is not null
      and p_now >= f.fire_at and p_now < f.fire_at + interval '24 hours'
      -- Only people who can submit (submit_timesheet: a manager, or auto-approval).
      and (u.manager_id is not null or not u.approval_required or u.role = 'owner')
      and not exists (
        select 1 from public.timesheets t
        where t.user_id = u.id and t.status in ('submitted', 'approved')
          and t.period_start < w.wk + 7 and t.period_start + 7 > w.wk
      )
      and (
        exists (
          select 1 from public.clock_sessions cs
          where cs.user_id = u.id and cs.start_at < f.week_to
            and coalesce(cs.end_at, 'infinity') > f.week_from
        )
        or exists (
          select 1 from public.time_segments s
          where s.user_id = u.id and s.day >= w.wk and s.day < w.wk + 7
            and s.counted and not s.excluded
        )
      )
  loop
    if internal.queue_reminder('submit', r.user_id, r.user_id, r.timesheet_id, r.period_start,
         '', '{}'::jsonb, p_now) then
      v_n := v_n + 1;
    end if;
  end loop;

  -- Manager: a week has waited 2 days ---------------------------------------------------
  -- The direct manager and the manager's active delegates (as for alerts).
  for r in
    select t.id as timesheet_id, t.user_id, t.period_start,
           w.since, rec.id as recipient_id
    from public.timesheets t
    join public.users e on e.id = t.user_id
    cross join lateral (
      select greatest(t.submitted_at, (
        select max(a.at) from public.audit_log a
        where a.target_user_id = t.user_id and a.action = 'timesheet.reopened'
          and a.metadata ->> 'timesheet_id' = t.id::text
      )) as since
    ) w
    cross join lateral (
      select e.manager_id as id where e.manager_id is not null
      union
      select d.delegate_id
      from public.delegations d
      where d.manager_id = e.manager_id
        and (p_now at time zone 'UTC')::date between d.starts_on and d.ends_on
    ) rec
    join public.users ru on ru.id = rec.id and ru.active and ru.org_id = t.org_id
      and ru.id <> t.user_id
    where t.status = 'submitted' and w.since is not null
      and internal.reminders_enabled(t.org_id)
      and p_now >= internal.reminder_send_at(w.since + interval '48 hours', ru.timezone)
  loop
    if internal.queue_reminder('approval', r.user_id, r.recipient_id, r.timesheet_id,
         r.period_start, (extract(epoch from r.since) * 1000000)::bigint::text,
         jsonb_build_object('submitted_at', r.since), p_now) then
      v_n := v_n + 1;
    end if;
  end loop;

  -- Admins: a week has waited 5 days (notify only) --------------------------------------
  for r in
    select t.id as timesheet_id, t.user_id, t.period_start, w.since,
           ad.id as recipient_id, m.id as manager_id, m.full_name as manager_name
    from public.timesheets t
    join public.users e on e.id = t.user_id
    left join public.users m on m.id = e.manager_id
    cross join lateral (
      select greatest(t.submitted_at, (
        select max(a.at) from public.audit_log a
        where a.target_user_id = t.user_id and a.action = 'timesheet.reopened'
          and a.metadata ->> 'timesheet_id' = t.id::text
      )) as since
    ) w
    join public.users ad on ad.org_id = t.org_id and ad.active
      and ad.role in ('owner', 'admin') and ad.id <> t.user_id
    where t.status = 'submitted' and w.since is not null
      and internal.reminders_enabled(t.org_id)
      and p_now >= internal.reminder_send_at(w.since + interval '5 days', ad.timezone)
  loop
    if internal.queue_reminder('escalation', r.user_id, r.recipient_id, r.timesheet_id,
         r.period_start, (extract(epoch from r.since) * 1000000)::bigint::text,
         jsonb_build_object('submitted_at', r.since, 'manager_id', r.manager_id,
                            'manager_name', r.manager_name), p_now) then
      v_n := v_n + 1;
    end if;
  end loop;

  return v_n;
end;
$$;

revoke all on function internal.reminders_eval(timestamptz) from public, anon, authenticated;
