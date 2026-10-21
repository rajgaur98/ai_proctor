-- #64: on-device face presence detection (CAP-07; PRD 5.1, 5.2).
--
-- The agent asks the OS face *detector* (macOS Vision face rectangles, Windows
-- FaceAnalysis) whether the webcam frame of a passed check-in shows a face, and sends
-- only that boolean as `face_present` on the check-in. Detection only, never
-- recognition: no face image beyond the webcam frame the org already collects, no
-- position, landmark, embedding or template is kept or sent, on the device or here. A
-- miss captures nothing, so it never has a value (checkin_events_face_only_on_pass).
-- A false is a "needs review" hint on the day page, never a penalty: nothing here
-- touches status, segments, hours or alerts.
--
-- Gating (the server is the source of truth; the agent runs it only when told to):
--   policy key face_presence   bool, default false in every preset (PRD 5.1 has it on
--                              for US/India; the conservative default waits for Raj).
--   EU organisations           region_preset 'eu' or data_region 'eu': unavailable
--                              (EU AI Act, PRD 5.2). update_policy refuses it
--                              (face_presence_unavailable) and the effective value is
--                              off whatever is stored.
--   biometric-law locations    internal.biometric_law_locations: work locations where
--                              it is always off for the person (Illinois BIPA, Texas
--                              CUBI, Washington RCW 19.375 / My Health My Data,
--                              Colorado; the EU and EEA). NEEDS LEGAL REVIEW before the
--                              first paid customer, like the notice templates.
--   the monitoring notice      face_presence is a collection key (#48): turning it on
--                              publishes a notice that describes it, and it only runs
--                              for someone once they acknowledged that notice; it
--                              needs the webcam on for the person too.
-- The agent gets the effective value through agent_config's policy, as the other
-- collection keys (agent_config itself is unchanged: it merges effective_collection
-- over the org policy). A change of someone's work location bumps their config version
-- so their devices refetch.
--
-- Replaces (copied from their latest definitions, changes marked):
--   internal.region_preset, internal.policy_spec     20261020196000_reminder_shift_day
--   public.update_policy, public.policy_settings     20261020180000_policy_settings
--   internal.collection_snapshot, collection_off,
--   effective_collection, default_notice_body,
--   orgs_republish_notice                            20261020153000_monitoring_notice
--   internal.apply_event                             20261020195000_tamper_policy

-- Where face presence is always off -------------------------------------------------------

-- Work locations with a biometric privacy law: the person's work_country, and
-- work_state for a US state (null: the whole country). `place` is how the dashboard and
-- the notice name it. NEEDS LEGAL REVIEW: the list is a conservative starting point,
-- not legal advice. Extend it here (a migration), nowhere else.
create table internal.biometric_law_locations (
  country text not null check (country ~ '^[A-Z]{2}$'),
  state text check (state is null or state ~ '^[A-Z]{2}$'),
  place text not null,
  law text not null
);
create unique index biometric_law_locations_key
  on internal.biometric_law_locations (country, coalesce(state, ''));
revoke all on internal.biometric_law_locations from public, anon, authenticated;

insert into internal.biometric_law_locations (country, state, place, law) values
  ('US', 'IL', 'Illinois', 'Biometric Information Privacy Act (740 ILCS 14)'),
  ('US', 'TX', 'Texas', 'Capture or Use of Biometric Identifier Act (Bus. & Com. Code 503.001)'),
  ('US', 'WA', 'Washington', 'RCW 19.375 (biometric identifiers); My Health My Data Act (RCW 19.373)'),
  ('US', 'CO', 'Colorado', 'Colorado Privacy Act biometric amendment (HB 24-1130)');
-- The EU and EEA: GDPR Art. 9 and the EU AI Act (PRD 5.2), for someone working there
-- for an organisation outside the EU.
insert into internal.biometric_law_locations (country, state, place, law)
select c, null, 'the European Economic Area', 'GDPR Art. 9; EU AI Act'
from unnest(array[
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE',
  'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE',
  'IS', 'LI', 'NO'
]) c;

-- Whether a work location is on the list.
create function internal.biometric_law_location(p_country text, p_state text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from internal.biometric_law_locations b
    where b.country = p_country and (b.state is null or b.state is not distinct from p_state)
  );
$$;

-- The places on the list, as the dashboard and the notice name them (US states first).
create function internal.biometric_law_places()
returns text[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(p.place order by p.abroad, p.place), '{}')
  from (
    select distinct b.place, b.country <> 'US' as abroad
    from internal.biometric_law_locations b
  ) p;
$$;

-- Whether an org may use face presence at all: not in the EU (region preset or data
-- region).
create function internal.face_presence_available(p_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select o.region_preset <> 'eu' and o.data_region <> 'eu'
    from public.orgs o where o.id = p_org_id
  ), false);
