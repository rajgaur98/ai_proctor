-- #66: teams and per-team policy overrides (ORG-08, ADM-02), and the team filter in
-- reports and exports (#202: DSH-02, DSH-07, TS-20).
--
-- A team is a named group of people in one org. A person is in at most one team
-- (users.team_id, PRD section 8), so what applies to them is never ambiguous:
--   org policy (orgs.policy)  →  their team's overrides (teams.policy)  →  what their
--   acknowledged monitoring notice allows (internal.effective_collection, AGT-05)
-- A team overrides only the keys of team_policy_keys(): when and how check-ins run and
-- the agent's clock-in behaviour (PRD section 6: "Check-in min / max interval ... Org
-- (team override P1)"). Collection, retention, timesheet, alert and security keys stay
-- org-wide: what is collected is what the org's notice says, and the server-side jobs
-- read the org's values.
--
-- Teams are managed by owners and admins only, through the functions below; every change
-- is audit-logged (team.created, team.renamed, team.deleted, team.policy_changed,
-- member.team_changed). A change that can change what someone's agent runs with bumps
-- that person's config_version (#146), so only their devices refetch.
--
-- Who reads a team: owners and admins (all of the org's), and anyone who can see one of
-- its members (can_view_user: a manager reads the teams their reports are in; a person
-- reads their own).
--
-- Redefined here, each copied from its latest definition with only the team change:
--   agent_config           (20261020189000_user_config_version): + the team's overrides
--   agent_heartbeat        (20261020202130_heartbeat_config_version): Idle uses the
--                          person's idle threshold, their team's when it overrides it
--   team_live view         (20261020192000_tamper_reason): + team_id, appended
--   report_rows            (20261020197000_reports_scale): + p_team_id, + team_id per row
--   timesheet_export_rows  (20261020161000_timesheet_export): + p_team_id
-- report_rows and timesheet_export_rows get a new trailing argument, so the old
-- signatures are dropped (an overload would make named calls ambiguous). p_manager_id
-- stays: older callers keep working, and both filters can be combined.

-- Teams ------------------------------------------------------------------------------------

create table public.teams (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  name text not null constraint teams_name_length check (length(btrim(name)) between 1 and 80),
  -- The overrides: a subset of team_policy_keys(), validated by set_team_policy. A key
  -- that isn't here follows the org's policy.
  policy jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  -- For the composite foreign key from users: a person's team is in their own org.
  constraint teams_org_id_id_key unique (org_id, id)
);

create unique index teams_org_name_idx on public.teams (org_id, lower(btrim(name)));
alter table public.teams enable row level security;

alter table public.users add column team_id uuid;
alter table public.users
  add constraint users_team_fk foreign key (org_id, team_id)
  references public.teams (org_id, id) on delete set null (team_id);
create index users_team_id_idx on public.users (team_id) where team_id is not null;

-- A person's team decides part of their config: moving them refetches only their devices.
create trigger users_team_config_version
before update of team_id on public.users
for each row
when (old.team_id is distinct from new.team_id)
execute function internal.users_bump_config_version();

create policy "Teams visible to admins and to who can see a member"
on public.teams for select to authenticated
using (
  org_id = (select internal.jwt_org_id())
  and (
    exists (
      select 1 from public.users me
      where me.id = (select auth.uid()) and me.active and me.role in ('owner', 'admin'))
    or exists (
      select 1 from public.users m
      where m.team_id = teams.id and public.can_view_user(m.id))
  )
);

-- Policy -----------------------------------------------------------------------------------

-- The keys a team may override (ADM-02).
create function internal.team_policy_keys()
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array[
    'checkin_min_interval_min', 'checkin_max_interval_min', 'checkin_response_s',
    'idle_threshold_min', 'auto_clock_in', 'forgotten_clock_out_min'
  ];
$$;

-- Checks a team's overrides and returns them normalised (validate_policy: the org
-- policy's types and ranges). Raises 22023 with the key in DETAIL: unknown_policy_key,
-- not_team_policy_key (a real key that stays org-wide), invalid_policy. The interval is
-- overridden as a pair (both ends or neither), so a later org change can't leave a team
-- with its shortest interval above its longest.
create function internal.validate_team_policy(p_policy jsonb)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_out jsonb;
  v_key text;
begin
  v_out := internal.validate_policy(coalesce(p_policy, '{}'::jsonb));
  for v_key in select jsonb_object_keys(v_out) loop
    if not (v_key = any (internal.team_policy_keys())) then
      raise exception 'not_team_policy_key' using errcode = '22023', detail = v_key;
    end if;
  end loop;
  if (v_out ? 'checkin_min_interval_min') <> (v_out ? 'checkin_max_interval_min') then
    raise exception 'invalid_policy' using errcode = '22023',
      detail = case when v_out ? 'checkin_min_interval_min' then 'checkin_max_interval_min'
                    else 'checkin_min_interval_min' end;
  end if;
  if (v_out ->> 'checkin_min_interval_min')::int > (v_out ->> 'checkin_max_interval_min')::int then
    raise exception 'invalid_policy' using errcode = '22023', detail = 'checkin_max_interval_min';
  end if;
  return v_out;
end;
$$;

-- The overrides that apply to a person: their team's, limited to the team keys ({} when
-- they have no team or it overrides nothing).
create function internal.team_policy(p_user_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select jsonb_object_agg(e.key, e.value)
    from public.users u
    join public.teams t on t.id = u.team_id
    cross join lateral jsonb_each(t.policy) e
    where u.id = p_user_id and e.key = any (internal.team_policy_keys())
  ), '{}'::jsonb);
