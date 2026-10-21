-- #65: XLSX export and overtime highlighting (TS-20 XLSX, TS-19).
--
-- Policy keys (TS-19), org-wide (not team-overridable: timesheet keys stay the org's,
-- as #66 decided for every key outside team_policy_keys()):
--   overtime_daily_hours   worked hours in a day above which the day is highlighted
--   overtime_weekly_hours  worked hours in a week above which the week is highlighted
-- Both are numbers (decimals allowed, e.g. 7.5 or 37.5), daily 1..24, weekly 1..168, or
-- null: off. Every preset has both off, so nothing is highlighted until an admin sets a
-- threshold (an org that has not stored them is off too). Highlighting only: nothing is
-- paid, deducted or recalculated, and worked seconds stay raw.
--
-- Export format (TS-20): timesheet_export_rows takes p_format ('csv' default, or 'xlsx')
-- and records it in the timesheet.exported audit row. It also returns the org's
-- thresholds and week start, which the export-timesheet function uses to highlight the
-- XLSX. The rows are unchanged.
--
-- Redefined here, each copied from its latest definition with only this change:
--   region_preset          (20261020196000_reminder_shift_day): + the two keys, null
--   policy_spec            (20261020196000_reminder_shift_day): + the two keys, 'num'
--   validate_policy        (20261020180000_policy_settings): the two keys may be null,
--                          like break_daily_max_min
--   timesheet_export_rows  (20261022100000_teams): + p_format, audited; + overtime and
--                          week_start in the reply
-- timesheet_export_rows gets a new trailing argument, so the old signature is dropped
-- (an overload would make named calls ambiguous).

-- Policy --------------------------------------------------------------------------------------

-- Copy of #177's with the two keys.
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
    'overtime_daily_hours', null,
    'overtime_weekly_hours', null,
    'image_retention_days', 30,
    'event_retention_months', 12,
    'timesheet_retention_years', 3,
    'anticheat_min_passes', 5,
    'anticheat_max_cv', 0.1,
    'require_admin_mfa', false
  );
$$;

-- Copy of #177's with the two keys.
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
    ('overtime_daily_hours', 'num', 1, 24, null),
    ('overtime_weekly_hours', 'num', 1, 168, null),
    ('image_retention_days', 'int', 7, 90, null),
    ('event_retention_months', 'int', 3, 36, null),
    ('timesheet_retention_years', 'int', 3, 10, null),
    ('anticheat_min_passes', 'int', 3, 50, null),
    ('anticheat_max_cv', 'num', 0.01, 0.5, null),
    ('require_admin_mfa', 'bool', null, null, null)
  ) as s(key, kind, lo, hi, options);
$$;

-- Copy of #52's: the overtime thresholds may be null (off), like the daily break limit.
create or replace function internal.validate_policy(p_policy jsonb)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  r record;
  s record;
  v_out jsonb := '{}'::jsonb;
  v_num numeric;
  v_apps jsonb;
