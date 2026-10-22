-- #168: a per-person assistive-input exemption from the Windows injected-click guard
-- (ANT-02, NFR-UX-02). Accessibility tools that click for someone (Windows Voice Access,
-- switch access, eye tracking) inject their clicks, and the guard swallows injected
-- clicks on the check-in card, so those people could never answer it.
--
-- An admin marks a person as using assistive input on People (update_member). For that
-- person the agent lets injected clicks on the card through; it still counts them and the
-- check-in still carries `injected_click:n`, so the day still gets a "needs review" flag
-- (ANT-08: never blocked, never a penalty). macOS is unchanged: synthetic clicks were
-- already flag-only there (ANT-03).
--
-- 1. users.assistive_input, default off. Users have no update policy, so only the RPC
--    below writes it. A change bumps the person's config_version (#146), so their devices
--    refetch the config.
-- 2. update_member takes it (latest definition: 20261020188000_delegation_cleanup). The
--    new argument defaults to null, "leave as is", so existing callers are unchanged. A
--    change is audit-logged as member.assistive_input_changed {from, to}.
-- 3. agent_config returns it as `assistive_input` (latest definition: 20261022100000_teams).
-- 4. internal.anticheat_from_checkin (latest definition: 20261021210304_anticheat_extras)
--    notes on the injected_click flag whether the person had the exemption when the
--    check-in arrived (`assistive_input` in the details; the latest check-in of the day
--    wins), so the day page can say the clicks were accepted rather than blocked.

-- 1. The setting -------------------------------------------------------------------------------

alter table public.users add column assistive_input boolean not null default false;

comment on column public.users.assistive_input is
  '#168: uses assistive input. Injected clicks on the check-in card are accepted (still flagged for review) instead of blocked (ANT-02). Set by admins through update_member; audit-logged.';

create trigger users_assistive_input_config_version
before update of assistive_input on public.users
for each row
when (old.assistive_input is distinct from new.assistive_input)
execute function internal.users_bump_config_version();

-- 2. update_member (copied from 20261020188000_delegation_cleanup; adds p_assistive_input) ----

drop function public.update_member(uuid, text, public.user_role, uuid, text, text, text);

