-- #52: admin policy settings and region presets (ADM-01, CAP-05, AUD-01, TS-16).
--
-- orgs.policy (jsonb) holds every configurable value of PRD section 6. Each key is read
-- by the code that owns it, with its own default when the key is missing; this
-- migration adds the one place that writes them:
--   region_preset(region)   the full default policy per region (PRD 5.1). New orgs start
--                           from it (create_org), and the settings page fills its form
--                           from it when an admin picks a preset.
--   update_policy(...)      validates every key (type, range, enum; unknown keys are
--                           refused), applies the region caps (EU image retention at
--                           most 30 days), asks for the DPIA (and works council)
--                           confirmation when webcam capture is switched on in an EU
--                           org (CAP-05), audit-logs the change (AUD-01) and bumps
--                           policy_version so agents refetch at their next sync. A
--                           change to a collection key publishes a new monitoring
--                           notice through #48's orgs_republish_notice trigger.
--   policy_settings()       what the page loads: the policy with defaults filled in,
--                           the presets, the region and who it applies to.
--   set_approval_required   TS-16: a person whose timesheet needs no manager approval.
--
-- Keys, defaults and ranges (US / EU / India differ only where marked):
--   Check-ins   checkin_min_interval_min 20 (EU 45), checkin_max_interval_min 90 (EU 120),
--               both 10..240, min <= max (CHK-01, section 6); checkin_response_s 90, 30..300
--               (CHK-13); idle_threshold_min 10, 3..60.
--   Capture     screenshots full | blurred | off (EU blurred); webcam (EU false);
--               window_titles (EU false); excluded_apps (text list, up to 100);
--               activity_sampling true.
--   Shifts      auto_clock_in false; forgotten_clock_out_min 30, 10..120.
--   Breaks      breaks_paid false; break_daily_max_min null (no limit) or 1..1440;
--               pause_max_min 15, 0..60; pause_daily_max_min 60, 0..240 (BRK-06).
--   Timesheets  week_start monday..sunday; late_clock_in_min 15, 5..60.
--   Alerts      alert_<kind>_enabled true for consecutive_misses, offline, tamper,
--               late_clock_in, pause_over_cap; alert_consecutive_misses 3, 1..10;
--               alert_offline_min 15, 5..240.
--   Retention   image_retention_days 30, 7..90 (EU: at most 30); event_retention_months
--               12, 3..36; timesheet_retention_years 3, 3..10 (ADM-03).
--   Anti-cheat  anticheat_min_passes 5, 3..50; anticheat_max_cv 0.1, 0.01..0.5.
--   Security    require_admin_mfa false.

-- Presets ----------------------------------------------------------------------------------

-- The full default policy for a region (PRD 5.1). The excluded apps are the password
-- managers the agent already ships with (CAP-04).
create function internal.region_preset(p_region public.region_preset)
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
    'image_retention_days', 30,
    'event_retention_months', 12,
    'timesheet_retention_years', 3,
    'anticheat_min_passes', 5,
    'anticheat_max_cv', 0.1,
    'require_admin_mfa', false
  );
$$;

-- What a key means when the org has not stored it: the values the code already falls
-- back to (so the page shows what is in force). Only the excluded apps differ from
-- the US preset.
create function internal.policy_defaults()
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select internal.region_preset('us') || '{"excluded_apps": []}'::jsonb;
$$;

-- Countries where a works council is usually involved (PRD 5.2: Germany, France, the
-- Netherlands). Webcam capture in an EU org also asks for the works council
-- consultation when someone works from one of them. Extend the list here.
create function internal.works_council_countries()
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array['DE', 'FR', 'NL'];
$$;

-- Validation -------------------------------------------------------------------------------

-- Every settable key, its kind and its limits. kind: bool | enum | int | num | apps.
create function internal.policy_spec()
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
    ('image_retention_days', 'int', 7, 90, null),
    ('event_retention_months', 'int', 3, 36, null),
    ('timesheet_retention_years', 'int', 3, 10, null),
    ('anticheat_min_passes', 'int', 3, 50, null),
    ('anticheat_max_cv', 'num', 0.01, 0.5, null),
    ('require_admin_mfa', 'bool', null, null, null)
  ) as s(key, kind, lo, hi, options);
$$;

-- Checks a (partial) policy and returns it normalised: whole numbers as integers, the
-- excluded apps trimmed and without repeats (case-insensitive, first spelling kept).
-- Raises 22023 with the offending key in DETAIL: invalid_policy, or unknown_policy_key.
-- break_daily_max_min may be null (no limit); every other key needs a value.
create function internal.validate_policy(p_policy jsonb)
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
    if r.key = 'break_daily_max_min' and r.value = 'null'::jsonb then
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