begin
  if jsonb_typeof(p_policy) is distinct from 'object' then
    raise exception 'invalid_policy' using errcode = '22023', detail = 'policy';
  end if;
  for r in select e.key, e.value from jsonb_each(p_policy) e loop
    select * into s from internal.policy_spec() sp where sp.key = r.key;
    if not found then
      raise exception 'unknown_policy_key' using errcode = '22023', detail = r.key;
    end if;
    if r.key in ('break_daily_max_min', 'overtime_daily_hours', 'overtime_weekly_hours')
       and r.value = 'null'::jsonb then
      v_out := v_out || jsonb_build_object(r.key, null);
      continue;
    end if;

    if s.kind = 'bool' then
      if jsonb_typeof(r.value) <> 'boolean' then
        raise exception 'invalid_policy' using errcode = '22023', detail = r.key;
      end if;
      v_out := v_out || jsonb_build_object(r.key, r.value);

    elsif s.kind = 'enum' then
      if jsonb_typeof(r.value) <> 'string' or not ((r.value #>> '{}') = any (s.options)) then
        raise exception 'invalid_policy' using errcode = '22023', detail = r.key;
      end if;
      v_out := v_out || jsonb_build_object(r.key, r.value);

    elsif s.kind in ('int', 'num') then
      if jsonb_typeof(r.value) <> 'number' then
        raise exception 'invalid_policy' using errcode = '22023', detail = r.key;
      end if;
      v_num := (r.value #>> '{}')::numeric;
      if v_num < s.lo or v_num > s.hi or (s.kind = 'int' and v_num <> floor(v_num)) then
        raise exception 'invalid_policy' using errcode = '22023', detail = r.key;
      end if;
      v_out := v_out || jsonb_build_object(r.key,
        case when s.kind = 'int' then to_jsonb(v_num::int) else to_jsonb(v_num) end);

    else -- apps
      if jsonb_typeof(r.value) <> 'array' or jsonb_array_length(r.value) > 100 then
        raise exception 'invalid_policy' using errcode = '22023', detail = r.key;
      end if;
      if exists (
        select 1 from jsonb_array_elements(r.value) a
        where jsonb_typeof(a) <> 'string' or length(btrim(a #>> '{}')) not between 1 and 100
      ) then
        raise exception 'invalid_policy' using errcode = '22023', detail = r.key;
      end if;
      select coalesce(jsonb_agg(d.app order by d.pos), '[]'::jsonb) into v_apps
      from (
        select distinct on (lower(btrim(a.v))) btrim(a.v) as app, a.pos
        from jsonb_array_elements_text(r.value) with ordinality a(v, pos)
        order by lower(btrim(a.v)), a.pos
      ) d;
      v_out := v_out || jsonb_build_object(r.key, v_apps);
    end if;
  end loop;
  return v_out;
end;
$$;

-- Timesheet export ----------------------------------------------------------------------------

-- Copy of #66's (20261022100000_teams) with p_format and the overtime thresholds.

drop function public.timesheet_export_rows(date, date, text, uuid[], uuid, uuid[], uuid[], text[], uuid);

create function public.timesheet_export_rows(
  p_from date,
  p_to date,
  p_view text,
  p_user_ids uuid[] default null,
  p_manager_id uuid default null,
  p_client_ids uuid[] default null,
  p_project_ids uuid[] default null,
  p_statuses text[] default null,
  p_team_id uuid default null,
  p_format text default 'csv'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me public.users := internal.current_app_user();
  v_rows jsonb;
  v_count int;
  v_target uuid;
  v_policy jsonb;
begin
  if p_view is null or p_view not in ('daily', 'project', 'segments') then
    raise exception 'invalid_view' using errcode = '22023';
  end if;
  if p_format is null or p_format not in ('csv', 'xlsx') then
    raise exception 'invalid_format' using errcode = '22023';
  end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 365 then
    raise exception 'invalid_range' using errcode = '22023';
  end if;
  if p_statuses is not null
     and exists (select 1 from unnest(p_statuses) s
                 where s is null or s not in ('draft', 'submitted', 'approved', 'returned')) then
    raise exception 'invalid_status' using errcode = '22023';
  end if;
  if coalesce(cardinality(p_user_ids), 0) > 0
     and exists (select 1 from unnest(p_user_ids) u where u is null or not public.can_view_user(u)) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(r.seg order by r.full_name, r.user_id, r.day, r.start_at), '[]'::jsonb),
         count(*)::int
  into v_rows, v_count
  from (
    select u.full_name, t.user_id, t.day, t.start_at,
      jsonb_build_object(
        'user_id', t.user_id,
        'employee', u.full_name,
        'email', u.email,
        'timezone', u.timezone,
        'day', t.day,
        'start_local', to_char(t.start_at at time zone u.timezone, 'YYYY-MM-DD HH24:MI:SS'),
        'end_local', to_char(t.end_at at time zone u.timezone, 'YYYY-MM-DD HH24:MI:SS'),
        'type', t.type,
        'project_id', t.project_id,
        'project', p.name,
        'client_id', p.client_id,
        'client', c.name,
        'billable', coalesce(p.billable, false),
        'counted', t.counted,
        'flagged', t.flagged,
        'excluded', t.excluded,
        'seconds', round(extract(epoch from t.end_at - t.start_at))::bigint,
        'status', coalesce(ts.status, 'draft'),
        'approver', a.full_name
      ) as seg
    from public.time_segments t
    join public.users u on u.id = t.user_id
    left join public.projects p on p.id = t.project_id
    left join public.clients c on c.id = p.client_id
    left join lateral (
      select s.status, s.approver_id
      from public.timesheets s
      where s.user_id = t.user_id and t.day >= s.period_start and t.day < s.period_start + 7
      order by s.period_start desc
      limit 1
    ) ts on true
    left join public.users a on a.id = ts.approver_id
    where t.org_id = v_me.org_id
      and t.day between p_from and p_to
      and public.can_view_user(t.user_id)
      and (coalesce(cardinality(p_user_ids), 0) = 0 or t.user_id = any (p_user_ids))
      and (p_manager_id is null or u.manager_id = p_manager_id)
      and (p_team_id is null or u.team_id = p_team_id)
      and (coalesce(cardinality(p_project_ids), 0) = 0 or t.project_id = any (p_project_ids))
      and (coalesce(cardinality(p_client_ids), 0) = 0 or p.client_id = any (p_client_ids))
      and (coalesce(cardinality(p_statuses), 0) = 0 or coalesce(ts.status, 'draft') = any (p_statuses))
  ) r;

  -- One named employee is the target; anything wider has none.
  if cardinality(p_user_ids) = 1 then
    v_target := p_user_ids[1];
  end if;
  perform internal.audit(v_me.org_id, v_me.id, 'timesheet.exported', v_target,
    jsonb_build_object(
      'view', p_view,
      'format', p_format,
      'from', p_from,
      'to', p_to,
      'user_ids', coalesce(to_jsonb(p_user_ids), '[]'::jsonb),
      'manager_id', p_manager_id,
      'team_id', p_team_id,
      'client_ids', coalesce(to_jsonb(p_client_ids), '[]'::jsonb),
      'project_ids', coalesce(to_jsonb(p_project_ids), '[]'::jsonb),
      'statuses', coalesce(to_jsonb(p_statuses), '[]'::jsonb),
      'row_count', v_count
    ));

  -- TS-19: what the XLSX highlights, from the org's policy (null is off).
  select internal.policy_defaults() || o.policy into v_policy
  from public.orgs o where o.id = v_me.org_id;

  return jsonb_build_object(
    'row_count', v_count,
    'rows', v_rows,
    'overtime', jsonb_build_object(
      'daily_hours', v_policy -> 'overtime_daily_hours',
      'weekly_hours', v_policy -> 'overtime_weekly_hours'
    ),
    'week_start', v_policy ->> 'week_start'
  );
end;
$$;

revoke all on function public.timesheet_export_rows(date, date, text, uuid[], uuid, uuid[], uuid[], text[], uuid, text)
  from public, anon;
grant execute on function public.timesheet_export_rows(date, date, text, uuid[], uuid, uuid[], uuid[], text[], uuid, text)
  to authenticated;