$$;

-- Whether face presence may run for this person: their org may use it and their work
-- location isn't on the biometric-law list. The policy and the notice come on top
-- (effective_collection).
create function internal.face_presence_allowed(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select internal.face_presence_available(u.org_id)
      and not internal.biometric_law_location(u.work_country, u.work_state)
    from public.users u where u.id = p_user_id
  ), false);
$$;

revoke all on function internal.biometric_law_location(text, text) from public, anon, authenticated;
revoke all on function internal.biometric_law_places() from public, anon, authenticated;
revoke all on function internal.face_presence_available(uuid) from public, anon, authenticated;
revoke all on function internal.face_presence_allowed(uuid) from public, anon, authenticated;

-- A new work location can switch it on or off for the person: their devices refetch.
create trigger users_work_location_config_version
before update of work_country, work_state on public.users
for each row
when ((old.work_country, old.work_state) is distinct from (new.work_country, new.work_state))
execute function internal.users_bump_config_version();

-- Only a pass has a webcam frame to look at. face_present itself is from the initial
-- schema (nullable boolean).
alter table public.checkin_events
  add constraint checkin_events_face_only_on_pass
  check (outcome = 'pass' or face_present is null);

comment on column public.checkin_events.face_present is
  'CAP-07: whether the webcam frame of this pass showed a face (on-device detection only, never recognition). Null: not checked. A false is a needs-review hint, never a penalty.';