-- ORG-03..06: name, role, direct manager, work location and time zone of a member. Made an
-- employee, a person's live delegations end (#147): nothing to approve for, nobody to
-- approve as. #168: whether they use assistive input (null: unchanged).
create function public.update_member(
  p_user_id uuid,
  p_full_name text,
  p_role public.user_role,
  p_manager_id uuid,
  p_work_country text,
  p_work_state text,
  p_timezone text,
  p_assistive_input boolean default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_target public.users;
  v_me public.users;
  v_sheets int;
  v_entries int;
begin
  select * into v_target from public.users where id = p_user_id;
  if not found then
    raise exception 'user_not_found' using errcode = '42501';
  end if;
  v_me := internal.require_org_admin(v_target.org_id);
  if v_target.role = 'owner' and v_me.role <> 'owner' then
    raise exception 'owner_only' using errcode = '42501';
  end if;
  if p_role is distinct from v_target.role then
    if v_target.id = v_me.id then
      raise exception 'cannot_change_own_role' using errcode = '42501';
    end if;
    if p_role = 'owner' or v_target.role = 'owner' then
      raise exception 'cannot_change_owner' using errcode = '42501';
    end if;
  end if;
  if length(trim(coalesce(p_full_name, ''))) not between 1 and 120 then
    raise exception 'invalid_name' using errcode = '22023';
  end if;
  perform internal.check_member(v_target.org_id, v_target.id, p_role, p_manager_id,
    p_work_country, p_work_state, p_timezone);
  -- People who report to someone made an employee would be left without a manager.
  if p_role = 'employee' and v_target.role <> 'employee'
    and exists (select 1 from public.users where manager_id = v_target.id and active)
  then
    raise exception 'has_reports' using errcode = '22023';
  end if;

  update public.users
  set full_name = trim(p_full_name), role = p_role,
      manager_id = case when p_role = 'owner' then null else p_manager_id end,
      work_country = p_work_country, work_state = p_work_state, timezone = p_timezone,
      assistive_input = coalesce(p_assistive_input, v_target.assistive_input)
  where id = v_target.id;

  -- AUD-01: role and reporting-line changes; location too (it changes what's
  -- collected, e.g. Illinois).
  if p_role is distinct from v_target.role then
    perform internal.audit(v_target.org_id, v_me.id, 'member.role_changed', v_target.id,
      jsonb_build_object('from', v_target.role, 'to', p_role));
    if p_role = 'employee' then
      perform internal.end_delegations_of(v_target.org_id, v_me.id, v_target.id, 'demoted');
    end if;
  end if;
  if p_role <> 'owner' and p_manager_id is distinct from v_target.manager_id then
    perform internal.audit(v_target.org_id, v_me.id, 'member.manager_changed', v_target.id,
      jsonb_build_object('from', v_target.manager_id, 'to', p_manager_id));

    -- TS-15: what the new manager now has to decide.
    select count(*)::int into v_sheets from public.timesheets t
    where t.user_id = v_target.id and t.status = 'submitted';
    select count(*)::int into v_entries from public.manual_entries e
    where e.user_id = v_target.id and e.status = 'pending';
    if v_sheets > 0 or v_entries > 0 then
      perform internal.audit(v_target.org_id, v_me.id, 'timesheet.reassigned', v_target.id,
        jsonb_build_object('from', v_target.manager_id, 'to', p_manager_id,
          'timesheets', v_sheets, 'manual_entries', v_entries));
      perform internal.notify(v_target.org_id, p_manager_id, 'timesheet.reassigned',
        jsonb_build_object('user_id', v_target.id, 'from', v_target.manager_id,
          'timesheets', v_sheets, 'manual_entries', v_entries));
    end if;
  end if;
  if (p_work_country, p_work_state) is distinct from (v_target.work_country, v_target.work_state) then
    perform internal.audit(v_target.org_id, v_me.id, 'member.location_changed', v_target.id,
      jsonb_build_object(
        'from', jsonb_build_object('country', v_target.work_country, 'state', v_target.work_state),
        'to', jsonb_build_object('country', p_work_country, 'state', p_work_state)));
  end if;
  -- #168: it changes what the check-in card accepts.
  if p_assistive_input is not null and p_assistive_input is distinct from v_target.assistive_input then
    perform internal.audit(v_target.org_id, v_me.id, 'member.assistive_input_changed', v_target.id,
      jsonb_build_object('from', v_target.assistive_input, 'to', p_assistive_input));
  end if;
end;
$$;

revoke all on function public.update_member(uuid, text, public.user_role, uuid, text, text, text, boolean)
  from public, anon;
grant execute on function public.update_member(uuid, text, public.user_role, uuid, text, text, text, boolean)
  to authenticated;

-- 3. The agent's config (copied from 20261022100000_teams; adds assistive_input) -------------

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
      -- #168: injected clicks on the card are accepted (and still flagged), not blocked.
      'assistive_input', u.assistive_input,
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

-- 4. Check-in flags (copied from 20261021210304_anticheat_extras; injected_click notes the
--    exemption) ----------------------------------------------------------------------------

create or replace function internal.anticheat_from_checkin()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_day date;
  v_assistive boolean;
  v_found record;
begin
  select (new.scheduled_at at time zone u.timezone)::date, u.assistive_input
  into v_day, v_assistive
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
        -- #168: whether the person's agent lets these clicks through (assistive input).
        when p.kind = 'injected_click' then
          jsonb_build_object('clicks', sum(coalesce(p.n, 1)),
            'assistive_input', coalesce(v_assistive, false))
        when p.kind = 'synthetic_click' then
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
