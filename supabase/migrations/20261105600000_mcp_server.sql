-- #307 (API-07, API-08, AUD-01, ADM-06): the MCP server for AI assistants, read-only v1.
--
-- The HTTP side is the mcp Edge Function (supabase/functions/mcp): a remote MCP server
-- over Streamable HTTP. A person connects an assistant (Claude, ChatGPT, ...) with OAuth
-- 2.1 through Supabase Auth's OAuth server ([auth.oauth_server] in config.toml): the
-- assistant registers itself (dynamic client registration), the person signs in and
-- approves it on the dashboard's consent page (/oauth/consent), and the assistant gets an
-- access token for that person. The function checks the token with Auth and calls
-- public.mcp_call (service role only), which runs the tool *as that person* (claims set
-- for this transaction only), so every rule is the dashboard's: can_view_user() and the
-- org in their token, with the org's admin-MFA rule applied to the token's own aal.
--
-- Assistant tokens are for the MCP server only. Supabase Auth's OAuth tokens are ordinary
-- session tokens that also carry `client_id`; the access token hook gives them the role
-- `ai_assistant`, which PostgREST, Storage and Realtime can't switch to (it is not granted
-- to `authenticator`), so they are refused there. The Edge Functions that take a person's
-- token refuse them too (supabase/functions/_shared/assistantToken.ts). The hook also
-- refuses to issue or refresh one while the org's AI assistant access is off.
--
-- The org switch: orgs.ai_assistant_access, off by default, changed by owners and admins
-- with set_ai_assistant_access (audit-logged). When it is on, the monitoring notice
-- template says so (ADM-06) and turning it on or off publishes a new notice version
-- when the org still uses the template text.
--
-- Tools (API-08), each a function over auth.uid() and can_view_user(): list_people,
-- who_is_on_shift (DSH-01), get_person_day, list_timesheets, hours_report (DSH-07,
-- DSH-10) and list_alerts. They never return capture images or links (object_keys),
-- window titles, browser domains, when a check-in was scheduled (so never the next one,
-- EMP-01), anti-cheat flags or tamper reasons, and none of the free text people write
-- (miss remarks, return comments, manual entry reasons and notes): the structured miss
-- reason is returned instead. Every tool call is audit-logged as `mcp.tool_call` with
-- the person, the tool, its arguments and the rows returned (AUD-01); calls are limited
-- per person per minute.
--
-- Redefines internal.custom_access_token_hook (latest: 20261019142613_row_level_security)
-- and internal.default_notice_body (latest: 20261022140000_face_presence).

-- The org switch ---------------------------------------------------------------------------

alter table public.orgs add column ai_assistant_access boolean not null default false;

-- The role an assistant's token carries. Deliberately granted nothing and not granted to
-- `authenticator`: PostgREST, Storage and Realtime refuse to switch to it, so the token
-- reaches no table, view or RPC directly. A role is per cluster, so it survives a reset.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'ai_assistant') then
    create role ai_assistant nologin noinherit;
  end if;
end;
$$;

