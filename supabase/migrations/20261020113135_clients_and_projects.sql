-- #38: clients and projects (PRJ-01..03). Admins and managers keep the list and
-- say who can log to each project; the agent gets a person's projects with its
-- config. Project choice is optional: time without one is Unassigned, and a
-- project someone may not use is never an error that loses a clock-in or a
-- check-in: it's recorded as Unassigned. Retroactive assignment (PRJ-04) comes
-- with time segments (#40, #41).

create table public.clients (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 120),
  archived boolean not null default false,
  created_at timestamptz not null default now()
);
create unique index clients_org_name_idx on public.clients (org_id, lower(name));

create table public.projects (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  client_id uuid references public.clients (id) on delete set null,
  name text not null check (length(trim(name)) between 1 and 120),
  billable boolean not null default true,
  archived boolean not null default false,
  created_at timestamptz not null default now()
);
create unique index projects_org_client_name_idx
  on public.projects (org_id, coalesce(client_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(name));

create table public.project_members (
  project_id uuid not null references public.projects (id) on delete cascade,
  user_id uuid not null references public.users (id) on delete cascade,
  org_id uuid not null references public.orgs (id) on delete cascade,
  primary key (project_id, user_id)
);
create index project_members_user_idx on public.project_members (user_id);

-- The project columns added in #9 / #23 now point at real projects.
alter table public.clock_sessions
  add constraint clock_sessions_project_fk foreign key (project_id)
  references public.projects (id) on delete set null;
alter table public.checkin_events
  add constraint checkin_events_project_fk foreign key (project_id)
  references public.projects (id) on delete set null;
alter table public.presence
  add constraint presence_project_fk foreign key (project_id)
  references public.projects (id) on delete set null;

alter table public.clients enable row level security;
alter table public.projects enable row level security;
alter table public.project_members enable row level security;

-- Names only: everyone in the org can read the lists (managers see project names
-- in timesheets, employees in the tray).
create policy "Members read their org's clients"
on public.clients for select to authenticated
using (org_id = (select internal.jwt_org_id()));
create policy "Members read their org's projects"
on public.projects for select to authenticated
using (org_id = (select internal.jwt_org_id()));
create policy "Assignments visible per can_view_user"
on public.project_members for select to authenticated
using (org_id = (select internal.jwt_org_id()) and public.can_view_user(user_id));

-- Helpers ------------------------------------------------------------------------------

-- The caller may manage projects: an active owner, admin or manager.
create function internal.require_project_manager()
returns public.users
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  me public.users := internal.current_app_user();
begin
  if me.role not in ('owner', 'admin', 'manager') then
    raise exception 'manager_or_admin_only' using errcode = '42501';
  end if;
  return me;
end;
$$;

-- `p_project` if the person is assigned to it and it isn't archived; else null.
create function internal.allowed_project(p_user_id uuid, p_project text)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select p.id
  from public.projects p
  join public.project_members m on m.project_id = p.id and m.user_id = p_user_id
  where p.id::text = nullif(p_project, '') and not p.archived;
$$;

revoke all on function internal.require_project_manager() from public, anon, authenticated;
revoke all on function internal.allowed_project(uuid, text) from public, anon, authenticated;

-- RPCs ---------------------------------------------------------------------------------

-- Creates (null id) or updates a client. Returns its id.
create function public.save_client(p_id uuid, p_name text, p_archived boolean default false)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me public.users := internal.require_project_manager();
  v_id uuid;
begin
  if p_id is null then
    insert into public.clients (org_id, name, archived)
    values (v_me.org_id, trim(p_name), coalesce(p_archived, false))
    returning id into v_id;
  else
    update public.clients set name = trim(p_name), archived = coalesce(p_archived, false)
    where id = p_id and org_id = v_me.org_id
    returning id into v_id;
    if v_id is null then
      raise exception 'client_not_found' using errcode = '42501';
    end if;
  end if;
  return v_id;
exception
  when unique_violation then raise exception 'name_taken' using errcode = '23505';
  when check_violation then raise exception 'invalid_name' using errcode = '22023';
end;
$$;

-- Creates (null id) or updates a project. Returns its id.
create function public.save_project(
  p_id uuid,
  p_name text,
  p_client_id uuid default null,
  p_billable boolean default true,
  p_archived boolean default false
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me public.users := internal.require_project_manager();
  v_id uuid;
begin
  if p_client_id is not null
    and not exists (select 1 from public.clients where id = p_client_id and org_id = v_me.org_id)
  then
    raise exception 'client_not_found' using errcode = '42501';
  end if;
  if p_id is null then
    insert into public.projects (org_id, client_id, name, billable, archived)
    values (v_me.org_id, p_client_id, trim(p_name), coalesce(p_billable, true), coalesce(p_archived, false))
    returning id into v_id;
  else
    update public.projects
    set client_id = p_client_id, name = trim(p_name), billable = coalesce(p_billable, true),
        archived = coalesce(p_archived, false)
    where id = p_id and org_id = v_me.org_id
    returning id into v_id;
    if v_id is null then
      raise exception 'project_not_found' using errcode = '42501';
    end if;
  end if;
  return v_id;
exception
  when unique_violation then raise exception 'name_taken' using errcode = '23505';
  when check_violation then raise exception 'invalid_name' using errcode = '22023';
end;
$$;

-- Sets who can log to a project. A manager may only add or remove people they can
-- see (their reports); everyone else on the project stays as it is.
create function public.set_project_members(p_project_id uuid, p_user_ids uuid[])
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

  delete from public.project_members m
  where m.project_id = p_project_id
    and public.can_view_user(m.user_id)
    and not (m.user_id = any (coalesce(p_user_ids, '{}')));
  insert into public.project_members (project_id, user_id, org_id)
  select p_project_id, u.id, v_org from unnest(coalesce(p_user_ids, '{}')) as u(id)
  on conflict do nothing;
  -- Agents refetch their config (projects in the tray) when the version moves.
  update public.orgs set policy_version = policy_version + 1 where id = v_org;
end;
$$;

revoke all on function public.save_client(uuid, text, boolean) from public, anon;
revoke all on function public.save_project(uuid, text, uuid, boolean, boolean) from public, anon;
revoke all on function public.set_project_members(uuid, uuid[]) from public, anon;
grant execute on function public.save_client(uuid, text, boolean) to authenticated;
grant execute on function public.save_project(uuid, text, uuid, boolean, boolean) to authenticated;
grant execute on function public.set_project_members(uuid, uuid[]) to authenticated;

-- Agent config with the person's projects (replaces #29's version) ----------------------

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
      'policy', o.policy,
      'policy_version', o.policy_version,
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
      ), '[]'::jsonb)
    )
    from public.users u
    join public.orgs o on o.id = u.org_id
    where u.id = v_device.user_id
  );
