-- #29: shift schedules per employee (SHF-01). Admins, the direct manager or an
-- active delegate set a person's shifts; the agent reads them with agent_config
-- and refetches when the org's policy_version moves (the heartbeat returns it).

-- Replaces all of a person's shifts. `p_shifts` is an array of
-- {days: [1..7], start: "HH:MM", end: "HH:MM", timezone}. A shift whose end is
-- before its start crosses midnight and belongs to the day it starts on.
create function public.set_shifts(p_user_id uuid, p_shifts jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_target public.users;
  v_me public.users := internal.current_app_user();
  v_shift jsonb;
  v_days int[];
  v_start time;
  v_end time;
  v_before jsonb;
begin
  select * into v_target from public.users where id = p_user_id;
  if not found or v_target.org_id <> v_me.org_id then
    raise exception 'user_not_found' using errcode = '42501';
  end if;
  if not (v_me.role in ('owner', 'admin') or public.can_approve_for(p_user_id)) then
    raise exception 'manager_or_admin_only' using errcode = '42501';
  end if;
  if jsonb_typeof(p_shifts) <> 'array' or jsonb_array_length(p_shifts) > 7 then
    raise exception 'invalid_shifts' using errcode = '22023';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object('days', s.days, 'start', to_char(s.start_time, 'HH24:MI'),
           'end', to_char(s.end_time, 'HH24:MI'), 'timezone', s.timezone) order by s.start_time, s.days), '[]')
  into v_before
  from public.shifts s where s.user_id = p_user_id;

  delete from public.shifts where user_id = p_user_id;
  for v_shift in select * from jsonb_array_elements(p_shifts) loop
    begin
      v_days := array(select jsonb_array_elements_text(v_shift -> 'days')::int);
      v_start := (v_shift ->> 'start')::time;
      v_end := (v_shift ->> 'end')::time;
    exception when others then
      raise exception 'invalid_shifts' using errcode = '22023';
    end;
    if v_start is null or v_end is null or v_start = v_end
      or cardinality(v_days) not between 1 and 7 or not v_days <@ array[1, 2, 3, 4, 5, 6, 7]
    then
      raise exception 'invalid_shifts' using errcode = '22023';
    end if;
    if not exists (select 1 from pg_timezone_names where name = v_shift ->> 'timezone') then
      raise exception 'invalid_timezone' using errcode = '22023';
    end if;
    insert into public.shifts (org_id, user_id, days, start_time, end_time, timezone)
    values (v_target.org_id, p_user_id, array(select distinct unnest(v_days) order by 1), v_start,
            v_end, v_shift ->> 'timezone');
  end loop;

  -- Agents refetch their config when the org's policy_version changes.
  update public.orgs set policy_version = policy_version + 1 where id = v_target.org_id;
  perform internal.audit(v_target.org_id, v_me.id, 'member.shifts_changed', p_user_id,
    jsonb_build_object('from', v_before, 'to', p_shifts));
end;
$$;

revoke all on function public.set_shifts(uuid, jsonb) from public, anon;
grant execute on function public.set_shifts(uuid, jsonb) to authenticated;

-- What a signed-in agent needs to run: org policy and the person's shifts.
create function public.agent_config(p_device_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_device public.devices := internal.require_active_device(p_device_id);
begin
  return (
    select jsonb_build_object(
      'policy', o.policy,
      'policy_version', o.policy_version,
      'timezone', u.timezone,
      'shifts', coalesce((
        select jsonb_agg(jsonb_build_object('days', s.days, 'start', to_char(s.start_time, 'HH24:MI'),
          'end', to_char(s.end_time, 'HH24:MI'), 'timezone', s.timezone) order by s.start_time, s.days)
        from public.shifts s where s.user_id = u.id
      ), '[]'::jsonb)
    )
    from public.users u
    join public.orgs o on o.id = u.org_id
    where u.id = v_device.user_id
  );
end;
$$;

revoke all on function public.agent_config(uuid) from public, anon;
grant execute on function public.agent_config(uuid) to authenticated;
