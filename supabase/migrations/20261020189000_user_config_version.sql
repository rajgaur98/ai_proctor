-- #146: a per-user config version, so one person's change refetches only their
-- devices. The heartbeat returns config_version = org policy_version + the user's
-- config_version; both only ever grow, so the sum moves whenever either does.
-- policy_version stays in the reply for older agents.
--
-- The org version moves for policy changes and notice publishing (everyone's config
-- changes). The user's moves for: their notice acknowledgement, their shifts, their
-- project assignments (AGT-05, AGT-08) and their timezone.

alter table public.users add column config_version int not null default 0;

create function internal.user_config_version(p_user_id uuid)
returns int
language sql
stable
security definer
set search_path = ''
as $$
  select o.policy_version + u.config_version
  from public.users u join public.orgs o on o.id = u.org_id
  where u.id = p_user_id;
$$;

revoke all on function internal.user_config_version(uuid) from public, anon, authenticated;

-- A person's timezone is part of their config.
create function internal.users_bump_config_version()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.config_version := old.config_version + 1;
  return new;
end;
$$;

create trigger users_timezone_config_version
before update of timezone on public.users
for each row
when (old.timezone is distinct from new.timezone)
execute function internal.users_bump_config_version();

revoke all on function internal.users_bump_config_version() from public, anon, authenticated;

-- Acknowledging bumps the person's version, not the org's (replaces the monitoring
-- notice migration's version) ------------------------------------------------------------

create or replace function public.acknowledge_notice(p_notice_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me public.users := internal.current_app_user();
  v_notice public.notices;
  v_new int;
begin
  select * into v_notice from public.notices n where n.id = p_notice_id and n.org_id = v_me.org_id;
  if not found then
    raise exception 'notice_not_found' using errcode = '42501';
  end if;
  if v_notice.version <> (select max(n.version) from public.notices n where n.org_id = v_me.org_id) then
    raise exception 'not_current_notice' using errcode = '22023';
  end if;
  insert into public.notice_acks (user_id, notice_id) values (v_me.id, v_notice.id)
  on conflict do nothing;
  get diagnostics v_new = row_count;
  if v_new = 1 then
    -- Their devices refetch their config when their version moves; the collection they may
    -- run with just changed for this person.
    update public.users set config_version = config_version + 1 where id = v_me.id;
    perform internal.audit(v_me.org_id, v_me.id, 'notice.acknowledged', v_me.id,
      jsonb_build_object('version', v_notice.version));
  end if;
end;
$$;

-- Shifts: only the person whose shifts changed refetches (replaces #29's version) ----------

create or replace function public.set_shifts(p_user_id uuid, p_shifts jsonb)
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

  -- Only this person's devices refetch their config.
  update public.users set config_version = config_version + 1 where id = p_user_id;
  perform internal.audit(v_target.org_id, v_me.id, 'member.shifts_changed', p_user_id,
    jsonb_build_object('from', v_before, 'to', p_shifts));
end;
$$;

-- Project assignments: the people added or removed refetch (replaces the projects
-- migration's version) ----------------------------------------------------------------------

create or replace function public.set_project_members(p_project_id uuid, p_user_ids uuid[])
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me public.users := internal.require_project_manager();
  v_org uuid;
begin
  select org_id into v_org from public.projects where id = p_project_id;
  if v_org is null or v_org <> v_me.org_id then
    raise exception 'project_not_found' using errcode = '42501';
  end if;
  if exists (
    select 1 from unnest(coalesce(p_user_ids, '{}')) as u(id)
    where not public.can_view_user(u.id)
  ) then
    raise exception 'user_not_visible' using errcode = '42501';
  end if;

  -- Only the people added or removed refetch their config (projects in the tray).
  with removed as (
    delete from public.project_members m
    where m.project_id = p_project_id
      and public.can_view_user(m.user_id)
      and not (m.user_id = any (coalesce(p_user_ids, '{}')))
    returning m.user_id
  ), added as (
    insert into public.project_members (project_id, user_id, org_id)
    select p_project_id, u.id, v_org from unnest(coalesce(p_user_ids, '{}')) as u(id)
    on conflict do nothing
    returning user_id
  )
  update public.users x set config_version = x.config_version + 1
  where x.id in (select user_id from removed union select user_id from added);
end;
$$;

-- Agent config and heartbeat with config_version (replace the notice migration's and
-- the status engine's versions) -----------------------------------------------------------

create or replace function public.agent_config(p_device_id uuid)
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
      -- The collection keys are what this person may run with (AGT-05).
      'policy', o.policy || internal.effective_collection(u.id),
      'policy_version', o.policy_version,
      -- What the heartbeat's config_version is compared with.
      'config_version', o.policy_version + u.config_version,
      'timezone', u.timezone,
      'shifts', coalesce((
        select jsonb_agg(jsonb_build_object('days', s.days, 'start', to_char(s.start_time, 'HH24:MI'),
          'end', to_char(s.end_time, 'HH24:MI'), 'timezone', s.timezone) order by s.start_time, s.days)
        from public.shifts s where s.user_id = u.id
      ), '[]'::jsonb),
      -- PRJ-02: what the person can pick in the tray and on the card.
      'projects', coalesce((
        select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name, 'client', c.name)
          order by c.name nulls first, p.name)
        from public.project_members m
        join public.projects p on p.id = m.project_id and not p.archived
        left join public.clients c on c.id = p.client_id
        where m.user_id = u.id
      ), '[]'::jsonb),
      -- AGT-04/05: the current version, whether this person acknowledged it, and
      -- the latest version they did acknowledge (null: never, so nothing runs).
      'notice', (
        select jsonb_build_object(
          'id', n.id, 'version', n.version, 'body', n.body,
          'acknowledged', exists (
            select 1 from public.notice_acks a where a.user_id = u.id and a.notice_id = n.id),
          'acknowledged_version', (
            select max(n2.version) from public.notice_acks a2
            join public.notices n2 on n2.id = a2.notice_id where a2.user_id = u.id)
        )
        from public.notices n where n.org_id = u.org_id
        order by n.version desc limit 1
      )
    )
    from public.users u
    join public.orgs o on o.id = u.org_id
    where u.id = v_device.user_id
  );
end;
$$;

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
    insert into public.status_periods (org_id, user_id, status, start_at, end_at)
    values (v_device.org_id, v_device.user_id, 'tamper', v_prev, v_now);
    -- The refresh below then opens the current status at v_now.
    update public.presence set status = 'tamper', since = v_prev where user_id = v_device.user_id;
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