-- Policy: the new key (copies of #177's with face_presence) ---------------------------------

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
    -- CAP-07: off by default everywhere; never available in the EU.
    'face_presence', false,
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
    ('face_presence', 'bool', null, null, null),
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

-- update_policy (copy of #52's): an EU organisation can't turn face presence on ---------------

create or replace function public.update_policy(
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
  -- CAP-07, PRD 5.2: no face detection in an EU organisation.
  if (v_next ->> 'face_presence')::boolean and not internal.face_presence_available(v_org.id) then
    raise exception 'face_presence_unavailable' using errcode = '22023', detail = 'face_presence';
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

-- policy_settings (copy of #52's): whether face presence is available and where it is off ---

create or replace function public.policy_settings()
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
    -- CAP-07: the toggle is disabled for an EU org; it is always off for active people
    -- working in a biometric-law location.
    'face_presence_available', internal.face_presence_available(v_org.id),
    'biometric_law_places', to_jsonb(internal.biometric_law_places()),
    'biometric_law_members', (
      select count(*) from public.users u
      where u.org_id = v_org.id and u.active
        and internal.biometric_law_location(u.work_country, u.work_state)
    ),
    'presets', jsonb_build_object(
      'us', internal.region_preset('us'),
      'eu', internal.region_preset('eu'),
      'india', internal.region_preset('india')
    )
  );
end;
$$;

-- Collection (copies of #48's with face_presence) ------------------------------------------

-- Notices published before this migration have no face_presence in their snapshot:
-- it didn't exist, so it was off. internal.collection_with_defaults fills it in wherever
-- a stored snapshot is compared or read.
create function internal.collection_with_defaults(p_collection jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object('face_presence', false) || p_collection;
$$;

revoke all on function internal.collection_with_defaults(jsonb) from public, anon, authenticated;

create or replace function internal.collection_snapshot(p_policy jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object(
    'screenshots',
      case when p_policy ->> 'screenshots' in ('full', 'blurred', 'off')
           then p_policy ->> 'screenshots' else 'full' end,
    'webcam',
      case when jsonb_typeof(p_policy -> 'webcam') = 'boolean'
           then (p_policy -> 'webcam')::boolean else true end,
    'window_titles',
      case when jsonb_typeof(p_policy -> 'window_titles') = 'boolean'
           then (p_policy -> 'window_titles')::boolean else true end,
    'excluded_apps', coalesce((
      select jsonb_agg(distinct lower(e) order by lower(e))
      from jsonb_array_elements_text(
        case when jsonb_typeof(p_policy -> 'excluded_apps') = 'array'
             then p_policy -> 'excluded_apps' else '[]'::jsonb end) e
    ), '[]'::jsonb),
    'activity_sampling',
      case when jsonb_typeof(p_policy -> 'activity_sampling') = 'boolean'
           then (p_policy -> 'activity_sampling')::boolean else true end,
    -- CAP-07: off unless stored on.
    'face_presence',
      case when jsonb_typeof(p_policy -> 'face_presence') = 'boolean'
           then (p_policy -> 'face_presence')::boolean else false end
  );
$$;

create or replace function internal.collection_off()
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object(
    'screenshots', 'off', 'webcam', false, 'window_titles', false,
    'excluded_apps', '[]'::jsonb, 'activity_sampling', false, 'face_presence', false
  );
$$;

create or replace function internal.effective_collection(p_user_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_acked jsonb;
  v_now jsonb;
  v_modes text[] := array['off', 'blurred', 'full'];
begin
  select n.collection into v_acked
  from public.notice_acks a
  join public.notices n on n.id = a.notice_id
  where a.user_id = p_user_id
  order by n.version desc
  limit 1;
  if v_acked is null then
    return internal.collection_off();
  end if;
  v_acked := internal.collection_with_defaults(v_acked);
  select internal.collection_snapshot(o.policy) into v_now
  from public.users u join public.orgs o on o.id = u.org_id
  where u.id = p_user_id;
  if v_now is null then
    return internal.collection_off();
  end if;
  return jsonb_build_object(
    'screenshots', v_modes[least(
      array_position(v_modes, v_acked ->> 'screenshots'),
      array_position(v_modes, v_now ->> 'screenshots'))],
    'webcam', (v_acked ->> 'webcam')::boolean and (v_now ->> 'webcam')::boolean,
    'window_titles', (v_acked ->> 'window_titles')::boolean and (v_now ->> 'window_titles')::boolean,
    'excluded_apps', coalesce((
      select jsonb_agg(distinct e order by e)
      from jsonb_array_elements_text((v_acked -> 'excluded_apps') || (v_now -> 'excluded_apps')) e
    ), '[]'::jsonb),
    'activity_sampling',
      (v_acked ->> 'activity_sampling')::boolean and (v_now ->> 'activity_sampling')::boolean,
    -- CAP-07: acknowledged and on now, with the webcam it looks at, and allowed for this
    -- person (not an EU org, not a biometric-law work location).
    'face_presence',
      (v_acked ->> 'face_presence')::boolean and (v_now ->> 'face_presence')::boolean
      and (v_acked ->> 'webcam')::boolean and (v_now ->> 'webcam')::boolean
      and internal.face_presence_allowed(p_user_id)
  );
end;
$$;

-- The notice text says what face presence does when it is on (copy of #48's template;
-- the text for an org without it is unchanged, so unedited notices still re-render) ---------

create or replace function internal.default_notice_body(
  p_org_id uuid,
  p_region public.region_preset,
  p_policy jsonb
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  c jsonb := internal.collection_snapshot(p_policy);
  v_org text := coalesce((select o.name from public.orgs o where o.id = p_org_id), 'Your organisation');
  v_where text := case coalesce((select o.data_region::text from public.orgs o where o.id = p_org_id), 'us')
    when 'eu' then 'the European Union' else 'the United States' end;
  v_days int := case when jsonb_typeof(p_policy -> 'image_retention_days') = 'number'
                     then floor((p_policy ->> 'image_retention_days')::numeric)::int else 30 end;
  v_images text[] := '{}';
  v_apps text := (select string_agg(e, ', ' order by e) from jsonb_array_elements_text(c -> 'excluded_apps') e);
  v_collected text;
  v_retention text;
  v_body jsonb;
begin
  -- GDPR: images are kept 30 days at most (PRD 5.1).
  v_days := case when p_region = 'eu' then least(greatest(v_days, 1), 30) else greatest(v_days, 1) end;

  if c ->> 'screenshots' = 'full' then
    v_images := array_append(v_images, 'a screenshot of each screen');
  elsif c ->> 'screenshots' = 'blurred' then
    v_images := array_append(v_images, 'a blurred screenshot of each screen (blurred on your computer before it is sent)');
  end if;
  if (c ->> 'webcam')::boolean then
    v_images := array_append(v_images, 'one still webcam frame');
  end if;

  v_collected := case
    when cardinality(v_images) = 0 then 'No screenshots or webcam images are taken.'
    else 'When you pass a check-in: ' || array_to_string(v_images, ' and ') || '.'
  end;
  -- CAP-07: only with the webcam frame it looks at.
  if (c ->> 'webcam')::boolean and (c ->> 'face_presence')::boolean then
    v_collected := v_collected
      || ' Your computer checks that webcam frame for whether a face is in view. This is detection only: it never identifies you, and no face data is kept or sent. Only the yes or no answer is recorded, as a hint for your manager to review, never a penalty. It is off for people who work in '
      || array_to_string(internal.biometric_law_places(), ', ') || '.';
  end if;
  v_collected := v_collected || ' ' || case
    when (c ->> 'activity_sampling')::boolean then
      'While you are clocked in: the name of the app you are using'
      || case when (c ->> 'window_titles')::boolean then ', its window title' else '' end
      || ', the website (domain only) when you are in a browser, and the time spent in each.'
    else 'No app activity is recorded.'
  end;
  if v_apps is not null then
    v_collected := v_collected || ' Apps your admin has excluded (' || v_apps
      || ') are never shown in screenshots, and their window titles are not recorded.';
  end if;
  v_collected := v_collected
    || ' Your clock-in and clock-out times, breaks, pauses and the result of each check-in are also recorded.';

  v_retention := case
    when cardinality(v_images) = 0 then 'No images are collected.'
    else 'Screenshots and webcam frames are deleted after ' || v_days || ' days.'
  end
    || ' Time records, check-in results and activity totals stay with your timesheets.'
    || ' A log of who viewed or changed your data is kept for at least 3 years.';

  v_body := jsonb_build_object(
    'collected', v_collected,
    'when', 'Only while you are clocked in. Nothing is collected on a break, during a pause or when you are off shift, and nothing is captured when you miss a check-in.',
    'who', 'Your direct manager and your workspace admins. You can see every time someone views one of your captures in My data.',
    'retention', v_retention
  );

  if p_region = 'eu' then
    v_body := v_body || jsonb_build_object(
      'intro', v_org || ' (the controller) uses AI Proctor to record working time and to confirm you are at your computer while you are clocked in. The legal basis is the employer''s legitimate interest (GDPR Art. 6(1)(f)); ask your admin for the legitimate interest assessment. Your data is stored in ' || v_where || '.',
      'who', (v_body ->> 'who') || ' AI Proctor processes the data on behalf of ' || v_org || '.',
      'rights', 'You can ask for access to your data, for it to be corrected or deleted, for processing to be restricted, and for a copy in a portable format. You can object to processing that relies on legitimate interest. Export your data from My data or make a request through your workspace admin. You can also complain to your data protection supervisory authority.'
    );
  elsif p_region = 'india' then
    v_body := v_body || jsonb_build_object(
      'intro', v_org || ' (the data fiduciary) uses AI Proctor to record working time and to confirm you are at your computer while you are clocked in, for the purposes of your employment, a permitted use under the Digital Personal Data Protection Act, 2023. Your data is stored in ' || v_where || '.',
      'rights', 'You can ask for a summary of the data held about you and who it has been shared with, ask for it to be corrected or erased, and nominate someone to exercise these rights for you. Export your data from My data.',
      'grievance', 'To raise a concern or make a request, contact your workspace admin. If you are not satisfied with the reply, you can complain to the Data Protection Board of India.'
    );
  else
    v_body := v_body || jsonb_build_object(
      'intro', v_org || ' uses AI Proctor to record working time and to confirm you are at your computer while you are clocked in. Some US states, including New York, Connecticut and Delaware, require written notice of electronic monitoring. By acknowledging this notice you confirm you have read it.',
      'rights', 'You can see everything collected about you and export it at any time from My data. If you live in California you can also ask for your data to be corrected or deleted. Make a request through your workspace admin.'
    );
  end if;
  return v_body;
end;
$$;

-- Republishing compares snapshots with the keys filled in (copy of #48's), so a policy
-- change that leaves collection alone doesn't publish a notice just because older
-- snapshots predate face_presence -----------------------------------------------------------

create or replace function internal.orgs_republish_notice()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_latest public.notices;
  v_snapshot jsonb := internal.collection_snapshot(new.policy);
  v_body jsonb;
  v_notice public.notices;
  v_actor uuid;
  v_has_latest boolean;
begin
  select * into v_latest from public.notices n
  where n.org_id = new.id order by n.version desc limit 1;
  v_has_latest := found;
  -- A snapshot from before a key existed has that key at its default (#64).
  v_latest.collection := internal.collection_with_defaults(v_latest.collection);
  if v_has_latest and v_latest.collection = v_snapshot then
    return new;
  end if;
  v_body := coalesce(v_latest.body, internal.default_notice_body(new.id, new.region_preset, new.policy));
  if v_has_latest and v_body = internal.default_notice_body(old.id, v_latest.region, old.policy) then
    v_body := internal.default_notice_body(new.id, new.region_preset, new.policy);
  end if;
  v_notice := internal.insert_notice(new.id, new.region_preset, v_body, v_snapshot, null);
  new.policy_version := greatest(new.policy_version, old.policy_version + 1);
  v_actor := (select u.id from public.users u where u.id = auth.uid() and u.org_id = new.id);
  perform internal.audit(new.id, v_actor, 'notice.published', null, jsonb_build_object(
    'version', v_notice.version, 'source', 'policy_change',
    'changed', coalesce((
      select jsonb_agg(k order by k)
      from jsonb_object_keys(v_snapshot) k
      where v_latest.collection -> k is distinct from v_snapshot -> k
    ), '[]'::jsonb)));
  return new;
end;
$$;

-- Event projection: a pass stores face_present when face presence is on for the person
-- (copy of #161's; only the checkin insert changes) --------------------------------------------

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
  v_from timestamptz;
begin
  insert into public.presence (user_id, org_id) values (p_device.user_id, p_device.org_id)
  on conflict (user_id) do nothing;

  case p_type
  when 'clock_in' then
    if s.state <> 'off_shift' then return 'already_clocked_in'; end if;
    -- AGT-04: nothing is collected before the person has acknowledged a notice.
    if not exists (select 1 from public.notice_acks a where a.user_id = p_device.user_id) then
      return 'notice_not_acknowledged';
    end if;
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
    perform internal.close_break(s.break_id, p_at);
    perform internal.close_pause(s.pause_id, p_at);
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
    perform internal.close_break(s.break_id, p_at);

  when 'pause_start' then
    if s.state = 'off_shift' then return 'not_clocked_in'; end if;
    if s.state = 'on_break' then return 'on_break'; end if;
    if s.state = 'paused' then return 'already_paused'; end if;
    insert into public.pauses (org_id, user_id, clock_session_id, start_at, planned_min, private_reason)
    values (p_device.org_id, p_device.user_id, s.clock_session_id, p_at,
            (p_payload ->> 'planned_min')::int, nullif(btrim(p_payload ->> 'reason'), ''));

  when 'pause_end' then
    if s.state <> 'paused' then return 'not_paused'; end if;
    perform internal.close_pause(s.pause_id, p_at);

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
        outcome, deferral_reason, response_ms, wrong_clicks, idle_s_at_show, device_state,
        object_keys, flags, capture_errors, face_present
      )
      values (
        p_event_id, p_device.org_id, p_device.user_id, p_device.id,
        internal.allowed_project(p_device.user_id, p_payload ->> 'project_id'),
        (p_payload ->> 'scheduled_at')::timestamptz,
        (p_payload ->> 'shown_at')::timestamptz,
        (p_payload ->> 'responded_at')::timestamptz,
        (p_payload ->> 'outcome')::public.checkin_outcome,
        p_payload ->> 'deferral_reason',
        (p_payload ->> 'response_ms')::int,
        (p_payload ->> 'wrong_clicks')::int,
        (p_payload ->> 'idle_s_at_show')::int,
        p_payload ->> 'device_state',
        array(select jsonb_array_elements_text(p_payload -> 'object_keys')),
        array(select jsonb_array_elements_text(p_payload -> 'flags')),
        p_payload -> 'capture_errors',
        -- CAP-07: the boolean only, on a pass only, and only while face presence is on
        -- for this person (an agent with an old config can't store it after it's off).
        case when p_payload ->> 'outcome' = 'pass'
              and (internal.effective_collection(p_device.user_id) ->> 'face_presence')::boolean
             then (p_payload ->> 'face_present')::boolean end
      );
    exception when check_violation then
      return 'invalid_checkin';
    end;
    -- A deferral is neither a pass nor a miss: "most recent check-in" (STS rule 7)
    -- stays what it was.
    if p_payload ->> 'outcome' <> 'deferred' then
      update public.presence
      set last_checkin_at = p_at, last_checkin_outcome = (p_payload ->> 'outcome')::public.checkin_outcome
      where user_id = p_device.user_id;
    end if;

  when 'app_session' then
    -- Judged by its own time, not the current state: the agent sends the last
    -- minute's bucket after the break or clock-out that ended it.
    v_reason := internal.record_activity(p_device, p_event_id, p_payload);
    if v_reason is not null then return v_reason; end if;

  when 'permission_change' then
    -- The raw states; whether they are Tamper depends on what this person is
    -- collected for, worked out at every refresh (STS rule 2, AGT-07).
    update public.presence p
    set screen_permission = p_payload ->> 'screen', camera_permission = p_payload ->> 'camera'
    where p.user_id = p_device.user_id;

  when 'agent_restart' then
    -- ANT-01: the agent came back after a run that ended during a shift. If that
    -- run was killed (it never exited normally and the device did not restart),
    -- the time since it was last seen alive is Tamper, from the clock-in at the
    -- earliest. A normal exit or a reboot is on record but is not Tamper. Not
    -- clocked in: nothing to explain.
    if s.state <> 'off_shift' and p_payload ->> 'reason' = 'killed' then
      v_from := greatest(
        (p_payload ->> 'last_alive_at')::timestamptz,
        (select cs.start_at from public.clock_sessions cs where cs.id = s.clock_session_id)
      );
      if v_from < p_at then
        perform internal.record_tamper_gap(p_device.user_id, p_device.org_id, v_from, p_at);
      end if;
    end if;

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
