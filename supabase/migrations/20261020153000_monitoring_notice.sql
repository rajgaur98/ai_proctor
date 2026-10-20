-- #48: monitoring notice, acknowledgement and re-acknowledgement (AGT-04, AGT-05,
-- ADM-06, EMP-05).
--
-- An org has a versioned notice (what is collected, when, who sees it, how long it
-- is kept, the employee's rights). Versions are never edited: a change publishes
-- the next one. Every new version needs a fresh acknowledgement from each
-- employee. Each notice carries `collection`, a snapshot of the collection-affecting
-- policy keys when it was published. What the agent may collect for a person comes
-- from the snapshot of the latest version THEY acknowledged, so a policy change that
-- collects more (webcam on, window titles on, ...) only reaches them once they
-- acknowledge the version that describes it. A change that collects less applies at
-- once (the stricter of the acknowledged snapshot and the current policy wins).
-- Someone who has never acknowledged anything collects nothing, and the server
-- refuses their clock-in.
--
-- The template text below is a starting point per region preset (US state notice
-- laws, GDPR Art. 13, DPDP). A privacy lawyer must review it before the first paid
-- customer (PRD 5.2).

-- Tables ------------------------------------------------------------------------------

-- Body (plain text): intro? collected when who retention rights grievance?
create function internal.valid_notice_body(p_body jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select jsonb_typeof(p_body) = 'object'
    and not exists (
      select 1 from jsonb_object_keys(p_body) k
      where k not in ('intro', 'collected', 'when', 'who', 'retention', 'rights', 'grievance')
    )
    -- Required sections: non-empty text.
    and not exists (
      select 1 from unnest(array['collected', 'when', 'who', 'retention', 'rights']) k
      where jsonb_typeof(p_body -> k) is distinct from 'string'
        or length(btrim(p_body ->> k)) not between 1 and 4000
    )
    -- Optional sections: text when present.
    and not exists (
      select 1 from unnest(array['intro', 'grievance']) k
      where p_body ? k and (jsonb_typeof(p_body -> k) <> 'string' or length(p_body ->> k) > 4000)
    );
$$;

revoke all on function internal.valid_notice_body(jsonb) from public, anon, authenticated;
grant execute on function internal.valid_notice_body(jsonb) to postgres;

create table public.notices (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  version int not null check (version > 0),
  region public.region_preset not null,
  body jsonb not null check (internal.valid_notice_body(body)),
  -- Collection-affecting policy keys when this version was published.
  collection jsonb not null,
  published_at timestamptz not null default now(),
  -- Null for the template version and for versions published by a policy change.
  published_by uuid references public.users (id) on delete set null,
  unique (org_id, version)
);

create table public.notice_acks (
  user_id uuid not null references public.users (id) on delete cascade,
  notice_id uuid not null references public.notices (id) on delete cascade,
  acknowledged_at timestamptz not null default now(),
  primary key (user_id, notice_id)
);
create index notice_acks_notice_idx on public.notice_acks (notice_id);

alter table public.notices enable row level security;
alter table public.notice_acks enable row level security;

-- Published notices and acknowledgements are history: never edited.
create function internal.notice_history_is_append_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'notice_history_is_append_only' using errcode = '42501';
end;
$$;

create trigger notices_no_update before update on public.notices
for each row execute function internal.notice_history_is_append_only();
create trigger notice_acks_no_update before update on public.notice_acks
for each row execute function internal.notice_history_is_append_only();

revoke all on function internal.notice_history_is_append_only() from public, anon, authenticated;

create policy "Members read their org's notices"
on public.notices for select to authenticated
using (org_id = (select internal.jwt_org_id()));

-- Own acknowledgements, and the ones can_view_user allows (admins and managers
-- see who has acknowledged).
create policy "Acknowledgements visible per can_view_user"
on public.notice_acks for select to authenticated
using (public.can_view_user(user_id));

-- Collection settings ----------------------------------------------------------------

-- The collection-affecting policy keys with their defaults filled in (the defaults
-- the agent and server already use when a key is missing). Keys:
--   screenshots     'full' | 'blurred' | 'off'   (CAP-02)
--   webcam          boolean                      (CAP-05)
--   window_titles   boolean                      (ACT-03)
--   excluded_apps   text[]                       (CAP-04, ACT-02)
--   activity_sampling boolean                    (ACT-01, ACT-03)
-- A new collection-affecting key goes here, and nowhere else needs to learn of it
-- to require re-acknowledgement.
create function internal.collection_snapshot(p_policy jsonb)
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
           then (p_policy -> 'activity_sampling')::boolean else true end
  );
$$;

-- What someone who has acknowledged nothing may collect: nothing.
create function internal.collection_off()
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object(
    'screenshots', 'off', 'webcam', false, 'window_titles', false,
    'excluded_apps', '[]'::jsonb, 'activity_sampling', false
  );
$$;

-- What the agent may collect for this person: the stricter of the latest snapshot
-- they acknowledged and the org's current policy, per key. Collecting more waits
-- for their acknowledgement; collecting less applies at once. Nothing at all
-- before the first acknowledgement.
create function internal.effective_collection(p_user_id uuid)
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
      (v_acked ->> 'activity_sampling')::boolean and (v_now ->> 'activity_sampling')::boolean
  );
