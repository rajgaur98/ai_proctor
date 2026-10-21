-- Anti-cheat extras (#63; ANT-03, ANT-05, ANT-06, ANT-07, DSH-08). The kinds are
-- added in 20261021210301.
--
-- 1. internal.anticheat_from_checkin (from 20261020170000_anticheat.sql) reads the new
--    check-in flags too. Each becomes one "needs review" row per employee, local day and
--    kind, as injected_click already did; nothing reads these rows but the dashboard
--    (ANT-08: never a penalty, never a change to status, segments or timesheets).
--
--      flag on the check-in        kind              details
--      injected_click[:n]          injected_click    {clicks, checkin_ids}   (unchanged)
--      synthetic_click[:n]         synthetic_click   {clicks, checkin_ids}
--      virtual_camera[:name]       virtual_camera    {count, cameras, checkin_ids}
--      duplicate_frame:n           duplicate_frame   {count, min_distance, checkin_ids}
--      virtual_machine             virtual_machine   {count, checkin_ids}
--      remote_session              remote_session    {count, checkin_ids}
--
--    `n` is 1 to 6 digits (a bare click flag counts one; duplicate_frame's distance is
--    0..256, in bits of the agent's 256-bit frame hash); `name` is the camera's name,
--    1 to 24 plain characters. Anything else is ignored, so a malformed flag can never
--    fail the event. A check-in already counted on a row is not counted again. As
--    before, a reviewed row stays reviewed when a later check-in that day adds to it.
--
-- 2. Reports count these flags (DSH-08): report_rows is redefined in
--    20261022130000_anticheat_report_rows.sql, after #66 teams changed its signature.

-- Adds one check-in's numbers to a flag's details: counts add up, the smallest distance
-- wins, camera names and check-in ids are listed once each.
create function internal.anticheat_merge(p_old jsonb, p_new jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select p_old || p_new || jsonb_strip_nulls(jsonb_build_object(
    'clicks', case when p_new ? 'clicks'
      then coalesce((p_old ->> 'clicks')::int, 0) + (p_new ->> 'clicks')::int end,
    'count', case when p_new ? 'count'
      then coalesce((p_old ->> 'count')::int, 0) + (p_new ->> 'count')::int end,
    'min_distance', case when p_new ? 'min_distance'
      then least((p_old ->> 'min_distance')::int, (p_new ->> 'min_distance')::int) end,
    'cameras', case when p_new ? 'cameras'
      then (select coalesce(jsonb_agg(distinct c.name order by c.name), '[]'::jsonb)
            from jsonb_array_elements_text(coalesce(p_old -> 'cameras', '[]'::jsonb) || (p_new -> 'cameras'))
              as c (name)) end,
    'checkin_ids', coalesce(p_old -> 'checkin_ids', '[]'::jsonb) || coalesce(p_new -> 'checkin_ids', '[]'::jsonb)
  ));
$$;

revoke all on function internal.anticheat_merge(jsonb, jsonb) from public, anon, authenticated;

-- Fires for each new check-in with flags (the trigger from 20261020170000 is unchanged).
create or replace function internal.anticheat_from_checkin()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_day date;
  v_found record;
begin
  select (new.scheduled_at at time zone u.timezone)::date into v_day
  from public.users u where u.id = new.user_id;

  for v_found in
    with parsed as (
      select
        case
          when f ~ '^injected_click(:[0-9]{1,6})?$' then 'injected_click'
          when f ~ '^synthetic_click(:[0-9]{1,6})?$' then 'synthetic_click'
          when f ~ '^virtual_camera(:[A-Za-z0-9 ._-]{1,24})?$' then 'virtual_camera'
          when f ~ '^duplicate_frame:([0-9]{1,2}|1[0-9]{2}|2[0-4][0-9]|25[0-6])$' then 'duplicate_frame'
          when f in ('virtual_machine', 'remote_session') then f
        end as kind,
        substring(f from ':(.*)$') as arg,
        -- The number after the colon, where there is one (never cast otherwise: the
        -- aggregates below see every kind's rows).
        case when f ~ ':[0-9]{1,6}$' then substring(f from ':([0-9]{1,6})$')::int end as n
      from unnest(new.flags) as f
    )
    select p.kind,
      case
        when p.kind in ('injected_click', 'synthetic_click') then
          jsonb_build_object('clicks', sum(coalesce(p.n, 1)))
        when p.kind = 'virtual_camera' then
          jsonb_build_object('count', 1, 'cameras',
            coalesce(jsonb_agg(distinct p.arg) filter (where p.arg is not null), '[]'::jsonb))
        when p.kind = 'duplicate_frame' then
          jsonb_build_object('count', 1, 'min_distance', min(p.n))
        else jsonb_build_object('count', 1)
      end as details
    from parsed p
    where p.kind is not null
    group by p.kind
  loop
    -- Zero clicks (`injected_click:0`) say nothing.
    continue when (v_found.details ->> 'clicks')::int <= 0;

    insert into public.anticheat_flags as a (org_id, user_id, day, kind, details)
    values (new.org_id, new.user_id, v_day, v_found.kind::public.anticheat_kind,
            v_found.details || jsonb_build_object('checkin_ids', jsonb_build_array(new.id)))
    on conflict on constraint anticheat_flags_one_per_day_and_kind do update
    set details = internal.anticheat_merge(a.details, excluded.details)
    where not (a.details -> 'checkin_ids' @> jsonb_build_array(new.id));
  end loop;
  return new;
end;
$$;

revoke all on function internal.anticheat_from_checkin() from public, anon, authenticated;
