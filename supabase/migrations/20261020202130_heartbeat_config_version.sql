-- The heartbeat returns config_version again (#146). The tamper reason migration
-- (20261020192000) redefined agent_heartbeat from the status engine's version after
-- user_config_version had added config_version, so the later definition dropped it.
-- This is the tamper reason version (the gap period gets 'no_heartbeat') plus
-- config_version.

create or replace function public.agent_heartbeat(
  device_id uuid,
  sent_at timestamptz,
  idle_s int,
  locked boolean,
  in_call boolean,
  agent_version text,
  permissions jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_device public.devices := internal.require_active_device(agent_heartbeat.device_id);
  v_now timestamptz := now();
  v_prev timestamptz;
  v_was_locked boolean;
  v_idle_threshold int;
begin
  if idle_s < 0 or length(coalesce(agent_version, '')) not between 1 and 64 then
    raise exception 'invalid_heartbeat' using errcode = '22023';
  end if;

  insert into public.presence (user_id, org_id) values (v_device.user_id, v_device.org_id)
  on conflict (user_id) do nothing;
  select p.last_contact_at, p.locked into v_prev, v_was_locked
  from public.presence p where p.user_id = v_device.user_id;

  -- STS rule 2: the agent went silent during clock-in with nothing to explain it
  -- (no queued events from the gap, not locked or asleep) → it was killed or
  -- blocked. Offline work is not Tamper: its events arrive with times in the gap.
  if v_prev is not null
    and v_now - v_prev > internal.offline_after()
    and (internal.shift_state(v_device.user_id)).state <> 'off_shift'
    and not v_was_locked
    and not exists (
      select 1 from public.agent_events_raw r
      where r.user_id = v_device.user_id and r.at > v_prev and r.at < v_now
    )
  then
    update public.status_periods set end_at = greatest(start_at, v_prev)
    where user_id = v_device.user_id and end_at is null;
    insert into public.status_periods (org_id, user_id, status, reason, start_at, end_at)
    values (v_device.org_id, v_device.user_id, 'tamper', 'no_heartbeat', v_prev, v_now);
    -- Not Tamper, so the refresh below opens whatever the status is now at v_now,
    -- even when that is Tamper again (a permission still missing).
    update public.presence set status = 'offline', since = v_now, tamper_reason = null
    where user_id = v_device.user_id;
  end if;

  v_idle_threshold := coalesce(
    (select (o.policy ->> 'idle_threshold_min')::int from public.orgs o where o.id = v_device.org_id), 10
  ) * 60;

  insert into public.last_seen (user_id, org_id, device_id, at, state)
  values (
    v_device.user_id, v_device.org_id, v_device.id, v_now,
    jsonb_build_object(
      'sent_at', sent_at, 'idle_s', idle_s, 'locked', locked, 'in_call', in_call,
      'permissions', coalesce(permissions, '{}'::jsonb)
    )
  )
  on conflict (user_id) do update
  set device_id = excluded.device_id, at = excluded.at, state = excluded.state;

  update public.presence p
  set last_contact_at = v_now,
      locked = agent_heartbeat.locked,
      idle = agent_heartbeat.idle_s >= v_idle_threshold
  where p.user_id = v_device.user_id;

  update public.devices d set agent_version = agent_heartbeat.agent_version where d.id = v_device.id;

  perform internal.refresh_presence(v_device.user_id, v_now);

  return jsonb_build_object(
    'server_time', v_now,
    'policy_version', (select o.policy_version from public.orgs o where o.id = v_device.org_id),
    'config_version', internal.user_config_version(v_device.user_id),
    'commands', '[]'::jsonb
  );
end;
$$;