end;
$$;

-- Event projection: only projects the person may use (replaces #25's version) -------------

create or replace function internal.apply_event(
  p_device public.devices,
  p_event_id uuid,
  p_type text,
  p_at timestamptz,
  p_payload jsonb
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  s internal.shift_state := internal.shift_state(p_device.user_id);
  v_reason text;
  v_project uuid;
begin
  insert into public.presence (user_id, org_id) values (p_device.user_id, p_device.org_id)
  on conflict (user_id) do nothing;

  case p_type
  when 'clock_in' then
    if s.state <> 'off_shift' then return 'already_clocked_in'; end if;
    -- PRJ-03: a project the person can't log to is recorded as Unassigned.
    v_project := internal.allowed_project(p_device.user_id, p_payload ->> 'project_id');
    insert into public.clock_sessions (org_id, user_id, device_id, project_id, start_at, start_event_id)
    values (p_device.org_id, p_device.user_id, p_device.id, v_project, p_at, p_event_id);
    -- A new shift starts clean.
    update public.presence
    set project_id = v_project,
        locked = false, idle = false, call_sources = '{}', last_checkin_outcome = null
    where user_id = p_device.user_id;

  when 'clock_out' then
    if s.state = 'off_shift' then return 'not_clocked_in'; end if;
    update public.breaks set end_at = greatest(start_at, p_at) where id = s.break_id;
    update public.pauses set end_at = greatest(start_at, p_at) where id = s.pause_id;
    update public.clock_sessions
    set end_at = greatest(start_at, p_at), end_reason = p_payload ->> 'reason', end_event_id = p_event_id
    where id = s.clock_session_id;

  when 'break_start' then
    if s.state = 'off_shift' then return 'not_clocked_in'; end if;
    if s.state = 'on_break' then return 'already_on_break'; end if;
    if s.state = 'paused' then return 'paused'; end if;
    insert into public.breaks (org_id, user_id, clock_session_id, start_at, planned_min)
    values (p_device.org_id, p_device.user_id, s.clock_session_id, p_at,
            (p_payload ->> 'planned_min')::int);

  when 'break_end' then
    if s.state <> 'on_break' then return 'not_on_break'; end if;
    update public.breaks set end_at = greatest(start_at, p_at) where id = s.break_id;

  when 'pause_start' then
    if s.state = 'off_shift' then return 'not_clocked_in'; end if;
    if s.state = 'on_break' then return 'on_break'; end if;
    if s.state = 'paused' then return 'already_paused'; end if;
    insert into public.pauses (org_id, user_id, clock_session_id, start_at, planned_min)
    values (p_device.org_id, p_device.user_id, s.clock_session_id, p_at,
            (p_payload ->> 'planned_min')::int);

  when 'pause_end' then
    if s.state <> 'paused' then return 'not_paused'; end if;
    update public.pauses set end_at = greatest(start_at, p_at) where id = s.pause_id;

  when 'project_switch' then
    if s.state = 'off_shift' then return 'not_clocked_in'; end if;
    v_project := internal.allowed_project(p_device.user_id, p_payload ->> 'project_id');
    if v_project is null and nullif(p_payload ->> 'project_id', '') is not null then
      return 'project_not_allowed';
    end if;
    update public.presence set project_id = v_project where user_id = p_device.user_id;

  when 'checkin' then
    if s.state <> 'working' then return 'checkin_while_' || s.state; end if;
    begin
      insert into public.checkin_events (
        id, org_id, user_id, device_id, project_id, scheduled_at, shown_at, responded_at,
        outcome, response_ms, wrong_clicks, idle_s_at_show, device_state, object_keys,
        flags, capture_errors
      )
      values (
        p_event_id, p_device.org_id, p_device.user_id, p_device.id,
        internal.allowed_project(p_device.user_id, p_payload ->> 'project_id'),
        (p_payload ->> 'scheduled_at')::timestamptz,
        (p_payload ->> 'shown_at')::timestamptz,
        (p_payload ->> 'responded_at')::timestamptz,
        (p_payload ->> 'outcome')::public.checkin_outcome,
        (p_payload ->> 'response_ms')::int,
        (p_payload ->> 'wrong_clicks')::int,
        (p_payload ->> 'idle_s_at_show')::int,
        p_payload ->> 'device_state',
        array(select jsonb_array_elements_text(p_payload -> 'object_keys')),
        array(select jsonb_array_elements_text(p_payload -> 'flags')),
        p_payload -> 'capture_errors'
      );
    exception when check_violation then
      return 'invalid_checkin';
    end;
    update public.presence
    set last_checkin_at = p_at, last_checkin_outcome = (p_payload ->> 'outcome')::public.checkin_outcome
    where user_id = p_device.user_id;

  when 'app_session' then
    -- Judged by its own time, not the current state: the agent sends the last
    -- minute's bucket after the break or clock-out that ended it.
    v_reason := internal.record_activity(p_device, p_event_id, p_payload);
    if v_reason is not null then return v_reason; end if;

  when 'permission_change' then
    -- Tamper while a capture permission is missing (STS rule 2). Camera only
    -- counts when the org has the webcam on.
    update public.presence p
    set permission_missing = (p_payload ->> 'screen') <> 'granted'
      or ((p_payload ->> 'camera') <> 'granted'
          and coalesce((select (o.policy ->> 'webcam')::boolean from public.orgs o where o.id = p.org_id), true))
    where p.user_id = p_device.user_id;

  else
    if s.state = 'off_shift' then return 'not_clocked_in'; end if;
    case p_type
    when 'lock', 'sleep' then
      update public.presence set locked = true where user_id = p_device.user_id;
    when 'unlock', 'wake' then
      update public.presence set locked = false where user_id = p_device.user_id;
    when 'idle_start' then
      update public.presence set idle = true where user_id = p_device.user_id;
    when 'idle_end' then
      update public.presence set idle = false where user_id = p_device.user_id;
    when 'call_start' then
      update public.presence
      set call_sources = array(select distinct unnest(call_sources || array[p_payload ->> 'source']))
      where user_id = p_device.user_id;
    when 'call_end' then
      update public.presence set call_sources = array_remove(call_sources, p_payload ->> 'source')
      where user_id = p_device.user_id;
    else
      null;
    end case;
  end case;

  update public.presence set last_contact_at = now() where user_id = p_device.user_id;
  perform internal.refresh_presence(p_device.user_id, p_at);
  return null;
end;
$$;

revoke all on function internal.apply_event(public.devices, uuid, text, timestamptz, jsonb)
  from public, anon, authenticated;