end;
$$;

revoke all on function internal.collection_snapshot(jsonb) from public, anon, authenticated;
revoke all on function internal.collection_off() from public, anon, authenticated;
revoke all on function internal.effective_collection(uuid) from public, anon, authenticated;

-- Template text ------------------------------------------------------------------------

-- The default notice for a region preset, filled from the org's policy: what is
-- collected, retention, who sees it. Not legal advice: see the note at the top.
create function internal.default_notice_body(
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

revoke all on function internal.default_notice_body(uuid, public.region_preset, jsonb)
  from public, anon, authenticated;

-- Publishing ----------------------------------------------------------------------------

-- Inserts the next version of an org's notice. Callers lock or own the org row.
create function internal.insert_notice(
  p_org_id uuid,
  p_region public.region_preset,
  p_body jsonb,
  p_collection jsonb,
  p_by uuid
)
returns public.notices
language sql
security definer
set search_path = ''
as $$
  insert into public.notices (org_id, version, region, body, collection, published_by)
  values (
    p_org_id,
    coalesce((select max(n.version) from public.notices n where n.org_id = p_org_id), 0) + 1,
    p_region, p_body, p_collection, p_by
  )
  returning *;
$$;

revoke all on function internal.insert_notice(uuid, public.region_preset, jsonb, jsonb, uuid)
  from public, anon, authenticated;

-- A new org gets version 1 from its region's template.
create function internal.orgs_default_notice()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_notice public.notices;
begin
  v_notice := internal.insert_notice(
    new.id, new.region_preset,
    internal.default_notice_body(new.id, new.region_preset, new.policy),
    internal.collection_snapshot(new.policy), null);
  perform internal.audit(new.id, null, 'notice.published', null,
    jsonb_build_object('version', v_notice.version, 'source', 'template'));
  return null;
end;
$$;

create trigger orgs_default_notice
after insert on public.orgs
for each row execute function internal.orgs_default_notice();

-- AGT-05: a change to any collection-affecting policy key publishes a new notice
-- version. The text is re-rendered from the template when the latest version is
-- still the unedited template; an admin's own wording is kept (the admin page tells
-- them to review it). Agents refetch their config (policy_version).
create function internal.orgs_republish_notice()
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

create trigger orgs_republish_notice
before update of policy on public.orgs
for each row
when (old.policy is distinct from new.policy)
execute function internal.orgs_republish_notice();

revoke all on function internal.orgs_default_notice() from public, anon, authenticated;
revoke all on function internal.orgs_republish_notice() from public, anon, authenticated;

-- Orgs that exist already start from their template too.
insert into public.notices (org_id, version, region, body, collection)
select o.id, 1, o.region_preset,
  internal.default_notice_body(o.id, o.region_preset, o.policy),
  internal.collection_snapshot(o.policy)
from public.orgs o
where not exists (select 1 from public.notices n where n.org_id = o.id);

-- ADM-06: the template for the caller's org (what "Start from the template" fills in).
create function public.notice_template()
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
  if v_me.role not in ('owner', 'admin') then
    raise exception 'admin_only' using errcode = '42501';
  end if;
  select * into v_org from public.orgs where id = v_me.org_id;
  return internal.default_notice_body(v_org.id, v_org.region_preset, v_org.policy);
end;
$$;

-- ADM-06: an admin publishes the next version with their text. Everyone has to
-- acknowledge it. Returns the new version number.
create function public.publish_notice(p_body jsonb)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me public.users := internal.current_app_user();
  v_org public.orgs;
  v_notice public.notices;