revoke all on function internal.region_preset(public.region_preset) from public, anon, authenticated;
revoke all on function internal.policy_defaults() from public, anon, authenticated;
revoke all on function internal.works_council_countries() from public, anon, authenticated;
revoke all on function internal.policy_spec() from public, anon, authenticated;
revoke all on function internal.validate_policy(jsonb) from public, anon, authenticated;

-- New orgs start from their region's preset (replaces the admin MFA migration's version;
-- the notice template trigger then renders from it) ----------------------------------------

create or replace function public.create_org(
  org_name text,
  region_preset public.region_preset default 'us',
  full_name text default null,
  timezone text default 'UTC'
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_email text;
  v_org uuid;
begin
  if v_uid is null then
    raise exception 'not_signed_in' using errcode = '42501';
  end if;
  if exists (select 1 from public.users where id = v_uid) then
    raise exception 'already_in_an_org' using errcode = '42501';
  end if;
  if length(trim(coalesce(org_name, ''))) not between 1 and 120 then
    raise exception 'invalid_org_name' using errcode = '22023';
  end if;
  if not exists (select 1 from pg_timezone_names where name = create_org.timezone) then
    raise exception 'invalid_timezone' using errcode = '22023';
  end if;

  select u.email into v_email from auth.users u where u.id = v_uid;
  insert into public.orgs (name, data_region, region_preset, policy)
  values (trim(org_name), 'us', create_org.region_preset,
          internal.region_preset(create_org.region_preset))
  returning id into v_org;
  insert into public.users (id, org_id, full_name, email, role, timezone)
  values (v_uid, v_org, coalesce(nullif(trim(full_name), ''), split_part(v_email, '@', 1)),
          v_email, 'owner', create_org.timezone);
  insert into public.presence (user_id, org_id) values (v_uid, v_org);
  return v_org;
end;
$$;

-- Settings page ----------------------------------------------------------------------------

-- ADM-01: what the page loads. `policy` is the stored policy over the defaults (what is
-- in force), limited to the keys the page edits. `webcam_confirmed` is whether the stored
-- policy already has the webcam on (an EU org confirmed the DPIA when it switched it on).
create function public.policy_settings()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_me public.users := internal.current_app_user();
  v_org public.orgs;
begin
  perform internal.require_org_admin(v_me.org_id);
  select * into v_org from public.orgs where id = v_me.org_id;
  return jsonb_build_object(
    'region_preset', v_org.region_preset,
    'policy_version', v_org.policy_version,
    'policy', (
      select jsonb_object_agg(e.key, e.value)
      from jsonb_each(internal.policy_defaults() || v_org.policy) e
      where e.key in (select sp.key from internal.policy_spec() sp)
    ),
    'webcam_confirmed', coalesce(v_org.policy -> 'webcam' = 'true'::jsonb, false),
    'members', (select count(*) from public.users u where u.org_id = v_org.id and u.active),
    'works_council_members', (
      select count(*) from public.users u
      where u.org_id = v_org.id and u.active
        and u.work_country = any (internal.works_council_countries())
    ),
    'presets', jsonb_build_object(
      'us', internal.region_preset('us'),
      'eu', internal.region_preset('eu'),
      'india', internal.region_preset('india')
    )
  );
end;
$$;

-- ADM-01, CAP-05, AUD-01: saves (part of) the org's policy. Keys left out stay as they
-- are. Returns { policy_version, changed: [keys], notice_version }: notice_version is the
-- new monitoring notice when a collection key changed (AGT-05), else null.
create function public.update_policy(
  p_policy jsonb,
  p_dpia_confirmed boolean default false,
  p_works_council_confirmed boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me public.users := internal.current_app_user();
  v_org public.orgs;
  v_input jsonb;
  v_stored jsonb;
  v_old jsonb;
  v_next jsonb;
  v_changed jsonb;
  v_need_dpia boolean;
  v_need_council boolean;
  v_notice_before int;
  v_notice_after int;
  v_version int;
begin
  perform internal.require_org_admin(v_me.org_id);
  -- Serialises with other policy changes and notice publishers on this org.
  select * into v_org from public.orgs where id = v_me.org_id for update;
  -- Like the org-wide views: an org that requires MFA changes its policy with a
  -- verified session only.
  if coalesce((v_org.policy ->> 'require_admin_mfa')::boolean, false)
     and coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' then
    raise exception 'mfa_required' using errcode = '42501';
  end if;

  v_input := internal.validate_policy(p_policy);
  v_stored := v_org.policy || v_input;
  v_old := internal.policy_defaults() || v_org.policy;
  v_next := internal.policy_defaults() || v_stored;

  if (v_next ->> 'checkin_min_interval_min')::int > (v_next ->> 'checkin_max_interval_min')::int then
    raise exception 'invalid_policy' using errcode = '22023', detail = 'checkin_max_interval_min';
  end if;
  -- PRD 5.1: images are kept 30 days at most in the EU.
  if v_org.region_preset = 'eu' and (v_next ->> 'image_retention_days')::int > 30 then
    raise exception 'eu_image_retention_max' using errcode = '22023', detail = 'image_retention_days';
  end if;

  -- CAP-05: switching the webcam on in an EU org needs the DPIA (and, where a works
  -- council is usually involved, its consultation) confirmed. An org that already has
  -- it on in its stored policy has been through this.
  v_need_dpia := v_org.region_preset = 'eu'
    and (v_next ->> 'webcam')::boolean
    and v_org.policy -> 'webcam' is distinct from 'true'::jsonb;
  v_need_council := v_need_dpia and exists (
    select 1 from public.users u
    where u.org_id = v_org.id and u.active
      and u.work_country = any (internal.works_council_countries())
  );
  if v_need_dpia and not coalesce(p_dpia_confirmed, false) then
    raise exception 'dpia_required' using errcode = '22023', detail = 'webcam';
  end if;
  if v_need_council and not coalesce(p_works_council_confirmed, false) then
    raise exception 'works_council_required' using errcode = '22023', detail = 'webcam';
  end if;

  select coalesce(jsonb_object_agg(k, jsonb_build_object('from', v_old -> k, 'to', v_next -> k)),
                  '{}'::jsonb)
  into v_changed
  from jsonb_object_keys(v_input) k
  where (v_old -> k) is distinct from (v_next -> k);

  if v_stored is distinct from v_org.policy then
    select max(n.version) into v_notice_before from public.notices n where n.org_id = v_org.id;
    -- policy_version moves with every real change; orgs_republish_notice may move it
    -- again when the notice is republished (it never goes down).
    update public.orgs
    set policy = v_stored,
        policy_version = policy_version + case when v_changed = '{}'::jsonb then 0 else 1 end
    where id = v_org.id;
    if v_need_dpia then
      perform internal.audit(v_org.id, v_me.id, 'policy.dpia_confirmed', null,
        jsonb_build_object('feature', 'webcam', 'region', v_org.region_preset,
                           'works_council_confirmed', v_need_council));
    end if;
    if v_changed <> '{}'::jsonb then
      perform internal.audit(v_org.id, v_me.id, 'policy.changed', null,
        jsonb_build_object('changed', v_changed));
    end if;
  end if;

  select o.policy_version into v_version from public.orgs o where o.id = v_org.id;
  select max(n.version) into v_notice_after from public.notices n where n.org_id = v_org.id;
  return jsonb_build_object(
    'policy_version', v_version,
    'changed', coalesce((select jsonb_agg(k order by k) from jsonb_object_keys(v_changed) k),
                        '[]'::jsonb),
    'notice_version', case when v_notice_after > coalesce(v_notice_before, 0)
                           then v_notice_after end
  );
end;
$$;

-- Approval (TS-16) -----------------------------------------------------------------------------

-- A person whose timesheets need no manager approval: submitting approves the week at
-- once. Audit-logged as member.approval_changed.
create function public.set_approval_required(p_user_id uuid, p_required boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_target public.users;
  v_me public.users;
begin
  select * into v_target from public.users where id = p_user_id;
  if not found then
    raise exception 'user_not_found' using errcode = '42501';
  end if;
  v_me := internal.require_org_admin(v_target.org_id);
  if v_target.role = 'owner' and v_me.role <> 'owner' then
    raise exception 'owner_only' using errcode = '42501';
  end if;
  if p_required is null then
    raise exception 'invalid_approval' using errcode = '22023';
  end if;
  if p_required is distinct from v_target.approval_required then
    update public.users set approval_required = p_required where id = v_target.id;
    perform internal.audit(v_target.org_id, v_me.id, 'member.approval_changed', v_target.id,
      jsonb_build_object('from', v_target.approval_required, 'to', p_required));
  end if;
end;
$$;

revoke all on function public.policy_settings() from public, anon;
revoke all on function public.update_policy(jsonb, boolean, boolean) from public, anon;
revoke all on function public.set_approval_required(uuid, boolean) from public, anon;
grant execute on function public.policy_settings() to authenticated;
grant execute on function public.update_policy(jsonb, boolean, boolean) to authenticated;
grant execute on function public.set_approval_required(uuid, boolean) to authenticated;