-- Access token hook (copy of 20261019142613's; adds the assistant block) ---------------------

create or replace function internal.custom_access_token_hook(event jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_claims jsonb := event -> 'claims';
  v_user_id uuid := (event ->> 'user_id')::uuid;
  v_session_id uuid := nullif(event -> 'claims' ->> 'session_id', '')::uuid;
  v_user public.users;
  v_device public.devices;
begin
  select * into v_user from public.users u where u.id = v_user_id;
  -- No users row yet (an invitee mid-onboarding) is allowed; inactive is not.
  if found then
    if not v_user.active then
      return jsonb_build_object('error', jsonb_build_object('http_code', 403, 'message', 'user_inactive'));
    end if;
    v_claims := v_claims
      || jsonb_build_object('org_id', v_user.org_id::text, 'app_role', v_user.role::text);
  end if;

  -- #307: a token Supabase Auth's OAuth server issues to a third-party client (an AI
  -- assistant) carries `client_id`. Only members of an org with AI assistant access on
  -- get one, and it carries the role `ai_assistant` (see the header).
  if coalesce(v_claims ->> 'client_id', '') <> '' then
    if v_user.id is null then
      return jsonb_build_object('error', jsonb_build_object('http_code', 403, 'message', 'not_a_member'));
    end if;
    if not coalesce((select o.ai_assistant_access from public.orgs o where o.id = v_user.org_id), false) then
      return jsonb_build_object('error', jsonb_build_object('http_code', 403,
        'message', 'ai_assistant_access_off'));
    end if;
    v_claims := jsonb_set(v_claims, '{role}', '"ai_assistant"');
  end if;

  select d.* into v_device
  from public.device_sessions ds
  join public.devices d on d.id = ds.device_id
  where ds.session_id = v_session_id;

  if found then
    if v_device.revoked_at is not null then
      return jsonb_build_object('error', jsonb_build_object('http_code', 403, 'message', 'device_revoked'));
    end if;
    v_claims := jsonb_set(v_claims, '{device_id}', to_jsonb(v_device.id::text));
  end if;

  return jsonb_build_object('claims', v_claims);
end;
$$;

-- Notice template (copy of 20261022140000's; adds the AI assistant sentence) -----------------
-- The sentence is only there while the org has AI assistant access on, so the text for an
-- org without it is unchanged and unedited notices still re-render.

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

  -- API-07 (#307): AI assistant access, while it is on.
  if coalesce((select o.ai_assistant_access from public.orgs o where o.id = p_org_id), false) then
    v_body := jsonb_set(v_body, '{who}', to_jsonb((v_body ->> 'who')
      || ' ' || v_org || ' has turned on AI assistant access: someone who can see your data here can also ask an AI assistant they connect to their own account, such as Claude or ChatGPT, about it (your hours, timesheets, check-in results, alerts and the time spent in each app). The assistant sees only what that person can see. It never gets your screenshots, webcam frames, window titles or websites, and every question it asks is recorded in the audit log.'));
  end if;
  return v_body;
end;
$$;

-- Turns AI assistant access on or off (owners and admins, with MFA when the org requires
-- it). Audit-logged. When the org's latest notice is still the template text, a new
-- version is published with the template's new text (everyone acknowledges it again, as
-- after a policy change); when an admin wrote their own text it is left alone and
-- `notice_edited` says so, so the page can ask them to update it.
-- Returns { enabled, notice_version (the new version or null), notice_edited }.
create function public.set_ai_assistant_access(p_enabled boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me public.users := internal.require_audit_reader();
  v_org public.orgs;
  v_latest public.notices;
  v_template boolean;
  v_notice public.notices;
begin
  if p_enabled is null then
    raise exception 'invalid_value' using errcode = '22023';
  end if;
  -- Serialises this with publishers and policy changes on the org.
  select * into v_org from public.orgs o where o.id = v_me.org_id for update;
  if v_org.ai_assistant_access = p_enabled then
    return jsonb_build_object('enabled', p_enabled, 'notice_version', null, 'notice_edited', false);
  end if;

  select * into v_latest from public.notices n where n.org_id = v_org.id order by n.version desc limit 1;
  v_template := found and v_latest.body
    = internal.default_notice_body(v_org.id, v_latest.region, v_org.policy);

  update public.orgs set ai_assistant_access = p_enabled where id = v_org.id;
  perform internal.audit(v_org.id, v_me.id, 'ai_assistant_access.changed', null,
    jsonb_build_object('enabled', p_enabled));

  if v_template then
    v_notice := internal.insert_notice(v_org.id, v_org.region_preset,
      internal.default_notice_body(v_org.id, v_org.region_preset, v_org.policy),
      internal.collection_snapshot(v_org.policy), null);
    update public.orgs set policy_version = policy_version + 1 where id = v_org.id;
    perform internal.audit(v_org.id, v_me.id, 'notice.published', null,
      jsonb_build_object('version', v_notice.version, 'source', 'ai_assistant_access'));
  end if;

  return jsonb_build_object('enabled', p_enabled, 'notice_version', v_notice.version,
    'notice_edited', v_latest.id is not null and not v_template);
end;
$$;
revoke all on function public.set_ai_assistant_access(boolean) from public, anon;
grant execute on function public.set_ai_assistant_access(boolean) to authenticated;

-- Rate limit -----------------------------------------------------------------------------------

-- Tool calls per person per minute (one fixed window; the error says when it resets).
create function internal.mcp_rate_limit()
returns int
language sql
immutable
set search_path = ''
as $$ select 60 $$;
revoke all on function internal.mcp_rate_limit() from public, anon, authenticated;

-- One row per person who has used a tool: the current minute and the calls in it.
create table internal.mcp_rate (
  user_id uuid primary key references public.users (id) on delete cascade,
  window_start timestamptz not null,
  calls int not null
);
alter table internal.mcp_rate enable row level security;
revoke all on internal.mcp_rate from public, anon, authenticated;

-- Helpers ------------------------------------------------------------------------------------

-- A person as tools return them: id and name.
create function internal.mcp_person(p_id uuid, p_name text)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select case when p_id is null then null else jsonb_build_object('id', p_id, 'name', p_name) end;
$$;

-- The first `p_max` rows under `p_key`, and whether there were more (rows were fetched
-- with `p_max + 1`).
create function internal.mcp_capped(p_rows jsonb, p_max int, p_key text)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object(
    p_key, coalesce((
      select jsonb_agg(r.value order by r.ordinality)
      from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) with ordinality r
      where r.ordinality <= p_max), '[]'::jsonb),
    'truncated', jsonb_array_length(coalesce(p_rows, '[]'::jsonb)) > p_max);
$$;

-- The rows a result holds, for the audit log: every top-level array's length.
create function internal.mcp_row_count(p_result jsonb)
returns int
language sql
immutable
set search_path = ''
as $$
  select coalesce(sum(jsonb_array_length(v.value)), 0)::int
  from jsonb_each(coalesce(p_result, '{}'::jsonb)) v
  where jsonb_typeof(v.value) = 'array';
$$;

-- A day range from `from` / `to` (YYYY-MM-DD). Required: both must be given. Otherwise `to`
-- defaults to `p_today` and `from` to six days before `to` (a week). At most `p_max_days`.
create function internal.mcp_range(
  p jsonb,
  p_required boolean,
  p_today date,
  p_max_days int,
  out from_day date,
  out to_day date
)
language plpgsql
set search_path = ''
as $$
begin
  select d.from_day, d.to_day into from_day, to_day from internal.api_days(p) d;
  if p_required and from_day is null then
    perform internal.api_bad_param('from', 'required');
  end if;
  if p_required and to_day is null then
    perform internal.api_bad_param('to', 'required');
  end if;
  to_day := coalesce(to_day, p_today);
  from_day := coalesce(from_day, to_day - 6);
  if to_day < from_day then
    perform internal.api_bad_param('to', 'must not be before from');
  end if;
  if to_day - from_day >= p_max_days then
    perform internal.api_bad_param('to', format('a range covers at most %s days', p_max_days));
  end if;
end;
$$;

revoke all on function internal.mcp_person(uuid, text) from public, anon, authenticated;
revoke all on function internal.mcp_capped(jsonb, int, text) from public, anon, authenticated;
revoke all on function internal.mcp_row_count(jsonb) from public, anon, authenticated;
revoke all on function internal.mcp_range(jsonb, boolean, date, int) from public, anon, authenticated;

-- Tools ----------------------------------------------------------------------------------------
-- Each takes the tool's arguments (a JSON object) and returns a JSON object, for the
-- signed-in person (auth.uid()): the org in their token and the people can_view_user()
-- lets them see. Durations are exact seconds (TS-05). Argument errors are the public API's
-- (22023 'invalid_param', "<argument>: <problem>").

-- People the caller can see, by name, team, manager or role, so an assistant can find the
-- id the other tools take.
create function internal.mcp_list_people(p jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  c_max constant int := 200;
  v_org uuid := internal.jwt_org_id();
  v_query text;
  v_team uuid;
  v_manager uuid;
  v_role text;
  v_inactive boolean;
  v_rows jsonb;
begin
  perform internal.api_allow(p, array['query', 'team_id', 'manager_id', 'role', 'include_inactive']);
  v_query := nullif(trim(internal.api_text(p, 'query')), '');
  if length(v_query) > 100 then
    perform internal.api_bad_param('query', 'at most 100 characters');
  end if;
  v_team := internal.api_uuid(p, 'team_id');
  v_manager := internal.api_uuid(p, 'manager_id');
  v_role := internal.api_enum(p, 'role', array['owner', 'admin', 'manager', 'employee']);
  v_inactive := coalesce(internal.api_bool(p, 'include_inactive'), false);

  select jsonb_agg(x.o order by x.name, x.id) into v_rows
  from (
    select jsonb_build_object(
        'id', u.id, 'name', u.full_name, 'role', u.role, 'active', u.active,
        'timezone', u.timezone,
        'team', case when t.id is not null then jsonb_build_object('id', t.id, 'name', t.name) end,
        'manager', internal.mcp_person(m.id, m.full_name)) as o,
      u.full_name as name, u.id
    from public.users u
    left join public.teams t on t.id = u.team_id
    left join public.users m on m.id = u.manager_id
    where u.org_id = v_org
      and public.can_view_user(u.id)
      and (v_inactive or u.active)
      and (v_query is null or strpos(lower(u.full_name), lower(v_query)) > 0)
      and (v_team is null or u.team_id = v_team)
      and (v_manager is null or u.manager_id = v_manager)
      and (v_role is null or u.role::text = v_role)
    order by u.full_name, u.id
    limit c_max + 1
  ) x;
  return internal.mcp_capped(v_rows, c_max, 'people');
end;
$$;

-- DSH-01: who is on shift now (clocked in: not Off shift, not On leave) and their status,
-- like the live team page. Never the tamper reason or when the next check-in is.
create function internal.mcp_who_is_on_shift(p jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  c_max constant int := 500;
  v_org uuid := internal.jwt_org_id();
  v_team uuid;
  v_status text;
  v_all boolean;
  v_rows jsonb;
begin
  perform internal.api_allow(p, array['team_id', 'status', 'include_off_shift']);
  v_team := internal.api_uuid(p, 'team_id');
  v_status := internal.api_enum(p, 'status',
    (select array_agg(s::text) from unnest(enum_range(null::public.presence_status)) s));
  v_all := coalesce(internal.api_bool(p, 'include_off_shift'), false) or v_status is not null;

  select jsonb_agg(x.o order by x.name, x.id) into v_rows
  from (
    select jsonb_build_object(
        'person', internal.mcp_person(u.id, u.full_name),
        'team', case when t.id is not null then jsonb_build_object('id', t.id, 'name', t.name) end,
        'status', pr.status, 'since', pr.since,
        'last_checkin_at', pr.last_checkin_at, 'last_checkin_outcome', pr.last_checkin_outcome,
        'project', case when pj.id is not null then jsonb_build_object('id', pj.id, 'name', pj.name) end,
        'checkins_shown_today', coalesce(today.shown, 0),
        'checkins_passed_today', coalesce(today.passed, 0),
        'scheduled_today', exists (
          select 1 from public.shifts s
          where s.user_id = u.id
            and extract(isodow from now() at time zone s.timezone)::int = any (s.days)),
        'timezone', u.timezone) as o,
      u.full_name as name, u.id
    from public.users u
    join public.presence pr on pr.user_id = u.id
    left join public.teams t on t.id = u.team_id
    left join public.projects pj on pj.id = pr.project_id
    -- Today in the person's own time zone, by when each check-in was shown.
    left join lateral (
      select count(*) filter (where c.outcome <> 'deferred')::int as shown,
             count(*) filter (where c.outcome = 'pass')::int as passed
      from public.checkin_events c
      where c.user_id = u.id
        and coalesce(c.shown_at, c.created_at)
          >= (date_trunc('day', now() at time zone u.timezone) at time zone u.timezone)
    ) today on true
    where u.org_id = v_org
      and u.active
      and public.can_view_user(u.id)
      and (v_team is null or u.team_id = v_team)
      and (v_status is null or pr.status::text = v_status)
      and (v_all or pr.status not in ('off_shift', 'on_leave'))
    order by u.full_name, u.id
    limit c_max + 1
  ) x;
  return jsonb_build_object('as_of', now()) || internal.mcp_capped(v_rows, c_max, 'people');
end;
$$;

-- One person's day (their own calendar day, in their time zone): totals, time segments,
-- check-ins with the miss reason picked, and the top apps by time (names and seconds
-- only). Defaults: the caller, today in the person's time zone.
create function internal.mcp_person_day(p jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_me public.users := internal.current_app_user();
  v_id uuid;
  v_user public.users;
  v_day date;
  v_start timestamptz;
  v_end timestamptz;
  v_segments jsonb;
  v_totals jsonb;
  v_checkins jsonb;
  v_apps jsonb;
begin
  perform internal.api_allow(p, array['user_id', 'date']);
  v_id := coalesce(internal.api_uuid(p, 'user_id'), v_me.id);
  select * into v_user from public.users u where u.id = v_id and u.org_id = v_me.org_id;
  if not found or not public.can_view_user(v_id) then
    raise exception 'person_not_found' using errcode = '42501';
  end if;
  v_day := coalesce(internal.api_day(p, 'date'), (now() at time zone v_user.timezone)::date);
  v_start := v_day::timestamp at time zone v_user.timezone;
  v_end := (v_day + 1)::timestamp at time zone v_user.timezone;

  select
    coalesce(jsonb_agg(jsonb_build_object(
        'start_at', s.start_at, 'end_at', s.end_at,
        'duration_s', extract(epoch from s.end_at - s.start_at)::float8,
        'type', s.type,
        'project', case when pj.id is not null then jsonb_build_object('id', pj.id, 'name', pj.name) end,
        'task', case when tk.id is not null then jsonb_build_object('id', tk.id, 'name', tk.name) end,
        'counted', s.counted, 'flagged', s.flagged, 'excluded', s.excluded)
      order by s.start_at, s.id), '[]'::jsonb),
    jsonb_build_object(
      'worked_s', coalesce(sum(extract(epoch from s.end_at - s.start_at))
        filter (where s.counted and not s.excluded), 0)::float8,
      'flagged_s', coalesce(sum(extract(epoch from s.end_at - s.start_at))
        filter (where s.flagged and not s.excluded), 0)::float8,
      'excluded_s', coalesce(sum(extract(epoch from s.end_at - s.start_at))
        filter (where s.excluded), 0)::float8,
      'manual_s', coalesce(sum(extract(epoch from s.end_at - s.start_at))
        filter (where s.type = 'manual' and s.counted and not s.excluded), 0)::float8,
      'break_s', coalesce(sum(extract(epoch from s.end_at - s.start_at))
        filter (where s.type = 'break'), 0)::float8,
      'pause_s', coalesce(sum(extract(epoch from s.end_at - s.start_at))
        filter (where s.type in ('pause', 'pause_over_cap')), 0)::float8)
  into v_segments, v_totals
  from public.time_segments s
  left join public.projects pj on pj.id = s.project_id
  left join public.project_tasks tk on tk.id = s.task_id
  where s.user_id = v_id and s.day = v_day;

  -- Metadata only: never when it was scheduled, captures, apps, flags or the remark.
  select coalesce(jsonb_agg(jsonb_build_object(
      'outcome', c.outcome, 'shown_at', c.shown_at, 'responded_at', c.responded_at,
      'response_ms', c.response_ms,
      'miss_reason', case when c.outcome = 'miss' then c.missed_reason_kind end)
    order by coalesce(c.shown_at, c.created_at), c.id), '[]'::jsonb)
  into v_checkins
  from public.checkin_events c
  where c.user_id = v_id
    and coalesce(c.shown_at, c.created_at) >= v_start
    and coalesce(c.shown_at, c.created_at) < v_end;

  -- The dashboard's top apps (empty when the person's policy doesn't sample activity).
  select coalesce(jsonb_agg(jsonb_build_object('app', a.app_name, 'seconds', a.seconds)
    order by a.seconds desc, a.app_name), '[]'::jsonb)
  into v_apps
  from public.top_apps(v_id, v_start, v_end, 10) a;

  return jsonb_build_object(
    'person', internal.mcp_person(v_user.id, v_user.full_name),
    'date', v_day, 'timezone', v_user.timezone,
    'totals', v_totals || jsonb_build_object(
      'checkins_shown', (select count(*) from jsonb_array_elements(v_checkins) e
                         where e ->> 'outcome' <> 'deferred'),
      'checkins_missed', (select count(*) from jsonb_array_elements(v_checkins) e
                          where e ->> 'outcome' = 'miss')),
    'segments', v_segments, 'checkins', v_checkins, 'top_apps', v_apps);
end;
$$;

-- Weekly timesheets with status, approver and the week's seconds. One week (`week`: any
-- day in it; the default, the caller's current week) lists everyone the caller sees,
-- including people who haven't started theirs (status draft); `from` / `to` pick weeks by
-- their first day and list the timesheets that exist. `waiting_for_my_approval`: submitted
-- weeks the caller may approve or return (any week unless one is given).
create function internal.mcp_list_timesheets(p jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  c_max constant int := 500;
  v_me public.users := internal.current_app_user();
  v_week date;
  d record;
  v_status text;
  v_waiting boolean;
  v_user uuid;
  v_team uuid;
  v_rows jsonb;
begin
  perform internal.api_allow(p, array['week', 'from', 'to', 'status', 'waiting_for_my_approval',
    'user_id', 'team_id']);
  v_week := internal.api_day(p, 'week');
  select * into d from internal.api_days(p);
  if v_week is not null and (d.from_day is not null or d.to_day is not null) then
    perform internal.api_bad_param('week', 'give week, or from and to, not both');
  end if;
  if d.to_day - d.from_day > 366 then
    perform internal.api_bad_param('to', 'a range covers at most 366 days');
  end if;
  v_status := internal.api_enum(p, 'status', array['draft', 'submitted', 'approved', 'returned']);
  v_waiting := coalesce(internal.api_bool(p, 'waiting_for_my_approval'), false);
  v_user := internal.api_uuid(p, 'user_id');
  v_team := internal.api_uuid(p, 'team_id');
  if v_week is null and d.from_day is null and d.to_day is null and not v_waiting then
    v_week := (now() at time zone v_me.timezone)::date;
  end if;

  select jsonb_agg(x.o order by x.period_start desc, x.name, x.uid) into v_rows
  from (
    select jsonb_build_object(
        'person', internal.mcp_person(w.user_id, w.full_name),
        'period_start', w.period_start, 'period_end', w.period_start + 6,
        'status', w.status, 'started', w.timesheet_id is not null,
        'submitted_at', w.submitted_at, 'approved_at', w.approved_at,
        'approver', internal.mcp_person(ap.id, ap.full_name), 'returned_at', w.returned_at,
        'waiting_for_my_approval', w.status = 'submitted' and public.can_decide_timesheet(w.user_id),
        'worked_s', tot.worked_s, 'flagged_s', tot.flagged_s, 'excluded_s', tot.excluded_s,
        'manual_s', tot.manual_s) as o,
      w.period_start, w.full_name as name, w.user_id as uid
    from (
      -- One week: everyone visible, with or without a timesheet row.
      select u.id as user_id, u.full_name, ws.period_start, t.id as timesheet_id,
        coalesce(t.status, 'draft') as status, t.submitted_at, t.approved_at, t.approver_id,
        t.returned_at
      from public.users u
      cross join (select internal.week_start(v_me.org_id, v_week) as period_start) ws
      left join public.timesheets t on t.user_id = u.id and t.period_start = ws.period_start
      where v_week is not null
        and u.org_id = v_me.org_id and u.active
        and public.can_view_user(u.id)
        and (v_user is null or u.id = v_user)
        and (v_team is null or u.team_id = v_team)
      union all
      -- A range (or every week): the timesheets that exist.
      select t.user_id, u.full_name, t.period_start, t.id, t.status, t.submitted_at,
        t.approved_at, t.approver_id, t.returned_at
      from public.timesheets t
      join public.users u on u.id = t.user_id
      where v_week is null
        and t.org_id = v_me.org_id
        and public.can_view_user(t.user_id)
        and (v_user is null or t.user_id = v_user)
        and (v_team is null or u.team_id = v_team)
        and (d.from_day is null or t.period_start >= d.from_day)
        and (d.to_day is null or t.period_start <= d.to_day)
    ) w
    left join public.users ap on ap.id = w.approver_id
    cross join lateral (
      select
        coalesce(sum(extract(epoch from s.end_at - s.start_at))
          filter (where s.counted and not s.excluded), 0)::float8 as worked_s,
        coalesce(sum(extract(epoch from s.end_at - s.start_at))
          filter (where s.flagged and not s.excluded), 0)::float8 as flagged_s,
        coalesce(sum(extract(epoch from s.end_at - s.start_at))
          filter (where s.excluded), 0)::float8 as excluded_s,
        coalesce(sum(extract(epoch from s.end_at - s.start_at))
          filter (where s.type = 'manual' and s.counted and not s.excluded), 0)::float8 as manual_s
      from public.time_segments s
      where s.user_id = w.user_id and s.day between w.period_start and w.period_start + 6
    ) tot
    where (v_status is null or w.status = v_status)
      and (not v_waiting or (w.status = 'submitted' and public.can_decide_timesheet(w.user_id)))
    order by w.period_start desc, w.full_name, w.user_id
    limit c_max + 1
  ) x;
  return jsonb_build_object('week_start', case when v_week is not null
      then internal.week_start(v_me.org_id, v_week) end)
    || internal.mcp_capped(v_rows, c_max, 'timesheets');
end;
$$;

-- DSH-07, DSH-10: worked and flagged seconds for a date range (each person's own days),
-- grouped by person, team, client, project or task, from the Reports page's numbers
-- (public.report_task_rows). Narrowed by team, manager, person, client or project.
create function internal.mcp_hours_report(p jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  d record;
  v_group text;
  v_project uuid;
  v_client uuid;
  v_ids uuid[];
  v_rows jsonb;
begin
  perform internal.api_allow(p, array['from', 'to', 'group_by', 'team_id', 'manager_id', 'user_id',
    'client_id', 'project_id']);
  select * into d from internal.mcp_range(p, true, null, 366);
  v_group := coalesce(internal.api_enum(p, 'group_by',
    array['person', 'team', 'client', 'project', 'task']), 'person');
  v_project := internal.api_uuid(p, 'project_id');
  v_client := internal.api_uuid(p, 'client_id');
  v_ids := internal.api_report_people(p);
  if cardinality(v_ids) = 0 then
    return jsonb_build_object('from', d.from_day, 'to', d.to_day, 'group_by', v_group,
      'rows', '[]'::jsonb, 'total_worked_s', 0, 'total_flagged_s', 0);
  end if;

  with r as (
    select r.user_id, u.full_name, t.id as team_id, t.name as team_name,
      c.id as client_id, c.name as client_name, pj.id as project_id, pj.name as project_name,
      tk.id as task_id, tk.name as task_name, r.worked_s, r.flagged_s
    from public.report_task_rows(d.from_day, d.to_day, v_ids, null, null) r
    join public.users u on u.id = r.user_id
    left join public.teams t on t.id = u.team_id
    left join public.projects pj on pj.id = r.project_id
    left join public.clients c on c.id = pj.client_id
    left join public.project_tasks tk on tk.id = r.task_id
    where (v_project is null or r.project_id = v_project)
      and (v_client is null or pj.client_id = v_client)
  ), g as (
    select
      case v_group when 'person' then r.user_id when 'team' then r.team_id
        when 'client' then r.client_id else r.project_id end as gid,
      case v_group when 'person' then r.full_name when 'team' then r.team_name
        when 'client' then r.client_name else r.project_name end as gname,
      case when v_group = 'task' then r.task_id end as tid,
      case when v_group = 'task' then r.task_name end as tname,
      r.user_id, r.worked_s, r.flagged_s
    from r
  )
  select jsonb_agg(x.o order by x.worked desc, x.gname nulls last, x.tname nulls last) into v_rows
  from (
    select jsonb_build_object(
        case v_group when 'task' then 'project' else v_group end,
        case when g.gid is null then null else jsonb_build_object('id', g.gid, 'name', g.gname) end)
      || case when v_group = 'task' then jsonb_build_object('task',
           case when g.tid is null then null else jsonb_build_object('id', g.tid, 'name', g.tname) end)
         else '{}'::jsonb end
      || jsonb_build_object('worked_s', sum(g.worked_s), 'flagged_s', sum(g.flagged_s),
        'people', count(distinct g.user_id)) as o,
      sum(g.worked_s) as worked, g.gname, g.tname
    from g
    group by g.gid, g.gname, g.tid, g.tname
  ) x;

  return jsonb_build_object(
    'from', d.from_day, 'to', d.to_day, 'group_by', v_group,
    'rows', coalesce(v_rows, '[]'::jsonb),
    'total_worked_s', coalesce((select sum((e ->> 'worked_s')::numeric) from jsonb_array_elements(v_rows) e), 0),
    'total_flagged_s', coalesce((select sum((e ->> 'flagged_s')::numeric) from jsonb_array_elements(v_rows) e), 0),
    'note', 'Rows with no team, client, project or task are time without one (shown as null).');
end;
$$;

-- Manager alerts (ALR-01) the caller may read, as on the dashboard: their own, and those
-- about people they can see (never alerts about themselves). One row per occurrence
-- (each recipient gets a copy). `from` / `to` are days in the caller's time zone, on when
-- it was raised; the default is the last 7 days.
create function internal.mcp_list_alerts(p jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  c_max constant int := 200;
  v_me public.users := internal.current_app_user();
  v_today date := (now() at time zone v_me.timezone)::date;
  d record;
  v_kind text;
  v_user uuid;
  v_team uuid;
  v_rows jsonb;
begin
  perform internal.api_allow(p, array['from', 'to', 'kind', 'user_id', 'team_id']);
  select * into d from internal.mcp_range(p, false, v_today, 92);
  v_kind := internal.api_enum(p, 'kind',
    (select array_agg(k::text) from unnest(enum_range(null::public.alert_kind)) k));
  v_user := internal.api_uuid(p, 'user_id');
  v_team := internal.api_uuid(p, 'team_id');

  select jsonb_agg(y.o order by y.at desc, y.id) into v_rows
  from (
    select x.o, x.at, x.id
    from (
      -- One row per occurrence: the caller's own copy when they got one.
      select distinct on (a.user_id, a.kind, a.episode)
        jsonb_build_object(
          'person', internal.mcp_person(u.id, u.full_name),
          'kind', a.kind, 'triggered_at', a.triggered_at, 'details', a.details,
          'sent_to_me', a.recipient_id = v_me.id,
          'read', case when a.recipient_id = v_me.id then a.read_at is not null end) as o,
        a.triggered_at as at, a.id
      from public.alerts a
      join public.users u on u.id = a.user_id
      where a.org_id = v_me.org_id
        and (a.recipient_id = v_me.id or (a.user_id <> v_me.id and public.can_view_user(a.user_id)))
        and a.triggered_at >= d.from_day::timestamp at time zone v_me.timezone
        and a.triggered_at < (d.to_day + 1)::timestamp at time zone v_me.timezone
        and (v_kind is null or a.kind::text = v_kind)
        and (v_user is null or a.user_id = v_user)
        and (v_team is null or u.team_id = v_team)
      order by a.user_id, a.kind, a.episode, (a.recipient_id = v_me.id) desc, a.triggered_at, a.id
    ) x
    order by x.at desc, x.id
    limit c_max + 1
  ) y;
  return jsonb_build_object('from', d.from_day, 'to', d.to_day, 'timezone', v_me.timezone)
    || internal.mcp_capped(v_rows, c_max, 'alerts');
end;
$$;

-- Dispatch -------------------------------------------------------------------------------------

-- The tools, by name (the mcp Edge Function lists the same names, supabase/functions/mcp/tools.ts).
create function internal.mcp_tools()
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array['list_people', 'who_is_on_shift', 'get_person_day', 'list_timesheets',
    'hours_report', 'list_alerts'];
$$;

create function internal.mcp_dispatch(p_tool text, p_args jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  p jsonb := coalesce(p_args, '{}'::jsonb);
begin
  return case p_tool
    when 'list_people' then internal.mcp_list_people(p)
    when 'who_is_on_shift' then internal.mcp_who_is_on_shift(p)
    when 'get_person_day' then internal.mcp_person_day(p)
    when 'list_timesheets' then internal.mcp_list_timesheets(p)
    when 'hours_report' then internal.mcp_hours_report(p)
    when 'list_alerts' then internal.mcp_list_alerts(p)
  end;
end;
$$;

-- Makes this transaction run as `p_user`, with the claims their assistant's token
-- carries: sub, role, org_id, and the token's own aal (so the org's admin-MFA rule
-- applies as on the dashboard). Transaction-local.
create function internal.mcp_act_as(p_user public.users, p_aal text)
returns void
language plpgsql
set search_path = ''
as $$
begin
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claim', '', true);
  perform set_config('request.jwt.claims', jsonb_build_object(
    'sub', p_user.id, 'role', 'authenticated', 'org_id', p_user.org_id,
    'aal', case when p_aal = 'aal2' then 'aal2' else 'aal1' end, 'ai_assistant', true)::text, true);
end;
$$;

create function internal.mcp_error(p_code text, p_message text)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object('ok', false, 'error', jsonb_build_object('code', p_code, 'message', p_message));
$$;

do $$
declare
  f text;
begin
  foreach f in array array[
    'internal.mcp_list_people(jsonb)', 'internal.mcp_who_is_on_shift(jsonb)',
    'internal.mcp_person_day(jsonb)', 'internal.mcp_list_timesheets(jsonb)',
    'internal.mcp_hours_report(jsonb)', 'internal.mcp_list_alerts(jsonb)',
    'internal.mcp_tools()', 'internal.mcp_dispatch(text, jsonb)',
    'internal.mcp_act_as(public.users, text)', 'internal.mcp_error(text, text)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
  end loop;
end;
$$;

-- One tool call (service role only: the mcp Edge Function, after Auth accepted the token).
-- `p_client_id` and `p_aal` are the token's claims. Returns { ok: true, result } or
-- { ok: false, error: { code, message }, retry_after? }; never raises for the caller's
-- mistakes. Every call is audit-logged as `mcp.tool_call` (the person, the tool, its
-- arguments, the rows returned, the assistant), refused and failed ones too; a call over
-- the rate limit is not.
create function public.mcp_call(
  p_user_id uuid,
  p_client_id text,
  p_aal text,
  p_tool text,
  p_args jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user public.users;
  v_org public.orgs;
  v_args jsonb := coalesce(p_args, '{}'::jsonb);
  v_client text;
  v_meta jsonb;
  v_window timestamptz := date_trunc('minute', now());
  v_calls int;
  v_retry int;
  v_result jsonb;
  v_target uuid;
  v_error jsonb;
  v_state text;
  v_message text;
  v_detail text;
begin
  select * into v_user from public.users u where u.id = p_user_id;
  if not found or not v_user.active then
    return internal.mcp_error('not_a_member',
      'This account is not an active member of an organization in AI Proctor.');
  end if;
  if p_tool is null or not p_tool = any (internal.mcp_tools()) then
    return internal.mcp_error('unknown_tool', format('There is no tool named %s.', coalesce(p_tool, 'null')));
  end if;
  select * into v_org from public.orgs o where o.id = v_user.org_id;

  -- Which assistant, for the audit log (Auth's own table; the id alone when it can't be read).
  begin
    select c.client_name into v_client from auth.oauth_clients c where c.id::text = p_client_id;
  exception when others then
    v_client := null;
  end;
  v_meta := jsonb_build_object('tool', p_tool, 'client_id', p_client_id, 'client_name', v_client,
    'filters', case when jsonb_typeof(v_args) = 'object' then v_args else '{}'::jsonb end);
  v_target := case when v_args ->> 'user_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then (v_args ->> 'user_id')::uuid end;

  if not v_org.ai_assistant_access then
    perform internal.audit(v_org.id, v_user.id, 'mcp.tool_call', v_target,
      v_meta || jsonb_build_object('row_count', 0, 'error', 'ai_assistant_access_off'));
    return internal.mcp_error('ai_assistant_access_off', format(
      'AI assistant access is turned off for %s. An owner or admin can turn it on in AI Proctor under Settings, API.',
      v_org.name));
  end if;

  insert into internal.mcp_rate as r (user_id, window_start, calls)
  values (v_user.id, v_window, 1)
  on conflict (user_id) do update
    set calls = case when r.window_start = excluded.window_start then r.calls + 1 else 1 end,
        window_start = excluded.window_start
  returning r.calls into v_calls;
  if v_calls > internal.mcp_rate_limit() then
    v_retry := ceil(extract(epoch from v_window + interval '1 minute' - now()))::int;
    return internal.mcp_error('rate_limited', format(
      'Too many requests: at most %s tool calls a minute. Try again in %s seconds.',
      internal.mcp_rate_limit(), v_retry)) || jsonb_build_object('retry_after', v_retry);
  end if;

  if jsonb_typeof(v_args) <> 'object' then
    v_error := internal.mcp_error('invalid_param', 'arguments: expected a JSON object');
  else
    begin
      perform internal.mcp_act_as(v_user, p_aal);
      v_result := internal.mcp_dispatch(p_tool, v_args);
    exception when others then
      get stacked diagnostics v_state = returned_sqlstate, v_message = message_text,
        v_detail = pg_exception_detail;
      if v_state in ('22023', '22P02', '22007', '22008') then
        v_error := internal.mcp_error('invalid_param',
          coalesce(nullif(v_detail, ''), 'The arguments were refused: ' || v_message));
      elsif v_state = '42501' and v_message like '%not_found' then
        v_error := internal.mcp_error('not_found',
          'Not found, or not someone you can see in AI Proctor. Use list_people to find people.');
      elsif v_state = '42501' then
        v_error := internal.mcp_error('forbidden', 'You are not allowed to see this in AI Proctor.');
      else
        raise warning 'mcp_call % failed: % %', p_tool, v_state, v_message;
        v_error := internal.mcp_error('internal_error', 'Something went wrong. Try again later.');
      end if;
    end;
  end if;

  -- The claims were set inside the block that ran the tool; the audit row is the caller's.
  perform internal.audit(v_org.id, v_user.id, 'mcp.tool_call', v_target,
    v_meta || jsonb_build_object('row_count', coalesce(internal.mcp_row_count(v_result), 0))
      || case when v_error is not null then jsonb_build_object('error', v_error -> 'error' ->> 'code')
         else '{}'::jsonb end);
  return coalesce(v_error, jsonb_build_object('ok', true, 'result', v_result));
end;
$$;
revoke all on function public.mcp_call(uuid, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.mcp_call(uuid, text, text, text, jsonb) to service_role;