begin
  if v_me.role not in ('owner', 'admin') then
    raise exception 'admin_only' using errcode = '42501';
  end if;
  if not internal.valid_notice_body(p_body) then
    raise exception 'invalid_notice' using errcode = '22023';
  end if;
  -- Serialises publishers (and a policy change) on this org.
  select * into v_org from public.orgs where id = v_me.org_id for update;
  v_notice := internal.insert_notice(
    v_org.id, v_org.region_preset, p_body, internal.collection_snapshot(v_org.policy), v_me.id);
  update public.orgs set policy_version = policy_version + 1 where id = v_org.id;
  perform internal.audit(v_org.id, v_me.id, 'notice.published', null,
    jsonb_build_object('version', v_notice.version, 'source', 'admin'));
  return v_notice.version;
end;
$$;

-- AGT-04, EMP-05: the employee acknowledges the current version (only the latest;
-- an older one is refused). Repeating it changes nothing.
create function public.acknowledge_notice(p_notice_id uuid)
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
    -- Agents refetch their config when the version moves; the collection they may
    -- run with just changed for this person.
    update public.orgs set policy_version = policy_version + 1 where id = v_me.org_id;
    perform internal.audit(v_me.org_id, v_me.id, 'notice.acknowledged', v_me.id,
      jsonb_build_object('version', v_notice.version));
  end if;
end;
$$;

revoke all on function public.notice_template() from public, anon;
revoke all on function public.publish_notice(jsonb) from public, anon;
revoke all on function public.acknowledge_notice(uuid) from public, anon;
grant execute on function public.notice_template() to authenticated;
grant execute on function public.publish_notice(jsonb) to authenticated;
grant execute on function public.acknowledge_notice(uuid) to authenticated;

-- Agent config with the notice and the collection the person may run with (replaces
-- the projects migration's version) ------------------------------------------------------

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

-- Activity: titles and sampling follow the person's effective collection (replaces
-- activity_samples' version) -------------------------------------------------------------

create or replace function internal.record_activity(
  p_device public.devices,
  p_event_id uuid,
  p_payload jsonb
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_start timestamptz := (p_payload ->> 'start')::timestamptz;
  v_end timestamptz := (p_payload ->> 'end')::timestamptz;
  v_minute timestamptz := date_trunc('minute', v_start);
  v_seconds int := round(extract(epoch from v_end - v_start))::int;
  v_policy jsonb := internal.effective_collection(p_device.user_id);
  v_app text := p_payload ->> 'app';
  v_title text := nullif(p_payload ->> 'title', '');
begin
  -- One bucket: inside a single minute, at least a second long.
  if v_end < v_start or v_end > v_minute + interval '1 minute' or v_seconds < 1 then
    return 'invalid_app_session';
  end if;
  -- ACT-01: only time spent working, never on a break or pause.
  if not exists (
    select 1 from public.clock_sessions cs
    where cs.user_id = p_device.user_id and cs.start_at <= v_start
      and coalesce(cs.end_at, 'infinity') >= v_end
  ) or exists (
    select 1 from public.breaks b
    where b.user_id = p_device.user_id and b.start_at < v_end and coalesce(b.end_at, 'infinity') > v_start
  ) or exists (
    select 1 from public.pauses p
    where p.user_id = p_device.user_id and p.start_at < v_end and coalesce(p.end_at, 'infinity') > v_start
  ) then
    return 'not_working';
  end if;
  -- Activity sampling off for this person (AGT-05): accepted, not stored.
  if not (v_policy ->> 'activity_sampling')::boolean then
    return null;
  end if;
  if not (v_policy ->> 'window_titles')::boolean
    or exists (
      select 1 from jsonb_array_elements_text(v_policy -> 'excluded_apps') e
      where lower(e) = lower(v_app)
    )
  then
    v_title := null;
  end if;
  perform internal.ensure_weekly_partitions('public.activity_samples', v_minute, v_minute);
  insert into public.activity_samples (
    id, org_id, user_id, device_id, minute, app_name, window_title, domain, seconds
  )
  values (
    p_event_id, p_device.org_id, p_device.user_id, p_device.id, v_minute, v_app, v_title,
    nullif(lower(p_payload ->> 'domain'), ''), least(v_seconds, 60)
  )
  on conflict do nothing;
  return null;
end;
$$;

-- Event projection: no clock-in before the first acknowledgement, and the camera
-- permission only counts when this person's effective collection has the webcam on
-- (replaces the breaks migration's version) -----------------------------------------------

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
    -- counts when this person's collection includes the webcam.
    update public.presence p
    set permission_missing = (p_payload ->> 'screen') <> 'granted'
      or ((p_payload ->> 'camera') <> 'granted'
          and (internal.effective_collection(p_device.user_id) ->> 'webcam')::boolean)
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
