-- #306 (API-01..API-05, AUD-01): the public API v1, with org API keys.
--
-- The HTTP side is the api-v1 Edge Function (supabase/functions/api-v1): it routes
-- `/v1/...`, hashes the key from `Authorization: Bearer aip_...` and makes two calls, both
-- for the service role only:
--   1. api_v1_authenticate(key hash): is the key known, not revoked, not expired, and is
--      the person who made it still an active owner or admin? Then it counts the request
--      against the key's rate limit (a fixed window per minute) and commits that count, so
--      a request that fails later still counts.
--   2. api_v1_call(key id, operation, params): checks the key again and its scope, then
--      runs the operation *as the key's creator* (internal.api_act_as sets the request's
--      JWT claims to theirs, for this transaction only) and audit-logs it in the same
--      transaction: a read as `api.read` with the key, the filters and the row count (like
--      an export, AUD-01), a write as `api.write`. Errors come back as an HTTP status and
--      an error body, never as a raised exception.
-- Running as the creator means every rule is the dashboard's own: can_view_user() for
-- reads (an owner or admin sees the whole org), save_client / save_project / save_task
-- for writes, and internal.create_manual_entry (TS-07..09, TS-24) for manual entries, with
-- the creator as the actor in their audit events. Defaults (#306): owners and admins
-- only; a key acts at the org level; a key stops working when its creator is no longer
-- an active owner or admin (they were the one who could see and do all of it).
--
-- The read layer is internal.api_dispatch(operation, params): plain functions over
-- auth.uid() and can_view_user(), so the MCP server (#307) can call them for a signed-in
-- person and get exactly what that person sees.
--
-- What the API never returns (API-04): capture images or links (object_keys), window
-- titles, browser domains, the scheduled time of a check-in (so never the next one,
-- EMP-01), anti-cheat flags, private pause reasons, the free-text miss reasons. Purged or
-- deleted data (retention, data requests, EMP-06) is gone from the tables it is read from.
--
-- Sync (API-05): lists are ordered by (updated_at, id) and paged with an opaque cursor;
-- `updated_since` returns what changed since a time. To support it, updated_at columns
-- (kept by internal.touch_updated_at) are added to users, teams, clients, projects,
-- project_tasks, timesheets, manual_entries, checkin_events and time_segments. Shifts and
-- alerts are never updated in place (shifts are replaced per person, alerts are
-- immutable), so their created_at / triggered_at serve.
--
-- Redefines no existing function.

-- updated_at for syncing --------------------------------------------------------------------

-- Sets updated_at on every update. With arguments, the columns named are ignored: an
-- update that only changes them (users.config_version, bumped for the tray) leaves
-- updated_at as it was.
create function internal.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_nargs = 0
    or (to_jsonb(new) - 'updated_at' - tg_argv) is distinct from (to_jsonb(old) - 'updated_at' - tg_argv)
  then
    new.updated_at := now();
  else
    new.updated_at := old.updated_at;
  end if;
  return new;
end;
$$;
revoke all on function internal.touch_updated_at() from public, anon, authenticated;

alter table public.users add column updated_at timestamptz not null default now();
alter table public.teams add column updated_at timestamptz not null default now();
alter table public.clients add column updated_at timestamptz not null default now();
alter table public.projects add column updated_at timestamptz not null default now();
alter table public.project_tasks add column updated_at timestamptz not null default now();
alter table public.timesheets add column updated_at timestamptz not null default now();
alter table public.manual_entries add column updated_at timestamptz not null default now();
alter table public.checkin_events add column updated_at timestamptz not null default now();
alter table public.time_segments add column updated_at timestamptz not null default now();

create trigger users_touch_updated_at before update on public.users
  for each row execute function internal.touch_updated_at('config_version');
create trigger teams_touch_updated_at before update on public.teams
  for each row execute function internal.touch_updated_at();
create trigger clients_touch_updated_at before update on public.clients
  for each row execute function internal.touch_updated_at();
create trigger projects_touch_updated_at before update on public.projects
  for each row execute function internal.touch_updated_at();
create trigger project_tasks_touch_updated_at before update on public.project_tasks
  for each row execute function internal.touch_updated_at();
create trigger timesheets_touch_updated_at before update on public.timesheets
  for each row execute function internal.touch_updated_at();
create trigger manual_entries_touch_updated_at before update on public.manual_entries
  for each row execute function internal.touch_updated_at();
create trigger checkin_events_touch_updated_at before update on public.checkin_events
  for each row execute function internal.touch_updated_at();
create trigger time_segments_touch_updated_at before update on public.time_segments
  for each row execute function internal.touch_updated_at();

create index users_org_updated_idx on public.users (org_id, updated_at, id);
create index teams_org_updated_idx on public.teams (org_id, updated_at, id);
create index clients_org_updated_idx on public.clients (org_id, updated_at, id);
create index projects_org_updated_idx on public.projects (org_id, updated_at, id);
create index project_tasks_org_updated_idx on public.project_tasks (org_id, updated_at, id);
create index timesheets_org_updated_idx on public.timesheets (org_id, updated_at, id);
create index manual_entries_org_updated_idx on public.manual_entries (org_id, updated_at, id);
create index checkin_events_org_updated_idx on public.checkin_events (org_id, updated_at, id);
create index time_segments_org_updated_idx on public.time_segments (org_id, updated_at, id);
create index shifts_org_created_idx on public.shifts (org_id, created_at, id);
create index alerts_org_triggered_idx on public.alerts (org_id, triggered_at, id);

-- API keys ------------------------------------------------------------------------------------

-- The scopes a key can hold: read and write per resource (API-02).
create function internal.api_scopes()
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array[
    'people:read', 'teams:read', 'projects:read', 'projects:write', 'shifts:read',
    'timesheets:read', 'time:read', 'time:write', 'checkins:read', 'reports:read',
    'alerts:read'
  ];
$$;
revoke all on function internal.api_scopes() from public, anon, authenticated;
-- The api_keys check below calls it as whoever writes the row (the service role, in tests).
grant execute on function internal.api_scopes() to service_role;

create table public.api_keys (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  -- What the admin calls it, e.g. "Payroll sync".
  name text not null check (length(name) between 1 and 80),
  -- SHA-256 of the whole key (`aip_` + 43 base64url characters).
  key_hash bytea not null unique check (length(key_hash) = 32),
  -- `aip_` and the first four characters, so admins can tell keys apart.
  key_prefix text not null check (key_prefix ~ '^aip_[A-Za-z0-9_-]{4}$'),
  scopes text[] not null check (cardinality(scopes) > 0 and scopes <@ internal.api_scopes()),
  -- Null: never expires.
  expires_at timestamptz,
  -- The key acts as this person; it goes with them when they are deleted (ADM-05).
  created_by uuid not null references public.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoked_by uuid references public.users (id) on delete set null,
  last_used_at timestamptz,
  -- The rate limit's current window (a minute) and the requests counted in it.
  rate_window timestamptz,
  rate_count int not null default 0
);

create index api_keys_org_idx on public.api_keys (org_id, created_at desc);
create index api_keys_created_by_idx on public.api_keys (created_by);
create index api_keys_revoked_by_idx on public.api_keys (revoked_by) where revoked_by is not null;
-- No policies: nobody reads or writes the table through PostgREST; the RPCs below do.
alter table public.api_keys enable row level security;
revoke all on public.api_keys from anon, authenticated;

-- Requests per key per minute. One fixed window per key; the 429 says when it resets.
create function internal.api_rate_limit()
returns int
language sql
immutable
set search_path = ''
as $$ select 120 $$;
revoke all on function internal.api_rate_limit() from public, anon, authenticated;

-- The key's hash, or null when it isn't shaped like one of ours.
create function internal.api_key_hash(p_key text)
returns bytea
language sql
immutable
set search_path = ''
as $$
  select case
    when p_key ~ '^aip_[A-Za-z0-9_-]{43}$'
      then extensions.digest(convert_to(p_key, 'UTF8'), 'sha256')
  end;
$$;
revoke all on function internal.api_key_hash(text) from public, anon, authenticated;

-- Admin RPCs (owners and admins, with MFA when the org requires it) ----------------------------

-- Creates a key and returns it. This is the only time the key exists outside the caller's
-- system: the database keeps its hash.
create function public.create_api_key(
  p_name text,
  p_scopes text[],
  p_expires_at timestamptz default null
)
returns table (
  id uuid,
  name text,
  key text,
  key_prefix text,
  scopes text[],
  expires_at timestamptz,
  created_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me public.users := internal.require_audit_reader();
  v_name text := trim(coalesce(p_name, ''));
  v_scopes text[];
  v_key text;
  v_row public.api_keys;
begin
  if length(v_name) not between 1 and 80 then
    raise exception 'invalid_name' using errcode = '22023';
  end if;
  select array_agg(distinct s order by s) into v_scopes from unnest(p_scopes) s;
  if coalesce(cardinality(v_scopes), 0) = 0 or not v_scopes <@ internal.api_scopes() then
    raise exception 'invalid_scopes' using errcode = '22023';
  end if;
  if p_expires_at is not null and p_expires_at <= now() then
    raise exception 'invalid_expiry' using errcode = '22023';
  end if;
  -- 32 random bytes as base64url without padding: 43 characters.
  v_key := 'aip_' || translate(encode(extensions.gen_random_bytes(32), 'base64'), '+/=', '-_');

  insert into public.api_keys (org_id, name, key_hash, key_prefix, scopes, expires_at, created_by)
  values (v_me.org_id, v_name, internal.api_key_hash(v_key), left(v_key, 8), v_scopes,
    p_expires_at, v_me.id)
  returning * into v_row;

  perform internal.audit(v_me.org_id, v_me.id, 'api_key.created', null,
    jsonb_build_object('key_id', v_row.id, 'name', v_row.name, 'prefix', v_row.key_prefix,
      'scopes', to_jsonb(v_row.scopes), 'expires_at', v_row.expires_at));

  return query select v_row.id, v_row.name, v_key, v_row.key_prefix, v_row.scopes,
    v_row.expires_at, v_row.created_at;
end;
$$;
revoke all on function public.create_api_key(text, text[], timestamptz) from public, anon;
grant execute on function public.create_api_key(text, text[], timestamptz) to authenticated;

-- Stops the key at once. Revoking twice is a no-op.
create function public.revoke_api_key(p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me public.users := internal.require_audit_reader();
  v_row public.api_keys;
begin
  select * into v_row from public.api_keys k
  where k.id = p_id and k.org_id = v_me.org_id
  for update;
  if not found then
    raise exception 'key_not_found' using errcode = '42501';
  end if;
  if v_row.revoked_at is not null then
    return;
  end if;

  update public.api_keys set revoked_at = now(), revoked_by = v_me.id where id = p_id;
  perform internal.audit(v_me.org_id, v_me.id, 'api_key.revoked', null,
    jsonb_build_object('key_id', v_row.id, 'name', v_row.name, 'prefix', v_row.key_prefix));
end;
$$;
revoke all on function public.revoke_api_key(uuid) from public, anon;
grant execute on function public.revoke_api_key(uuid) to authenticated;

-- The org's keys, newest first, without their hashes.
create function public.list_api_keys()
returns table (
  id uuid,
  name text,
  key_prefix text,
  scopes text[],
  expires_at timestamptz,
  created_at timestamptz,
  created_by_name text,
  revoked_at timestamptz,
  last_used_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_me public.users := internal.require_audit_reader();
begin
  return query
  select k.id, k.name, k.key_prefix, k.scopes, k.expires_at, k.created_at, u.full_name,
    k.revoked_at, k.last_used_at
  from public.api_keys k
  left join public.users u on u.id = k.created_by
  where k.org_id = v_me.org_id
  order by k.created_at desc, k.id;
end;
$$;
revoke all on function public.list_api_keys() from public, anon;
grant execute on function public.list_api_keys() to authenticated;

-- Parameters -------------------------------------------------------------------------------

-- Every parameter error is 22023 'invalid_param', with "<param>: <what's wrong>" as the
-- detail (the API's error message) and the parameter as the hint.
create function internal.api_bad_param(p_name text, p_problem text)
returns void
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'invalid_param' using errcode = '22023',
    detail = p_name || ': ' || p_problem, hint = p_name;
end;
$$;

-- Refuses parameters the operation doesn't take, so a typo isn't silently ignored.
create function internal.api_allow(p jsonb, p_allowed text[])
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_key text;
begin
  if p is null or jsonb_typeof(p) <> 'object' then
    perform internal.api_bad_param('body', 'expected a JSON object');
  end if;
  select k into v_key from jsonb_object_keys(p) k where not k = any (p_allowed) order by k limit 1;
  if v_key is not null then
    perform internal.api_bad_param(v_key, 'unknown parameter');
  end if;
end;
$$;

create function internal.api_uuid(p jsonb, p_name text, p_required boolean default false)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  v text := p ->> p_name;
begin
  if v is null then
    if p_required then perform internal.api_bad_param(p_name, 'required'); end if;
    return null;
  end if;
  if v !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    perform internal.api_bad_param(p_name, 'expected an id (uuid)');
  end if;
  return v::uuid;
end;
$$;

create function internal.api_day(p jsonb, p_name text, p_required boolean default false)
returns date
language plpgsql
set search_path = ''
as $$
declare
  v text := p ->> p_name;
begin
  if v is null then
    if p_required then perform internal.api_bad_param(p_name, 'required'); end if;
    return null;
  end if;
  if v ~ '^\d{4}-\d{2}-\d{2}$' then
    begin
      if to_char(v::date, 'YYYY-MM-DD') = v then
        return v::date;
      end if;
    exception when others then
      null;
    end;
  end if;
  perform internal.api_bad_param(p_name, 'expected a date (YYYY-MM-DD)');
  return null;
end;
$$;

-- An ISO 8601 time with its zone (Z or an offset); a time without one is refused rather
-- than read in some zone the caller didn't mean.
create function internal.api_time(p jsonb, p_name text, p_required boolean default false)
returns timestamptz
language plpgsql
set search_path = ''
as $$
declare
  v text := p ->> p_name;
begin
  if v is null then
    if p_required then perform internal.api_bad_param(p_name, 'required'); end if;
    return null;
  end if;
  if v ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}(:?\d{2})?)$' then
    begin
      return v::timestamptz;
    exception when others then
      null;
    end;
  end if;
  perform internal.api_bad_param(p_name,
    'expected an ISO 8601 time with a zone, e.g. 2026-11-05T13:00:00Z');
  return null;
end;
$$;

create function internal.api_bool(p jsonb, p_name text)
returns boolean
language plpgsql
set search_path = ''
as $$
declare
  v text := p ->> p_name;
begin
  if v is null then return null; end if;
  if v not in ('true', 'false') then
    perform internal.api_bad_param(p_name, 'expected true or false');
  end if;
  return v::boolean;
end;
$$;

create function internal.api_enum(p jsonb, p_name text, p_allowed text[])
returns text
language plpgsql
set search_path = ''
as $$
declare
  v text := p ->> p_name;
begin
  if v is not null and not v = any (p_allowed) then
    perform internal.api_bad_param(p_name, 'expected one of ' || array_to_string(p_allowed, ', '));
  end if;
  return v;
end;
$$;

create function internal.api_text(p jsonb, p_name text, p_required boolean default false)
returns text
language plpgsql
set search_path = ''
as $$
declare
  v text := p ->> p_name;
begin
  if p ? p_name and jsonb_typeof(p -> p_name) not in ('string', 'null') then
    perform internal.api_bad_param(p_name, 'expected a string');
  end if;
  if v is null and p_required then
    perform internal.api_bad_param(p_name, 'required');
  end if;
  return v;
end;
$$;

-- A day range (`from`, `to`, both optional); `to` before `from` is refused.
create function internal.api_days(p jsonb, out from_day date, out to_day date)
language plpgsql
set search_path = ''
as $$
begin
  from_day := internal.api_day(p, 'from');
  to_day := internal.api_day(p, 'to');
  if from_day is not null and to_day is not null and to_day < from_day then
    perform internal.api_bad_param('to', 'must not be before from');
  end if;
end;
$$;

-- Paging: `limit` (1..500, default 100), `cursor` (from the previous page's next_cursor)
-- and `updated_since` (an ISO time with zone). The cursor is the last row's sort key,
-- (updated_at, id), hex-encoded: opaque to callers, checked here.
create function internal.api_paging(
  p jsonb,
  out lim int,
  out after_at timestamptz,
  out after_id uuid,
  out since timestamptz
)
language plpgsql
set search_path = ''
as $$
declare
  v_limit text := p ->> 'limit';
  v_cursor text := p ->> 'cursor';
  v_parts text[];
begin
  lim := 100;
  if v_limit is not null then
    if v_limit !~ '^\d{1,4}$' or v_limit::int not between 1 and 500 then
      perform internal.api_bad_param('limit', 'expected a whole number from 1 to 500');
    end if;
    lim := v_limit::int;
  end if;
  if v_cursor is not null then
    begin
      v_parts := string_to_array(convert_from(decode(v_cursor, 'hex'), 'UTF8'), '|');
      after_at := v_parts[1]::timestamptz;
      after_id := v_parts[2]::uuid;
    exception when others then
      after_at := null;
    end;
    if after_at is null or after_id is null or cardinality(v_parts) <> 2 then
      perform internal.api_bad_param('cursor', 'not a cursor from this API');
    end if;
  end if;
  since := internal.api_time(p, 'updated_since');
end;
$$;

-- One page from rows fetched with `limit + 1`: the first `limit`, and a cursor for the
-- next page when there was one more. Every row has `updated_at` and `id`.
create function internal.api_page(p_rows jsonb, p_limit int)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_rows jsonb := coalesce(p_rows, '[]'::jsonb);
  v_last jsonb;
begin
  if jsonb_array_length(v_rows) <= p_limit then
    return jsonb_build_object('data', v_rows, 'next_cursor', null);
  end if;
  select coalesce(jsonb_agg(e order by i), '[]'::jsonb) into v_rows
  from jsonb_array_elements(v_rows) with ordinality as a(e, i)
  where i <= p_limit;
  v_last := v_rows -> (p_limit - 1);
  return jsonb_build_object(
    'data', v_rows,
    'next_cursor', encode(convert_to((v_last ->> 'updated_at') || '|' || (v_last ->> 'id'), 'UTF8'), 'hex'));
end;
$$;

revoke all on function internal.api_bad_param(text, text) from public, anon, authenticated;
revoke all on function internal.api_allow(jsonb, text[]) from public, anon, authenticated;
revoke all on function internal.api_uuid(jsonb, text, boolean) from public, anon, authenticated;
revoke all on function internal.api_day(jsonb, text, boolean) from public, anon, authenticated;
revoke all on function internal.api_time(jsonb, text, boolean) from public, anon, authenticated;
revoke all on function internal.api_bool(jsonb, text) from public, anon, authenticated;
revoke all on function internal.api_enum(jsonb, text, text[]) from public, anon, authenticated;
revoke all on function internal.api_text(jsonb, text, boolean) from public, anon, authenticated;
revoke all on function internal.api_days(jsonb) from public, anon, authenticated;
revoke all on function internal.api_paging(jsonb) from public, anon, authenticated;
revoke all on function internal.api_page(jsonb, int) from public, anon, authenticated;

-- Resource shapes (the v1 contract; columns can change behind them) ----------------------------

create function internal.api_person(u public.users)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'id', u.id, 'full_name', u.full_name, 'email', u.email, 'role', u.role,
    'manager_id', u.manager_id, 'team_id', u.team_id, 'timezone', u.timezone,
    'work_country', u.work_country, 'work_state', u.work_state, 'active', u.active,
    'approval_required', u.approval_required, 'created_at', u.created_at,
    'updated_at', u.updated_at);
$$;

create function internal.api_team(t public.teams)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object('id', t.id, 'name', t.name, 'created_at', t.created_at,
    'updated_at', t.updated_at);
$$;

create function internal.api_client(c public.clients)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object('id', c.id, 'name', c.name, 'archived', c.archived,
    'created_at', c.created_at, 'updated_at', c.updated_at);
$$;

create function internal.api_project(p public.projects)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object('id', p.id, 'client_id', p.client_id, 'name', p.name,
    'billable', p.billable, 'archived', p.archived, 'created_at', p.created_at,
    'updated_at', p.updated_at);
$$;

create function internal.api_task(t public.project_tasks)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object('id', t.id, 'project_id', t.project_id, 'name', t.name,
    'billable', t.billable, 'archived', t.archived, 'sort_order', t.sort_order,
    'created_at', t.created_at, 'updated_at', t.updated_at);
$$;

-- Durations are exact seconds (TS-05): never rounded here.
create function internal.api_manual_entry(m public.manual_entries)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'id', m.id, 'user_id', m.user_id, 'start_at', m.start_at, 'end_at', m.end_at,
    'duration_s', extract(epoch from m.end_at - m.start_at)::float8, 'project_id', m.project_id,
    'task_id', m.task_id, 'reason', m.reason, 'note', m.note, 'status', m.status,
    'decided_by', m.decided_by, 'decided_at', m.decided_at, 'decision_note', m.decision_note,
    'created_at', m.created_at, 'updated_at', m.updated_at);
$$;

revoke all on function internal.api_person(public.users) from public, anon, authenticated;
revoke all on function internal.api_team(public.teams) from public, anon, authenticated;
revoke all on function internal.api_client(public.clients) from public, anon, authenticated;
revoke all on function internal.api_project(public.projects) from public, anon, authenticated;
revoke all on function internal.api_task(public.project_tasks) from public, anon, authenticated;
revoke all on function internal.api_manual_entry(public.manual_entries) from public, anon, authenticated;

-- Reads ------------------------------------------------------------------------------------
-- Each takes the request's parameters and returns { data, next_cursor } for the signed-in
-- person (auth.uid(); for an API key, its creator): the org in their token, the people
-- can_view_user() lets them see. All are ordered by (updated_at, id).

create function internal.api_list_people(p jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  a record;
  v_org uuid := internal.jwt_org_id();
  v_active boolean;
  v_team uuid;
  v_manager uuid;
  v_role text;
  v_rows jsonb;
begin
  perform internal.api_allow(p, array['limit', 'cursor', 'updated_since', 'active', 'team_id',
    'manager_id', 'role']);
  select * into a from internal.api_paging(p);
  v_active := internal.api_bool(p, 'active');
  v_team := internal.api_uuid(p, 'team_id');
  v_manager := internal.api_uuid(p, 'manager_id');
  v_role := internal.api_enum(p, 'role', array['owner', 'admin', 'manager', 'employee']);

  select jsonb_agg(x.o order by x.at, x.id) into v_rows
  from (
    select internal.api_person(u) as o, u.updated_at as at, u.id
    from public.users u
    where u.org_id = v_org
      and public.can_view_user(u.id)
      and (v_active is null or u.active = v_active)
      and (v_team is null or u.team_id = v_team)
      and (v_manager is null or u.manager_id = v_manager)
      and (v_role is null or u.role::text = v_role)
      and (a.since is null or u.updated_at >= a.since)
      and (a.after_at is null or (u.updated_at, u.id) > (a.after_at, a.after_id))
    order by u.updated_at, u.id
    limit a.lim + 1
  ) x;
  return internal.api_page(v_rows, a.lim);
end;
$$;

-- Teams, clients, projects and tasks are org settings: everyone in the org may read them.
create function internal.api_list_teams(p jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  a record;
  v_org uuid := internal.jwt_org_id();
  v_rows jsonb;
begin
  perform internal.api_allow(p, array['limit', 'cursor', 'updated_since']);
  select * into a from internal.api_paging(p);
  select jsonb_agg(x.o order by x.at, x.id) into v_rows
  from (
    select internal.api_team(t) as o, t.updated_at as at, t.id
    from public.teams t
    where t.org_id = v_org
      and (a.since is null or t.updated_at >= a.since)
      and (a.after_at is null or (t.updated_at, t.id) > (a.after_at, a.after_id))
    order by t.updated_at, t.id
    limit a.lim + 1
  ) x;
  return internal.api_page(v_rows, a.lim);
end;
$$;

create function internal.api_list_clients(p jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  a record;
  v_org uuid := internal.jwt_org_id();
  v_archived boolean;
  v_rows jsonb;
begin
  perform internal.api_allow(p, array['limit', 'cursor', 'updated_since', 'archived']);
  select * into a from internal.api_paging(p);
  v_archived := internal.api_bool(p, 'archived');
  select jsonb_agg(x.o order by x.at, x.id) into v_rows
  from (
    select internal.api_client(c) as o, c.updated_at as at, c.id
    from public.clients c
    where c.org_id = v_org
      and (v_archived is null or c.archived = v_archived)
      and (a.since is null or c.updated_at >= a.since)
      and (a.after_at is null or (c.updated_at, c.id) > (a.after_at, a.after_id))
    order by c.updated_at, c.id
    limit a.lim + 1
  ) x;
  return internal.api_page(v_rows, a.lim);
end;
$$;

create function internal.api_list_projects(p jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  a record;
  v_org uuid := internal.jwt_org_id();
  v_archived boolean;
  v_client uuid;
  v_rows jsonb;
begin
  perform internal.api_allow(p, array['limit', 'cursor', 'updated_since', 'archived', 'client_id']);
  select * into a from internal.api_paging(p);
  v_archived := internal.api_bool(p, 'archived');
  v_client := internal.api_uuid(p, 'client_id');
  select jsonb_agg(x.o order by x.at, x.id) into v_rows
  from (
    select internal.api_project(pr) as o, pr.updated_at as at, pr.id
    from public.projects pr
    where pr.org_id = v_org
      and (v_archived is null or pr.archived = v_archived)
      and (v_client is null or pr.client_id = v_client)
      and (a.since is null or pr.updated_at >= a.since)
      and (a.after_at is null or (pr.updated_at, pr.id) > (a.after_at, a.after_id))
    order by pr.updated_at, pr.id
    limit a.lim + 1
  ) x;
  return internal.api_page(v_rows, a.lim);
end;
$$;

create function internal.api_list_tasks(p jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  a record;
  v_org uuid := internal.jwt_org_id();
  v_archived boolean;
  v_project uuid;
  v_rows jsonb;
begin
  perform internal.api_allow(p, array['limit', 'cursor', 'updated_since', 'archived', 'project_id']);
  select * into a from internal.api_paging(p);
  v_archived := internal.api_bool(p, 'archived');
  v_project := internal.api_uuid(p, 'project_id');
  select jsonb_agg(x.o order by x.at, x.id) into v_rows
  from (
    select internal.api_task(t) as o, t.updated_at as at, t.id
    from public.project_tasks t
    where t.org_id = v_org
      and (v_archived is null or t.archived = v_archived)
      and (v_project is null or t.project_id = v_project)
      and (a.since is null or t.updated_at >= a.since)
      and (a.after_at is null or (t.updated_at, t.id) > (a.after_at, a.after_id))
    order by t.updated_at, t.id
    limit a.lim + 1
  ) x;
  return internal.api_page(v_rows, a.lim);
end;
$$;

-- A person's shifts are replaced as a whole when they change (set_shifts), so a shift is
-- never updated: its updated_at is when it was made.
create function internal.api_list_shifts(p jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  a record;
  v_org uuid := internal.jwt_org_id();
  v_user uuid;
  v_rows jsonb;
begin
  perform internal.api_allow(p, array['limit', 'cursor', 'updated_since', 'user_id']);
  select * into a from internal.api_paging(p);
  v_user := internal.api_uuid(p, 'user_id');
  select jsonb_agg(x.o order by x.at, x.id) into v_rows
  from (
    select jsonb_build_object('id', s.id, 'user_id', s.user_id, 'days', to_jsonb(s.days),
        'start_time', to_char(s.start_time, 'HH24:MI'), 'end_time', to_char(s.end_time, 'HH24:MI'),
        'timezone', s.timezone, 'created_at', s.created_at, 'updated_at', s.created_at) as o,
      s.created_at as at, s.id
    from public.shifts s
    where s.org_id = v_org
      and public.can_view_user(s.user_id)
      and (v_user is null or s.user_id = v_user)
      and (a.since is null or s.created_at >= a.since)
      and (a.after_at is null or (s.created_at, s.id) > (a.after_at, a.after_id))
    order by s.created_at, s.id
    limit a.lim + 1
  ) x;
  return internal.api_page(v_rows, a.lim);
end;
$$;

-- Weekly timesheets with status, approver and the week's totals in seconds (worked: counted
-- and not excluded; flagged: needs review, not excluded; manual: approved manual entries).
-- `from` / `to` pick weeks by their first day.
create function internal.api_list_timesheets(p jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  a record;
  d record;
  v_org uuid := internal.jwt_org_id();
  v_user uuid;
  v_status text;
  v_rows jsonb;
begin
  perform internal.api_allow(p, array['limit', 'cursor', 'updated_since', 'user_id', 'status',
    'from', 'to']);
  select * into a from internal.api_paging(p);
  select * into d from internal.api_days(p);
  v_user := internal.api_uuid(p, 'user_id');
  v_status := internal.api_enum(p, 'status', array['draft', 'submitted', 'approved', 'returned']);
  select jsonb_agg(x.o order by x.at, x.id) into v_rows
  from (
    select jsonb_build_object(
        'id', t.id, 'user_id', t.user_id, 'period_start', t.period_start,
        'period_end', t.period_start + 6, 'status', t.status, 'submitted_at', t.submitted_at,
        'approved_at', t.approved_at, 'approver_id', t.approver_id,
        'returned_at', t.returned_at, 'return_comment', t.comment,
        'worked_s', tot.worked_s, 'flagged_s', tot.flagged_s, 'excluded_s', tot.excluded_s,
        'manual_s', tot.manual_s, 'created_at', t.created_at, 'updated_at', t.updated_at) as o,
      t.updated_at as at, t.id
    from public.timesheets t
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
      where s.user_id = t.user_id and s.day between t.period_start and t.period_start + 6
    ) tot
    where t.org_id = v_org
      and public.can_view_user(t.user_id)
      and (v_user is null or t.user_id = v_user)
      and (v_status is null or t.status = v_status)
      and (d.from_day is null or t.period_start >= d.from_day)
      and (d.to_day is null or t.period_start <= d.to_day)
      and (a.since is null or t.updated_at >= a.since)
      and (a.after_at is null or (t.updated_at, t.id) > (a.after_at, a.after_id))
    order by t.updated_at, t.id
    limit a.lim + 1
  ) x;
  return internal.api_page(v_rows, a.lim);
end;
$$;

-- Per-day timesheet segments (TS-01..06). A day's automatic segments are rebuilt as new
-- rows when its facts change, so a sync replaces each (user_id, day) it receives.
create function internal.api_list_segments(p jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  a record;
  d record;
  v_org uuid := internal.jwt_org_id();
  v_user uuid;
  v_rows jsonb;
begin
  perform internal.api_allow(p, array['limit', 'cursor', 'updated_since', 'user_id', 'from', 'to']);
  select * into a from internal.api_paging(p);
  select * into d from internal.api_days(p);
  v_user := internal.api_uuid(p, 'user_id');
  select jsonb_agg(x.o order by x.at, x.id) into v_rows
  from (
    select jsonb_build_object(
        'id', s.id, 'user_id', s.user_id, 'day', s.day, 'start_at', s.start_at,
        'end_at', s.end_at, 'duration_s', extract(epoch from s.end_at - s.start_at)::float8,
        'type', s.type, 'project_id', s.project_id, 'task_id', s.task_id,
        'counted', s.counted, 'flagged', s.flagged, 'excluded', s.excluded,
        'excluded_reason', s.excluded_reason, 'source', s.source,
        'updated_at', s.updated_at) as o,
      s.updated_at as at, s.id
    from public.time_segments s
    where s.org_id = v_org
      and public.can_view_user(s.user_id)
      and (v_user is null or s.user_id = v_user)
      and (d.from_day is null or s.day >= d.from_day)
      and (d.to_day is null or s.day <= d.to_day)
      and (a.since is null or s.updated_at >= a.since)
      and (a.after_at is null or (s.updated_at, s.id) > (a.after_at, a.after_id))
    order by s.updated_at, s.id
    limit a.lim + 1
  ) x;
  return internal.api_page(v_rows, a.lim);
end;
$$;

-- `from` / `to` are days in each person's own time zone, on the entry's start.
create function internal.api_list_manual_entries(p jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  a record;
  d record;
  v_org uuid := internal.jwt_org_id();
  v_user uuid;
  v_status text;
  v_rows jsonb;
begin
  perform internal.api_allow(p, array['limit', 'cursor', 'updated_since', 'user_id', 'status',
    'from', 'to']);
  select * into a from internal.api_paging(p);
  select * into d from internal.api_days(p);
  v_user := internal.api_uuid(p, 'user_id');
  v_status := internal.api_enum(p, 'status', array['pending', 'approved', 'rejected']);
  select jsonb_agg(x.o order by x.at, x.id) into v_rows
  from (
    select internal.api_manual_entry(m) as o, m.updated_at as at, m.id
    from public.manual_entries m
    join public.users u on u.id = m.user_id
    where m.org_id = v_org
      and public.can_view_user(m.user_id)
      and (v_user is null or m.user_id = v_user)
      and (v_status is null or m.status = v_status)
      and (d.from_day is null or m.start_at >= d.from_day::timestamp at time zone u.timezone)
      and (d.to_day is null or m.start_at < (d.to_day + 1)::timestamp at time zone u.timezone)
      and (a.since is null or m.updated_at >= a.since)
      and (a.after_at is null or (m.updated_at, m.id) > (a.after_at, a.after_id))
    order by m.updated_at, m.id
    limit a.lim + 1
  ) x;
  return internal.api_page(v_rows, a.lim);
end;
$$;

-- Check-ins as metadata only (API-03, API-04): the outcome, when it was shown and answered,
-- and the response time. Never the scheduled time, captures, apps, flags or the person's
-- own words. `from` / `to` are days in each person's own time zone, on when it was shown.
create function internal.api_list_checkins(p jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  a record;
  d record;
  v_org uuid := internal.jwt_org_id();
  v_user uuid;
  v_outcome text;
  v_rows jsonb;
begin
  perform internal.api_allow(p, array['limit', 'cursor', 'updated_since', 'user_id', 'outcome',
    'from', 'to']);
  select * into a from internal.api_paging(p);
  select * into d from internal.api_days(p);
  v_user := internal.api_uuid(p, 'user_id');
  v_outcome := internal.api_enum(p, 'outcome', array['pass', 'miss', 'failed', 'deferred']);
  select jsonb_agg(x.o order by x.at, x.id) into v_rows
  from (
    select jsonb_build_object(
        'id', c.id, 'user_id', c.user_id, 'project_id', c.project_id,
        'outcome', c.outcome, 'shown_at', c.shown_at, 'responded_at', c.responded_at,
        'response_ms', c.response_ms, 'created_at', c.created_at,
        'updated_at', c.updated_at) as o,
      c.updated_at as at, c.id
    from public.checkin_events c
    join public.users u on u.id = c.user_id
    where c.org_id = v_org
      and public.can_view_user(c.user_id)
      and (v_user is null or c.user_id = v_user)
      and (v_outcome is null or c.outcome::text = v_outcome)
      and (d.from_day is null
           or coalesce(c.shown_at, c.created_at) >= d.from_day::timestamp at time zone u.timezone)
      and (d.to_day is null
           or coalesce(c.shown_at, c.created_at) < (d.to_day + 1)::timestamp at time zone u.timezone)
      and (a.since is null or c.updated_at >= a.since)
      and (a.after_at is null or (c.updated_at, c.id) > (a.after_at, a.after_id))
    order by c.updated_at, c.id
    limit a.lim + 1
  ) x;
  return internal.api_page(v_rows, a.lim);
end;
$$;

-- Manager alerts (ALR-01): one row per recipient, as they were sent. Alerts never change,
-- so updated_at is when it was raised. Whether a recipient read it is theirs, not shown.
create function internal.api_list_alerts(p jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  a record;
  d record;
  v_org uuid := internal.jwt_org_id();
  v_user uuid;
  v_kind text;
  v_rows jsonb;
begin
  perform internal.api_allow(p, array['limit', 'cursor', 'updated_since', 'user_id', 'kind',
    'from', 'to']);
  select * into a from internal.api_paging(p);
  select * into d from internal.api_days(p);
  v_user := internal.api_uuid(p, 'user_id');
  v_kind := internal.api_enum(p, 'kind', (select array_agg(k::text) from unnest(enum_range(null::public.alert_kind)) k));
  select jsonb_agg(x.o order by x.at, x.id) into v_rows
  from (
    select jsonb_build_object(
        'id', al.id, 'user_id', al.user_id, 'recipient_id', al.recipient_id, 'kind', al.kind,
        'details', al.details, 'triggered_at', al.triggered_at,
        'updated_at', al.triggered_at) as o,
      al.triggered_at as at, al.id
    from public.alerts al
    join public.users u on u.id = al.user_id
    where al.org_id = v_org
      and public.can_view_user(al.user_id)
      and (v_user is null or al.user_id = v_user)
      and (v_kind is null or al.kind::text = v_kind)
      and (d.from_day is null or al.triggered_at >= d.from_day::timestamp at time zone u.timezone)
      and (d.to_day is null or al.triggered_at < (d.to_day + 1)::timestamp at time zone u.timezone)
      and (a.since is null or al.triggered_at >= a.since)
      and (a.after_at is null or (al.triggered_at, al.id) > (a.after_at, a.after_id))
    order by al.triggered_at, al.id
    limit a.lim + 1
  ) x;
  return internal.api_page(v_rows, a.lim);
end;
$$;

-- Reports (DSH-07) --------------------------------------------------------------------------

-- The people a report covers: everyone the caller sees, narrowed by team / manager / one
-- person. Passed to the report RPCs by id, so the caller themselves is included too (the
-- dashboard leaves the viewer out of their own team report).
create function internal.api_report_people(p jsonb)
returns uuid[]
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org uuid := internal.jwt_org_id();
  v_team uuid := internal.api_uuid(p, 'team_id');
  v_manager uuid := internal.api_uuid(p, 'manager_id');
  v_user uuid := internal.api_uuid(p, 'user_id');
begin
  return coalesce((
    select array_agg(u.id order by u.id)
    from public.users u
    where u.org_id = v_org
      and public.can_view_user(u.id)
      and (v_team is null or u.team_id = v_team)
      and (v_manager is null or u.manager_id = v_manager)
      and (v_user is null or u.id = v_user)
  ), '{}');
end;
$$;

-- Per person for a date range: worked, flagged, excluded, break, pause and manual seconds,
-- check-ins shown / passed / missed / failed, response rate, median response time, late
-- clock-ins and anomaly flags (public.report_rows, the Reports page's numbers).
create function internal.api_report_people_totals(p jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  d record;
  v_ids uuid[];
  v_report jsonb;
begin
  perform internal.api_allow(p, array['from', 'to', 'team_id', 'manager_id', 'user_id']);
  select * into d from internal.api_days(p);
  if d.from_day is null then perform internal.api_bad_param('from', 'required'); end if;
  if d.to_day is null then perform internal.api_bad_param('to', 'required'); end if;
  if d.to_day - d.from_day > 365 then
    perform internal.api_bad_param('to', 'a report covers at most 366 days');
  end if;
  v_ids := internal.api_report_people(p);
  if cardinality(v_ids) = 0 then
    return jsonb_build_object('data', '[]'::jsonb, 'from', d.from_day, 'to', d.to_day);
  end if;
  v_report := public.report_rows(d.from_day, d.to_day, v_ids, null, null);
  return jsonb_build_object(
    'data', coalesce((
      select jsonb_agg(r - 'needs_review'
        || jsonb_build_object('anomaly_flags_needing_review', r -> 'needs_review'))
      from jsonb_array_elements(v_report -> 'rows') r), '[]'::jsonb),
    'from', d.from_day, 'to', d.to_day,
    'late_grace_min', v_report -> 'late_grace_min',
    'median_response_ms', v_report -> 'team_median_response_ms');
end;
$$;

-- Hours per person, project and task for a date range (DSH-07, DSH-10).
create function internal.api_report_task_totals(p jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  d record;
  v_ids uuid[];
begin
  perform internal.api_allow(p, array['from', 'to', 'team_id', 'manager_id', 'user_id']);
  select * into d from internal.api_days(p);
  if d.from_day is null then perform internal.api_bad_param('from', 'required'); end if;
  if d.to_day is null then perform internal.api_bad_param('to', 'required'); end if;
  if d.to_day - d.from_day > 365 then
    perform internal.api_bad_param('to', 'a report covers at most 366 days');
  end if;
  v_ids := internal.api_report_people(p);
  if cardinality(v_ids) = 0 then
    return jsonb_build_object('data', '[]'::jsonb, 'from', d.from_day, 'to', d.to_day);
  end if;
  return jsonb_build_object(
    'data', coalesce((
      select jsonb_agg(jsonb_build_object('user_id', r.user_id, 'project_id', r.project_id,
        'task_id', r.task_id, 'worked_s', r.worked_s, 'flagged_s', r.flagged_s))
      from public.report_task_rows(d.from_day, d.to_day, v_ids, null, null) r), '[]'::jsonb),
    'from', d.from_day, 'to', d.to_day);
end;
$$;

-- Writes ----------------------------------------------------------------------------------
-- Through the dashboard's own RPCs, as the signed-in person. Each returns { data: object }.

create function internal.api_create_client(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  perform internal.api_allow(p, array['name']);
  v_id := public.save_client(null, internal.api_text(p, 'name', true), false);
  return jsonb_build_object('data', (select internal.api_client(c) from public.clients c where c.id = v_id));
end;
$$;

create function internal.api_archive_client(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.clients;
begin
  perform internal.api_allow(p, array['id']);
  select * into v_row from public.clients c
  where c.id = internal.api_uuid(p, 'id', true) and c.org_id = internal.jwt_org_id();
  if not found then
    raise exception 'client_not_found' using errcode = '42501';
  end if;
  if not v_row.archived then
    perform public.save_client(v_row.id, v_row.name, true);
  end if;
  return jsonb_build_object('data', (select internal.api_client(c) from public.clients c where c.id = v_row.id));
end;
$$;

create function internal.api_create_project(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_billable boolean;
begin
  perform internal.api_allow(p, array['name', 'client_id', 'billable']);
  v_billable := internal.api_bool(p, 'billable');
  v_id := public.save_project(null, internal.api_text(p, 'name', true),
    internal.api_uuid(p, 'client_id'), coalesce(v_billable, true), false);
  return jsonb_build_object('data', (select internal.api_project(pr) from public.projects pr where pr.id = v_id));
end;
$$;

create function internal.api_archive_project(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.projects;
begin
  perform internal.api_allow(p, array['id']);
  select * into v_row from public.projects pr
  where pr.id = internal.api_uuid(p, 'id', true) and pr.org_id = internal.jwt_org_id();
  if not found then
    raise exception 'project_not_found' using errcode = '42501';
  end if;
  if not v_row.archived then
    perform public.save_project(v_row.id, v_row.name, v_row.client_id, v_row.billable, true);
  end if;
  return jsonb_build_object('data', (select internal.api_project(pr) from public.projects pr where pr.id = v_row.id));
end;
$$;

create function internal.api_create_task(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  perform internal.api_allow(p, array['project_id', 'name', 'billable']);
  v_id := public.save_task(null, internal.api_uuid(p, 'project_id', true),
    internal.api_text(p, 'name', true), internal.api_bool(p, 'billable'), false);
  return jsonb_build_object('data', (select internal.api_task(t) from public.project_tasks t where t.id = v_id));
end;
$$;

create function internal.api_archive_task(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.project_tasks;
begin
  perform internal.api_allow(p, array['id']);
  select * into v_row from public.project_tasks t
  where t.id = internal.api_uuid(p, 'id', true) and t.org_id = internal.jwt_org_id();
  if not found then
    raise exception 'task_not_found' using errcode = '42501';
  end if;
  if not v_row.archived then
    perform public.save_task(v_row.id, v_row.project_id, v_row.name, v_row.billable, true);
  end if;
  return jsonb_build_object('data', (select internal.api_task(t) from public.project_tasks t where t.id = v_row.id));
end;
$$;

-- A manual entry for a person, under exactly the rules of their own request (TS-07..09,
-- TS-24: pending for their manager unless they need no approval, at most 24 hours, not in
-- the future, a project they can log to, no overlap, nothing in an approved week), with
-- the signed-in person as the actor in the audit events. Like an import (#282): only for
-- active people the caller can see.
create function internal.api_create_manual_entry(p jsonb, p_audit jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me public.users := internal.current_app_user();
  v_user public.users;
  v_id uuid;
begin
  perform internal.api_allow(p, array['user_id', 'start_at', 'end_at', 'project_id', 'task_id',
    'reason', 'note']);
  select * into v_user from public.users u where u.id = internal.api_uuid(p, 'user_id', true);
  if not found or v_user.org_id <> v_me.org_id or not public.can_view_user(v_user.id) then
    raise exception 'user_not_found' using errcode = '42501';
  end if;
  if not v_user.active then
    raise exception 'user_inactive' using errcode = '22023';
  end if;
  v_id := internal.create_manual_entry(v_user, v_me, internal.api_time(p, 'start_at', true),
    internal.api_time(p, 'end_at', true), internal.api_uuid(p, 'project_id'),
    internal.api_text(p, 'reason', true), internal.api_uuid(p, 'task_id'),
    internal.api_text(p, 'note'), coalesce(p_audit, '{}'::jsonb));
  return jsonb_build_object('data',
    (select internal.api_manual_entry(m) from public.manual_entries m where m.id = v_id));
end;
$$;

-- Dispatch -----------------------------------------------------------------------------------

-- The scope each operation needs; null for an unknown operation.
create function internal.api_operation_scope(p_operation text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case p_operation
    when 'people.list' then 'people:read'
    when 'teams.list' then 'teams:read'
    when 'clients.list' then 'projects:read'
    when 'projects.list' then 'projects:read'
    when 'tasks.list' then 'projects:read'
    when 'clients.create' then 'projects:write'
    when 'clients.archive' then 'projects:write'
    when 'projects.create' then 'projects:write'
    when 'projects.archive' then 'projects:write'
    when 'tasks.create' then 'projects:write'
    when 'tasks.archive' then 'projects:write'
    when 'shifts.list' then 'shifts:read'
    when 'timesheets.list' then 'timesheets:read'
    when 'segments.list' then 'time:read'
    when 'manual_entries.list' then 'time:read'
    when 'manual_entries.create' then 'time:write'
    when 'checkins.list' then 'checkins:read'
    when 'alerts.list' then 'alerts:read'
    when 'reports.people' then 'reports:read'
    when 'reports.tasks' then 'reports:read'
  end;
$$;

-- Runs one operation for the signed-in person (see the header). `p_audit` goes into the
-- audit events of writes that make their own (manual entries).
create function internal.api_dispatch(p_operation text, p_params jsonb, p_audit jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  p jsonb := coalesce(p_params, '{}'::jsonb);
begin
  return case p_operation
    when 'people.list' then internal.api_list_people(p)
    when 'teams.list' then internal.api_list_teams(p)
    when 'clients.list' then internal.api_list_clients(p)
    when 'projects.list' then internal.api_list_projects(p)
    when 'tasks.list' then internal.api_list_tasks(p)
    when 'clients.create' then internal.api_create_client(p)
    when 'clients.archive' then internal.api_archive_client(p)
    when 'projects.create' then internal.api_create_project(p)
    when 'projects.archive' then internal.api_archive_project(p)
    when 'tasks.create' then internal.api_create_task(p)
    when 'tasks.archive' then internal.api_archive_task(p)
    when 'shifts.list' then internal.api_list_shifts(p)
    when 'timesheets.list' then internal.api_list_timesheets(p)
    when 'segments.list' then internal.api_list_segments(p)
    when 'manual_entries.list' then internal.api_list_manual_entries(p)
    when 'manual_entries.create' then internal.api_create_manual_entry(p, p_audit)
    when 'checkins.list' then internal.api_list_checkins(p)
    when 'alerts.list' then internal.api_list_alerts(p)
    when 'reports.people' then internal.api_report_people_totals(p)
    when 'reports.tasks' then internal.api_report_task_totals(p)
  end;
end;
$$;

do $$
declare
  f text;
begin
  foreach f in array array[
    'internal.api_list_people(jsonb)', 'internal.api_list_teams(jsonb)',
    'internal.api_list_clients(jsonb)', 'internal.api_list_projects(jsonb)',
    'internal.api_list_tasks(jsonb)', 'internal.api_list_shifts(jsonb)',
    'internal.api_list_timesheets(jsonb)', 'internal.api_list_segments(jsonb)',
    'internal.api_list_manual_entries(jsonb)', 'internal.api_list_checkins(jsonb)',
    'internal.api_list_alerts(jsonb)', 'internal.api_report_people(jsonb)',
    'internal.api_report_people_totals(jsonb)', 'internal.api_report_task_totals(jsonb)',
    'internal.api_create_client(jsonb)', 'internal.api_archive_client(jsonb)',
    'internal.api_create_project(jsonb)', 'internal.api_archive_project(jsonb)',
    'internal.api_create_task(jsonb)', 'internal.api_archive_task(jsonb)',
    'internal.api_create_manual_entry(jsonb, jsonb)', 'internal.api_operation_scope(text)',
    'internal.api_dispatch(text, jsonb, jsonb)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
  end loop;
end;
$$;

-- Requests (service role only: the api-v1 Edge Function) --------------------------------------

-- Makes this transaction run as `p_user`, with the claims their dashboard token carries
-- (sub, role, org_id, aal2: the key was made under the org's MFA rule). Transaction-local.
create function internal.api_act_as(p_user public.users)
returns void
language plpgsql
set search_path = ''
as $$
begin
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claim', '', true);
  perform set_config('request.jwt.claims', jsonb_build_object(
    'sub', p_user.id, 'role', 'authenticated', 'org_id', p_user.org_id, 'aal', 'aal2',
    'api_key', true)::text, true);
end;
$$;
revoke all on function internal.api_act_as(public.users) from public, anon, authenticated;

-- Why a key can't be used now, or null when it can. The creator must still be an active
-- owner or admin of the key's org.
create function internal.api_key_problem(p_key public.api_keys)
returns text
language sql
stable
set search_path = ''
as $$
  select case
    when p_key.id is null then 'invalid_key'
    when p_key.revoked_at is not null then 'key_revoked'
    when p_key.expires_at is not null and p_key.expires_at <= now() then 'key_expired'
    when not exists (
      select 1 from public.users u
      where u.id = p_key.created_by and u.org_id = p_key.org_id and u.active
        and u.role in ('owner', 'admin')
    ) then 'key_creator_inactive'
  end;
$$;
revoke all on function internal.api_key_problem(public.api_keys) from public, anon, authenticated;

create function internal.api_error(p_status int, p_code text, p_message text, p_param text default null)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object('status', p_status, 'body', jsonb_build_object('error',
    jsonb_strip_nulls(jsonb_build_object('code', p_code, 'message', p_message, 'param', p_param))));
$$;
revoke all on function internal.api_error(int, text, text, text) from public, anon, authenticated;

-- Step 1: the key (by its SHA-256, hex; the key itself never reaches the database) and its
-- rate limit. Returns { status: 200, key_id, rate } or an error { status, body, rate? }.
-- `rate` is { limit, remaining, reset } with reset in epoch seconds.
create function public.api_v1_authenticate(p_key_hash text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_key public.api_keys;
  v_problem text;
  v_window timestamptz := date_trunc('minute', now());
  v_count int;
  v_rate jsonb;
begin
  if p_key_hash is null or p_key_hash !~ '^[0-9a-f]{64}$' then
    return internal.api_error(401, 'invalid_key', 'The API key is not valid.');
  end if;
  select * into v_key from public.api_keys k where k.key_hash = decode(p_key_hash, 'hex') for update;
  v_problem := internal.api_key_problem(v_key);
  if v_problem is not null then
    return internal.api_error(401, v_problem, case v_problem
      when 'invalid_key' then 'The API key is not valid.'
      when 'key_revoked' then 'This API key was revoked. Ask an admin for a new one.'
      when 'key_expired' then 'This API key has expired. Ask an admin for a new one.'
      else 'The person who created this API key is no longer an active owner or admin. Ask an admin for a new key.'
    end);
  end if;

  v_count := case when v_key.rate_window = v_window then v_key.rate_count + 1 else 1 end;
  update public.api_keys
  set rate_window = v_window, rate_count = v_count, last_used_at = now()
  where id = v_key.id;
  v_rate := jsonb_build_object('limit', internal.api_rate_limit(),
    'remaining', greatest(internal.api_rate_limit() - v_count, 0),
    'reset', extract(epoch from v_window + interval '1 minute')::bigint);
  if v_count > internal.api_rate_limit() then
    return internal.api_error(429, 'rate_limited', format(
      'Too many requests: this key may make %s a minute. Try again in %s seconds.',
      internal.api_rate_limit(), ceil(extract(epoch from v_window + interval '1 minute' - now()))::int))
      || jsonb_build_object('rate', v_rate,
        'retry_after', ceil(extract(epoch from v_window + interval '1 minute' - now()))::int);
  end if;
  return jsonb_build_object('status', 200, 'key_id', v_key.id, 'rate', v_rate);
end;
$$;
revoke all on function public.api_v1_authenticate(text) from public, anon, authenticated;
grant execute on function public.api_v1_authenticate(text) to service_role;

-- Step 2: one operation with a key that passed step 1. Returns { status, body }.
create function public.api_v1_call(p_key_id uuid, p_operation text, p_params jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_key public.api_keys;
  v_creator public.users;
  v_problem text;
  v_scope text := internal.api_operation_scope(p_operation);
  v_write boolean := p_operation ~ '\.(create|archive)$';
  v_params jsonb := coalesce(p_params, '{}'::jsonb);
  v_meta jsonb;
  v_result jsonb;
  v_target uuid;
  v_state text;
  v_message text;
  v_detail text;
  v_hint text;
begin
  select * into v_key from public.api_keys k where k.id = p_key_id;
  v_problem := internal.api_key_problem(v_key);
  if v_problem is not null then
    return internal.api_error(401, v_problem, 'The API key can no longer be used.');
  end if;
  if v_scope is null then
    return internal.api_error(404, 'not_found', 'There is no such API operation.');
  end if;
  if not v_scope = any (v_key.scopes) then
    return internal.api_error(403, 'insufficient_scope',
      format('This API key does not have the %s scope.', v_scope));
  end if;
  if jsonb_typeof(v_params) <> 'object' then
    return internal.api_error(400, 'invalid_param', 'body: expected a JSON object', 'body');
  end if;

  select * into v_creator from public.users u where u.id = v_key.created_by;
  v_meta := jsonb_build_object('key_id', v_key.id, 'key_name', v_key.name,
    'prefix', v_key.key_prefix, 'operation', p_operation);

  begin
    perform internal.api_act_as(v_creator);
    v_result := internal.api_dispatch(p_operation, v_params, v_meta);
    if v_write then
      v_target := case when p_operation = 'manual_entries.create'
        then (v_result -> 'data' ->> 'user_id')::uuid end;
      perform internal.audit(v_key.org_id, v_creator.id, 'api.write', v_target,
        v_meta || jsonb_build_object('id', v_result -> 'data' -> 'id',
          -- What was asked for, without the free text (a reason or note stays on the entry).
          'params', v_params - 'reason' - 'note'));
    else
      v_target := case when v_params ->> 'user_id' ~* '^[0-9a-f-]{36}$'
        then (v_params ->> 'user_id')::uuid end;
      perform internal.audit(v_key.org_id, v_creator.id, 'api.read', v_target,
        v_meta || jsonb_build_object('filters', v_params - 'cursor',
          'row_count', jsonb_array_length(coalesce(v_result -> 'data', '[]'::jsonb))));
    end if;
    return jsonb_build_object('status', case when p_operation ~ '\.create$' then 201 else 200 end,
      'body', v_result);
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_message = message_text,
      v_detail = pg_exception_detail, v_hint = pg_exception_hint;
    if v_state in ('22023', '22P02', '22007', '22008', '54000') then
      return internal.api_error(400, coalesce(nullif(v_message, ''), 'invalid_request'),
        coalesce(nullif(v_detail, ''), 'The request was refused: ' || v_message),
        case when v_message = 'invalid_param' then nullif(v_hint, '') end);
    elsif v_state = '42501' and v_message like '%not_found' then
      return internal.api_error(404, v_message, 'Not found in this organization.');
    elsif v_state = '42501' then
      return internal.api_error(403, v_message, 'The key''s creator is not allowed to do this.');
    elsif v_state in ('23505', '23P01', '55000') then
      return internal.api_error(409, v_message, case v_state
        when '23505' then 'That name is already taken.'
        when '23P01' then 'The time overlaps time already recorded for this person.'
        else 'The week is locked or the record changed; it can''t be changed now.'
      end);
    end if;
    raise warning 'api_v1_call % failed: % %', p_operation, v_state, v_message;
    return internal.api_error(500, 'internal_error', 'Something went wrong. Try again later.');
  end;
end;
$$;
revoke all on function public.api_v1_call(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.api_v1_call(uuid, text, jsonb) to service_role;