$$;

-- What is in force for a person, every key filled: the defaults, the org's policy, then
-- their team's overrides. (Collection keys are the org's; agent_config narrows them to
-- the person's acknowledged notice.)
create function internal.effective_policy(p_user_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select internal.policy_defaults() || o.policy || internal.team_policy(u.id)
  from public.users u join public.orgs o on o.id = u.org_id
  where u.id = p_user_id;
$$;

revoke all on function internal.team_policy_keys() from public, anon, authenticated;
revoke all on function internal.validate_team_policy(jsonb) from public, anon, authenticated;
revoke all on function internal.team_policy(uuid) from public, anon, authenticated;
revoke all on function internal.effective_policy(uuid) from public, anon, authenticated;

-- Managing teams (owners and admins) -------------------------------------------------------

-- The caller's team, for changing it: an owner or admin of its org, else team_not_found.
create function internal.require_team_admin(p_team_id uuid)
returns public.teams
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_me public.users := internal.current_app_user();
  v_team public.teams;
begin
  select * into v_team from public.teams where id = p_team_id and org_id = v_me.org_id;
  if not found then
    raise exception 'team_not_found' using errcode = '42501';
  end if;
  perform internal.require_org_admin(v_team.org_id);
  return v_team;
end;
$$;

revoke all on function internal.require_team_admin(uuid) from public, anon, authenticated;

-- ORG-08: creates (null id) or renames a team. Returns its id. Names are unique in the
-- org, ignoring case (name_taken).
create function public.save_team(p_team_id uuid, p_name text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me public.users := internal.current_app_user();
  v_team public.teams;
  v_name text := btrim(coalesce(p_name, ''));
  v_id uuid;
begin
  if length(v_name) not between 1 and 80 then
    raise exception 'invalid_name' using errcode = '22023';
  end if;
  if p_team_id is null then
    perform internal.require_org_admin(v_me.org_id);
    insert into public.teams (org_id, name) values (v_me.org_id, v_name) returning id into v_id;
    perform internal.audit(v_me.org_id, v_me.id, 'team.created', null,
      jsonb_build_object('team_id', v_id, 'name', v_name));
  else
    v_team := internal.require_team_admin(p_team_id);
    v_id := v_team.id;
    if v_name is distinct from v_team.name then
      update public.teams set name = v_name where id = v_team.id;
      perform internal.audit(v_me.org_id, v_me.id, 'team.renamed', null,
        jsonb_build_object('team_id', v_id, 'from', v_team.name, 'to', v_name));
    end if;
  end if;
  return v_id;
exception
  when unique_violation then raise exception 'name_taken' using errcode = '23505';
end;
$$;

-- ORG-08: the team's members become exactly p_user_ids. People named here move from
-- whatever team they were in; members left out are in no team afterwards. Each move is
-- audit-logged (member.team_changed) and refetches that person's config (the trigger).
create function public.set_team_members(p_team_id uuid, p_user_ids uuid[])
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_team public.teams := internal.require_team_admin(p_team_id);
  v_me public.users := internal.current_app_user();
  v_ids uuid[] := array(select distinct u from unnest(coalesce(p_user_ids, '{}'::uuid[])) u);
  r record;
begin
  if exists (
    select 1 from unnest(v_ids) i
    where i is null or not exists (
      select 1 from public.users u where u.id = i and u.org_id = v_team.org_id)
  ) then
    raise exception 'user_not_found' using errcode = '42501';
  end if;

  for r in
    select u.id, u.team_id as from_id, f.name as from_name,
           case when u.id = any (v_ids) then v_team.id end as to_id
    from public.users u
    left join public.teams f on f.id = u.team_id
    where u.org_id = v_team.org_id
      and (u.id = any (v_ids) or u.team_id = v_team.id)
      and u.team_id is distinct from case when u.id = any (v_ids) then v_team.id end
    order by u.id
  loop
    update public.users set team_id = r.to_id where id = r.id;
    perform internal.audit(v_team.org_id, v_me.id, 'member.team_changed', r.id,
      jsonb_build_object(
        'from', r.from_id, 'from_name', r.from_name,
        'to', r.to_id, 'to_name', case when r.to_id is not null then v_team.name end));
  end loop;
end;
$$;

-- ADM-02: the team's overrides become exactly p_policy (a key left out follows the org's
-- policy again; {} clears them all). Validated like the org's policy (validate_policy),
-- limited to team_policy_keys(). Like update_policy, an org that requires admin MFA changes
-- policy with a verified session only. A real change is audit-logged (team.policy_changed,
-- each key's from and to, null meaning the org's value) and refetches the members' config.
-- Returns { changed: [keys] }.
create function public.set_team_policy(p_team_id uuid, p_policy jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_team public.teams := internal.require_team_admin(p_team_id);
  v_me public.users := internal.current_app_user();
  v_next jsonb;
  v_changed jsonb;
begin
  -- Serialises with other changes to this team.
  perform 1 from public.teams where id = v_team.id for update;
  if coalesce((select (o.policy ->> 'require_admin_mfa')::boolean from public.orgs o
               where o.id = v_team.org_id), false)
     and coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' then
    raise exception 'mfa_required' using errcode = '42501';
  end if;

  v_next := internal.validate_team_policy(p_policy);
  select coalesce(jsonb_object_agg(k, jsonb_build_object('from', v_team.policy -> k, 'to', v_next -> k)),
                  '{}'::jsonb)
  into v_changed
  from (select jsonb_object_keys(v_team.policy) k union select jsonb_object_keys(v_next)) keys
  where (v_team.policy -> k) is distinct from (v_next -> k);

  if v_changed <> '{}'::jsonb then
    update public.teams set policy = v_next where id = v_team.id;
    update public.users set config_version = config_version + 1 where team_id = v_team.id;
    perform internal.audit(v_team.org_id, v_me.id, 'team.policy_changed', null,
      jsonb_build_object('team_id', v_team.id, 'name', v_team.name, 'changed', v_changed));
  end if;
  return jsonb_build_object(
    'changed', coalesce((select jsonb_agg(k order by k) from jsonb_object_keys(v_changed) k),
                        '[]'::jsonb));
end;
$$;

-- ORG-08: deletes a team. Its members are in no team afterwards (their config refetches
-- when the team overrode anything; the trigger bumps it either way).
create function public.delete_team(p_team_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_team public.teams := internal.require_team_admin(p_team_id);
  v_me public.users := internal.current_app_user();
  v_members jsonb;
begin
  select coalesce(jsonb_agg(u.id order by u.id), '[]'::jsonb) into v_members
  from public.users u where u.team_id = v_team.id;
  update public.users set team_id = null where team_id = v_team.id;
  delete from public.teams where id = v_team.id;
  perform internal.audit(v_team.org_id, v_me.id, 'team.deleted', null,
    jsonb_build_object('team_id', v_team.id, 'name', v_team.name, 'members', v_members,
                       'policy', v_team.policy));
end;
$$;

revoke all on function public.save_team(uuid, text) from public, anon;
revoke all on function public.set_team_members(uuid, uuid[]) from public, anon;
revoke all on function public.set_team_policy(uuid, jsonb) from public, anon;
revoke all on function public.delete_team(uuid) from public, anon;
grant execute on function public.save_team(uuid, text) to authenticated;
grant execute on function public.set_team_members(uuid, uuid[]) to authenticated;
grant execute on function public.set_team_policy(uuid, jsonb) to authenticated;
grant execute on function public.delete_team(uuid) to authenticated;

-- The agent's config: the team's overrides (copied from 20261020189000_user_config_version) --

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
      -- The org's policy, then their team's overrides (ADM-02); the collection keys are
      -- what this person may run with (AGT-05).
      'policy', o.policy || internal.team_policy(u.id) || internal.effective_collection(u.id),
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

-- Heartbeat: Idle by the person's threshold (copied from
-- 20261020202130_heartbeat_config_version) ---------------------------------------------------

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
    (internal.effective_policy(v_device.user_id) ->> 'idle_threshold_min')::int, 10
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

-- Live grid (DSH-02): the team joins the row, appended (copied from
-- 20261020192000_tamper_reason) ---------------------------------------------------------------

create or replace view public.team_live
with (security_invoker = on)
as
select
  u.id as user_id,
  u.org_id,
  u.full_name,
  u.role,
  u.manager_id,
  u.timezone,
  p.status,
  p.since,
  p.last_checkin_at,
  p.last_checkin_outcome,
  p.project_id,
  -- Today, in the employee's own time zone.
  coalesce(today.shown, 0) as checkins_shown_today,
  coalesce(today.passed, 0) as checkins_passed_today,
  exists (
    select 1 from public.shifts s
    where s.user_id = u.id
      and extract(isodow from now() at time zone s.timezone)::int = any (s.days)
  ) as scheduled_today,
  p.tamper_reason,
  u.team_id
from public.users u
join public.presence p on p.user_id = u.id
left join lateral (
  select
    count(*) filter (where c.outcome <> 'deferred')::int as shown,
    count(*) filter (where c.outcome = 'pass')::int as passed
  from public.checkin_events c
  where c.user_id = u.id
    and c.scheduled_at >= (date_trunc('day', now() at time zone u.timezone) at time zone u.timezone)
) today on true
where u.active;

-- Reports (DSH-07, #202): filter by team (copied from 20261020197000_reports_scale) -----------

drop function public.report_rows(date, date, uuid[], uuid);

create function public.report_rows(
  p_from date,
  p_to date,
  p_user_ids uuid[] default null,
  p_manager_id uuid default null,
  p_team_id uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_me public.users := internal.current_app_user();
  -- The most people one report holds. The whole report is one response the dashboard
  -- sorts, pages and adds up itself, so it has a ceiling; the PRD's pilot orgs are ~500.
  c_max_people constant int := 1000;
  v_people int;
  v_grace_min int;
  v_rows jsonb;
  v_team_median float8;
begin
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 365 then
    raise exception 'invalid_range' using errcode = '22023';
  end if;
  if coalesce(cardinality(p_user_ids), 0) > 0
     and exists (select 1 from unnest(p_user_ids) u where u is null or not public.can_view_user(u)) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  -- Over the ceiling the caller narrows to a team (p_team_id) or to names rather than
  -- get a report whose totals leave people out. Counted the way the report picks people,
  -- cheaply: deactivated people count only when they have data in the span.
  select count(*)::int into v_people
  from (
    select 1
    from public.users u
    where u.org_id = v_me.org_id
      and public.can_view_user(u.id)
      and (coalesce(cardinality(p_user_ids), 0) = 0 or u.id = any (p_user_ids))
      and (u.id <> v_me.id or u.id = any (coalesce(p_user_ids, '{}'::uuid[])))
      and (p_manager_id is null or u.manager_id = p_manager_id)
      and (p_team_id is null or u.team_id = p_team_id)
      and (u.active
           or exists (select 1 from public.time_segments t
                      where t.user_id = u.id and t.day between p_from and p_to)
           or exists (select 1 from public.checkin_events c
                      where c.user_id = u.id
                        and coalesce(c.shown_at, c.scheduled_at) >= p_from::timestamp at time zone u.timezone
                        and coalesce(c.shown_at, c.scheduled_at) < (p_to + 1)::timestamp at time zone u.timezone))
    limit c_max_people + 1
  ) c;
  if v_people > c_max_people then
    raise exception 'too_many_people' using errcode = '54000',
      detail = format('A report holds up to %s people; choose a team.', c_max_people);
  end if;

  select greatest(5, least(60, coalesce((o.policy ->> 'late_clock_in_min')::int, 15)))
  into v_grace_min
  from public.orgs o
  where o.id = v_me.org_id;

  with p as (
    select u.id, u.full_name, u.manager_id, u.team_id, u.active,
      p_from::timestamp at time zone u.timezone as from_at,
      (p_to + 1)::timestamp at time zone u.timezone as to_at
    from public.users u
    where u.org_id = v_me.org_id
      and public.can_view_user(u.id)
      and (coalesce(cardinality(p_user_ids), 0) = 0 or u.id = any (p_user_ids))
      and (u.id <> v_me.id or u.id = any (coalesce(p_user_ids, '{}'::uuid[])))
      and (p_manager_id is null or u.manager_id = p_manager_id)
      and (p_team_id is null or u.team_id = p_team_id)
  ),
  r as (
    select p.full_name, p.id as user_id, chk.pass_ms,
      jsonb_build_object(
        'user_id', p.id,
        'full_name', p.full_name,
        'manager_id', p.manager_id,
        'team_id', p.team_id,
        'worked_s', seg.worked_s,
        'flagged_s', seg.flagged_s,
        'excluded_s', seg.excluded_s,
        'break_s', seg.break_s,
        'pause_s', seg.pause_s,
        'manual_s', seg.manual_s,
        'checkins_shown', chk.shown,
        'checkins_passed', chk.passed,
        'checkins_missed', chk.missed,
        'checkins_failed', chk.failed,
        'response_rate', case when chk.shown > 0 then chk.passed::float8 / chk.shown end,
        'median_response_ms', chk.median_response_ms,
        'late_clock_ins', late.n
      ) as row
    from p
    cross join lateral (
      select
        count(*) as n,
        coalesce(round(sum(extract(epoch from t.end_at - t.start_at))
          filter (where t.counted and not t.excluded)), 0)::bigint as worked_s,
        coalesce(round(sum(extract(epoch from t.end_at - t.start_at))
          filter (where t.flagged and not t.excluded)), 0)::bigint as flagged_s,
        coalesce(round(sum(extract(epoch from t.end_at - t.start_at))
          filter (where t.excluded)), 0)::bigint as excluded_s,
        coalesce(round(sum(extract(epoch from t.end_at - t.start_at))
          filter (where t.type = 'break')), 0)::bigint as break_s,
        coalesce(round(sum(extract(epoch from t.end_at - t.start_at))
          filter (where t.type in ('pause', 'pause_over_cap'))), 0)::bigint as pause_s,
        coalesce(round(sum(extract(epoch from t.end_at - t.start_at))
          filter (where t.type = 'manual' and t.counted and not t.excluded)), 0)::bigint as manual_s
      from public.time_segments t
      where t.user_id = p.id and t.day between p_from and p_to
    ) seg
    cross join lateral (
      select
        count(*) filter (where c.outcome::text <> 'deferred')::int as shown,
        count(*) filter (where c.outcome::text = 'pass')::int as passed,
        count(*) filter (where c.outcome::text = 'miss')::int as missed,
        count(*) filter (where c.outcome::text = 'failed')::int as failed,
        percentile_cont(0.5) within group (order by c.response_ms)
          filter (where c.outcome::text = 'pass' and c.response_ms is not null) as median_response_ms,
        array_agg(c.response_ms) filter (where c.outcome::text = 'pass' and c.response_ms is not null) as pass_ms
      from public.checkin_events c
      where c.user_id = p.id
        and coalesce(c.shown_at, c.scheduled_at) >= p.from_at
        and coalesce(c.shown_at, c.scheduled_at) < p.to_at
    ) chk
    cross join lateral (
      select count(*)::int as n
      from (
        select
          ((p_from + g.n) + s.start_time) at time zone s.timezone as starts_at,
          ((p_from + g.n + case when s.end_time <= s.start_time then 1 else 0 end) + s.end_time)
            at time zone s.timezone as ends_at
        from public.shifts s
        cross join generate_series(0, p_to - p_from) as g (n)
        where s.user_id = p.id and extract(isodow from p_from + g.n)::int = any (s.days)
      ) o
      where exists (
          select 1 from public.clock_sessions cs
          where cs.user_id = p.id
            and cs.start_at > o.starts_at + make_interval(mins => v_grace_min)
            and cs.start_at < o.ends_at)
        and not exists (
          select 1 from public.clock_sessions cs
          where cs.user_id = p.id
            and cs.start_at <= o.starts_at + make_interval(mins => v_grace_min)
            and coalesce(cs.end_at, 'infinity'::timestamptz) > o.starts_at)
    ) late
    where p.active or seg.n > 0 or chk.shown > 0
  )
  select coalesce(jsonb_agg(r.row order by r.full_name, r.user_id), '[]'::jsonb),
    -- The team's median is over every passed check-in of these people, not a median of
    -- their medians: the response times each person's row was built from, taken together
    -- (not read again from checkin_events).
    (select percentile_cont(0.5) within group (order by ms)
     from r r2 cross join lateral unnest(r2.pass_ms) as ms)
  into v_rows, v_team_median
  from r;

  return jsonb_build_object(
    'row_count', jsonb_array_length(v_rows),
    'late_grace_min', v_grace_min,
    'team_median_response_ms', v_team_median,
    'rows', v_rows
  );
end;
$$;

revoke all on function public.report_rows(date, date, uuid[], uuid, uuid) from public, anon;
grant execute on function public.report_rows(date, date, uuid[], uuid, uuid) to authenticated;

-- Timesheet export (TS-20, #202): filter by team (copied from 20261020161000_timesheet_export).
-- p_team_id: people in this team, alongside the other filters (p_manager_id still narrows
-- to one manager's direct reports).

drop function public.timesheet_export_rows(date, date, text, uuid[], uuid, uuid[], uuid[], text[]);

create function public.timesheet_export_rows(
  p_from date,
  p_to date,
  p_view text,
  p_user_ids uuid[] default null,
  p_manager_id uuid default null,
  p_client_ids uuid[] default null,
  p_project_ids uuid[] default null,
  p_statuses text[] default null,
  p_team_id uuid default null
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
begin
  if p_view is null or p_view not in ('daily', 'project', 'segments') then
    raise exception 'invalid_view' using errcode = '22023';
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

  return jsonb_build_object('row_count', v_count, 'rows', v_rows);
end;
$$;

revoke all on function public.timesheet_export_rows(date, date, text, uuid[], uuid, uuid[], uuid[], text[], uuid)
  from public, anon;
grant execute on function public.timesheet_export_rows(date, date, text, uuid[], uuid, uuid[], uuid[], text[], uuid)
  to authenticated;
