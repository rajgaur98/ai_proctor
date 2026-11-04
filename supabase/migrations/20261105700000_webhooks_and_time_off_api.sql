-- #320 (API-03, API-06, AUD-01): webhooks, and time off in the public API.
--
-- Time off in the API (API-03) ------------------------------------------------------------
-- GET /v1/time-off (time-off requests: type, paid, kind, days and times, status, approver,
-- when decided; never the employee's note or the decision note) and GET /v1/holidays (the
-- org's calendar), under a new `timeoff:read` scope. Both are paged and synced like the
-- other lists, so leave_requests and holidays get an updated_at (internal.touch_updated_at).
-- A deleted holiday or a deleted person's requests simply disappear, like other deletions.
--
-- Webhooks (API-06) ------------------------------------------------------------------------
-- Owners and admins add endpoints (Settings → API): an https URL and the events it wants.
-- Each endpoint has a signing secret, shown once when it is made or rotated. It is kept in
-- Vault (named webhook_secret:<id>) so the deliver function can sign with it; no RPC returns
-- it again. At most 10 endpoints per org, one per URL.
--
-- Events, emitted by triggers on the tables, so every code path that changes them counts
-- (the dashboard's RPCs, imports, the API, the data-request flow):
--   timesheet.submitted / .approved / .returned  timesheets.status becomes it (an
--                                                auto-approved week is only .approved; a
--                                                reopened week is .submitted again, with
--                                                previous_status 'approved')
--   alert.raised        a manager alert (one event per alert, not per recipient)
--   person.invited      a users row is added (invite, import)
--   person.deactivated  users.active goes from true to false
--   time_off.decided    a request is approved or declined (or approved when asked, for
--                       someone with no manager)
-- Each event has a stable id (the same in every retry and for every endpoint; for an alert,
-- derived from the person, kind and episode) and its data in the API v1 shape of the
-- resource (Person, Timesheet, TimeOff), so a receiver can dedupe and reuse its API code.
--
-- Delivery: an event becomes one webhook_deliveries row per endpoint that wants it. The
-- webhooks_kick cron job (every minute, while something is due) calls the deliver-webhooks
-- Edge Function through pg_net; it claims due rows (webhook_claim: counts the attempt and
-- sets the next one), POSTs each, signed with HMAC-SHA256 over "<timestamp>.<body>", and
-- records the result (webhook_record). A failed attempt is retried after 1, 4, 16, 64, 256
-- and 1024 minutes (7 attempts over about 23 hours); then the delivery has failed. When 5
-- deliveries in a row have failed, the endpoint is turned off and every active owner and
-- admin is notified (webhook.disabled). An admin turns it back on.
--
-- URLs: https only, no user:password, and in production no private, loopback or link-local
-- host (localhost, .local, .internal, single-label names, private IP literals); the deliver
-- function also refuses a host that resolves to such an address. A local stack sets the
-- Vault secret webhooks_allow_private_hosts to 'true' (scripts/stack-secrets.sh), which
-- allows http and any host, so the integration test's receiver inside the stack works.
--
-- Audit (AUD-01): webhook.created, webhook.changed, webhook.deleted, webhook.secret_rotated,
-- and webhook.disabled when the system turns an endpoint off. The audit rows name the URL's
-- host, not the whole URL (a path or query can carry a token).
--
-- Retention and deletion: deliveries are kept 30 days (webhooks_purge, daily), whatever their
-- state. Deleting a person (internal.delete_user_data deletes the users row) removes their
-- delivered and failed deliveries and strips the queued ones down to ids
-- ({ id, user_id } and "redacted": true), so the receiver still learns that something
-- happened to that id but gets none of their data. Webhook deliveries are the org's
-- integration log, not the person's own data: they are not in the person's data export.
--
-- Redefined here, each copied from its latest definition with only the time-off additions:
--   internal.api_scopes          (20261105200000_public_api): + timeoff:read
--   internal.api_operation_scope (20261105200000_public_api): + time_off.list, holidays.list
--   internal.api_dispatch        (20261105200000_public_api): + time_off.list, holidays.list

-- Time off in the API ------------------------------------------------------------------------

-- `if not exists`: time off part 2 (#319) may add the same column.
alter table public.leave_requests add column if not exists updated_at timestamptz not null default now();
alter table public.holidays add column if not exists updated_at timestamptz not null default now();
create or replace trigger leave_requests_touch_updated_at before update on public.leave_requests
  for each row execute function internal.touch_updated_at();
create or replace trigger holidays_touch_updated_at before update on public.holidays
  for each row execute function internal.touch_updated_at();
create index if not exists leave_requests_org_updated_idx on public.leave_requests (org_id, updated_at, id);
create index if not exists holidays_org_updated_idx on public.holidays (org_id, updated_at, id);

-- Copied from 20261105200000_public_api; + timeoff:read.
create or replace function internal.api_scopes()
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array[
    'people:read', 'teams:read', 'projects:read', 'projects:write', 'shifts:read',
    'timesheets:read', 'time:read', 'time:write', 'checkins:read', 'reports:read',
    'alerts:read', 'timeoff:read'
  ];
$$;

-- A time-off request in the v1 contract. Never the employee's note or the decision note
-- (their own words); decided_by is the approver (or the person, when approved on asking).
create function internal.api_time_off(r public.leave_requests)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id', r.id, 'user_id', r.user_id, 'leave_type_id', r.leave_type_id,
    'type_name', (select t.name from public.leave_types t where t.id = r.leave_type_id),
    'paid', r.paid, 'kind', r.kind, 'first_day', r.first_day, 'last_day', r.last_day,
    'start_at', r.start_at, 'end_at', r.end_at, 'timezone', r.timezone, 'status', r.status,
    'decided_by', r.decided_by, 'decided_at', r.decided_at, 'cancelled_at', r.cancelled_at,
    'created_at', r.created_at, 'updated_at', r.updated_at);
$$;

create function internal.api_holiday(h public.holidays)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object('id', h.id, 'day', h.day, 'name', h.name, 'country', h.country,
    'state', h.state, 'created_at', h.created_at, 'updated_at', h.updated_at);
$$;

-- Requests of the people the caller sees (can_view_user). `from` / `to` pick requests whose
-- days overlap them (the person's own days).
create function internal.api_list_time_off(p jsonb)
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
  v_status := internal.api_enum(p, 'status', array['pending', 'approved', 'rejected', 'cancelled']);
  select jsonb_agg(x.o order by x.at, x.id) into v_rows
  from (
    select internal.api_time_off(r) as o, r.updated_at as at, r.id
    from public.leave_requests r
    where r.org_id = v_org
      and public.can_view_user(r.user_id)
      and (v_user is null or r.user_id = v_user)
      and (v_status is null or r.status = v_status)
      and (d.from_day is null or r.last_day >= d.from_day)
      and (d.to_day is null or r.first_day <= d.to_day)
      and (a.since is null or r.updated_at >= a.since)
      and (a.after_at is null or (r.updated_at, r.id) > (a.after_at, a.after_id))
    order by r.updated_at, r.id
    limit a.lim + 1
  ) x;
  return internal.api_page(v_rows, a.lim);
end;
$$;

-- The org's holiday calendar (everyone in the org reads it).
create function internal.api_list_holidays(p jsonb)
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
  v_rows jsonb;
begin
  perform internal.api_allow(p, array['limit', 'cursor', 'updated_since', 'from', 'to']);
  select * into a from internal.api_paging(p);
  select * into d from internal.api_days(p);
  select jsonb_agg(x.o order by x.at, x.id) into v_rows
  from (
    select internal.api_holiday(h) as o, h.updated_at as at, h.id
    from public.holidays h
    where h.org_id = v_org
      and (d.from_day is null or h.day >= d.from_day)
      and (d.to_day is null or h.day <= d.to_day)
      and (a.since is null or h.updated_at >= a.since)
      and (a.after_at is null or (h.updated_at, h.id) > (a.after_at, a.after_id))
    order by h.updated_at, h.id
    limit a.lim + 1
  ) x;
  return internal.api_page(v_rows, a.lim);
end;
$$;

-- Copied from 20261105200000_public_api; + time_off.list, holidays.list.
create or replace function internal.api_operation_scope(p_operation text)
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
    when 'time_off.list' then 'timeoff:read'
    when 'holidays.list' then 'timeoff:read'
  end;
$$;

-- Copied from 20261105200000_public_api; + time_off.list, holidays.list.
create or replace function internal.api_dispatch(p_operation text, p_params jsonb, p_audit jsonb default '{}'::jsonb)
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
    when 'time_off.list' then internal.api_list_time_off(p)
    when 'holidays.list' then internal.api_list_holidays(p)
  end;
end;
$$;

-- A week in the v1 contract, with its totals: the same as /v1/timesheets returns.
create function internal.api_timesheet(t public.timesheets)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id', t.id, 'user_id', t.user_id, 'period_start', t.period_start,
    'period_end', t.period_start + 6, 'status', t.status, 'submitted_at', t.submitted_at,
    'approved_at', t.approved_at, 'approver_id', t.approver_id,
    'returned_at', t.returned_at, 'return_comment', t.comment,
    'worked_s', tot.worked_s, 'flagged_s', tot.flagged_s, 'excluded_s', tot.excluded_s,
    'manual_s', tot.manual_s, 'created_at', t.created_at, 'updated_at', t.updated_at)
  from (
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
  ) tot;
$$;

revoke all on function internal.api_time_off(public.leave_requests) from public, anon, authenticated;
revoke all on function internal.api_holiday(public.holidays) from public, anon, authenticated;
revoke all on function internal.api_list_time_off(jsonb) from public, anon, authenticated;
revoke all on function internal.api_list_holidays(jsonb) from public, anon, authenticated;
revoke all on function internal.api_timesheet(public.timesheets) from public, anon, authenticated;

-- Webhooks: endpoints ---------------------------------------------------------------------------

create function internal.webhook_event_types()
returns text[]
language sql
immutable
set search_path = ''
as $$
  select array[
    'timesheet.submitted', 'timesheet.approved', 'timesheet.returned', 'alert.raised',
    'person.invited', 'person.deactivated', 'time_off.decided'
  ];
$$;
revoke all on function internal.webhook_event_types() from public, anon, authenticated;
-- The webhooks check below calls it as whoever writes the row (the service role, in tests).
grant execute on function internal.webhook_event_types() to service_role;

create table public.webhooks (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  url text not null check (length(url) between 10 and 2000),
  events text[] not null
    check (cardinality(events) > 0 and events <@ internal.webhook_event_types()),
  enabled boolean not null default true,
  -- Why it is off: an admin turned it off, or 5 deliveries in a row failed.
  disabled_reason text check (disabled_reason in ('admin', 'failing')),
  disabled_at timestamptz,
  -- Deliveries in a row that failed every attempt; reset by a delivered one.
  failed_in_row int not null default 0 check (failed_in_row >= 0),
  secret_rotated_at timestamptz,
  created_by uuid references public.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint webhooks_off_has_reason check (enabled = (disabled_reason is null))
);

create unique index webhooks_org_url_idx on public.webhooks (org_id, url);
create index webhooks_created_by_idx on public.webhooks (created_by) where created_by is not null;
create trigger webhooks_touch_updated_at before update on public.webhooks
  for each row execute function internal.touch_updated_at('failed_in_row');

create table public.webhook_deliveries (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  webhook_id uuid not null references public.webhooks (id) on delete cascade,
  -- The event's id: the same for every endpoint and every attempt (the receiver dedupes).
  event_id uuid not null,
  event_type text not null,
  -- The person the event is about. Not a foreign key: deleting them redacts the payload
  -- (internal.webhooks_forget_user) instead of losing the row.
  subject_user_id uuid,
  -- The body as sent: { id, type, created_at, api_version, data }.
  payload jsonb not null,
  status text not null default 'pending' check (status in ('pending', 'delivered', 'failed')),
  attempts int not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz not null default now(),
  last_attempt_at timestamptz,
  -- The receiver's HTTP status of the last attempt (null: no response).
  response_status int,
  -- Why the last attempt failed, short (never the response body).
  last_error text,
  delivered_at timestamptz,
  created_at timestamptz not null default now(),
  constraint webhook_deliveries_once unique (webhook_id, event_id)
);

create index webhook_deliveries_due_idx on public.webhook_deliveries (next_attempt_at)
  where status = 'pending';
create index webhook_deliveries_webhook_idx on public.webhook_deliveries (webhook_id, created_at desc);
create index webhook_deliveries_org_idx on public.webhook_deliveries (org_id, created_at desc);
create index webhook_deliveries_subject_idx on public.webhook_deliveries (subject_user_id)
  where subject_user_id is not null;
create index webhook_deliveries_created_idx on public.webhook_deliveries (created_at);

alter table public.webhooks enable row level security;
alter table public.webhook_deliveries enable row level security;
-- Active owners and admins of the org, verified with MFA when the org asks for it (the rule
-- of internal.require_audit_reader, which the RPCs below use). Inline rather than a helper:
-- no internal function is executable by authenticated beyond what storage policies need.
create policy "Owners and admins read the org's webhooks"
on public.webhooks for select to authenticated
using (
  org_id = (select internal.jwt_org_id())
  and exists (
    select 1 from public.users me join public.orgs o on o.id = me.org_id
    where me.id = (select auth.uid()) and me.org_id = webhooks.org_id and me.active
      and me.role in ('owner', 'admin')
      and (coalesce((select auth.jwt()) ->> 'aal', '') = 'aal2'
           or not coalesce((o.policy ->> 'require_admin_mfa')::boolean, false))
  )
);
create policy "Owners and admins read the org's webhook deliveries"
on public.webhook_deliveries for select to authenticated
using (
  org_id = (select internal.jwt_org_id())
  and exists (
    select 1 from public.users me join public.orgs o on o.id = me.org_id
    where me.id = (select auth.uid()) and me.org_id = webhook_deliveries.org_id and me.active
      and me.role in ('owner', 'admin')
      and (coalesce((select auth.jwt()) ->> 'aal', '') = 'aal2'
           or not coalesce((o.policy ->> 'require_admin_mfa')::boolean, false))
  )
);
-- Writes only through the RPCs below.
revoke all on public.webhooks from anon, authenticated;
revoke all on public.webhook_deliveries from anon, authenticated;
grant select on public.webhooks to authenticated;
grant select on public.webhook_deliveries to authenticated;

-- Local stacks only: the Vault secret webhooks_allow_private_hosts = 'true' allows http and
-- private hosts (scripts/stack-secrets.sh). Production never sets it.
create function internal.webhooks_allow_private_hosts()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select s.decrypted_secret = 'true' from vault.decrypted_secrets s
    where s.name = 'webhooks_allow_private_hosts'
  ), false);
$$;
revoke all on function internal.webhooks_allow_private_hosts() from public, anon, authenticated;

-- The URL, checked (see the header) and with its scheme and host in lower case; raises
-- 22023 invalid_url with what is wrong as the detail.
create function internal.webhook_check_url(p_url text)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_url text := btrim(coalesce(p_url, ''));
  v_private boolean := internal.webhooks_allow_private_hosts();
  m text[];
  v_scheme text;
  v_host text;
  v_port text;
  v_path text;
  v_ip inet;
begin
  m := regexp_match(v_url, '^([A-Za-z][A-Za-z0-9+.-]*)://([^/?#]*)([/?][^#]*)?$');
  if length(v_url) > 2000 or m is null then
    raise exception 'invalid_url' using errcode = '22023', detail = 'not a URL';
  end if;
  v_scheme := lower(m[1]);
  if v_scheme <> 'https' and not (v_private and v_scheme = 'http') then
    raise exception 'invalid_url' using errcode = '22023', detail = 'must start with https://';
  end if;
  if position('@' in m[2]) > 0 then
    raise exception 'invalid_url' using errcode = '22023', detail = 'no user name or password';
  end if;
  v_path := m[3];
  m := regexp_match(lower(m[2]), '^([a-z0-9.-]+|\[[0-9a-f:.]+\])(?::([0-9]{1,5}))?$');
  if m is null then
    raise exception 'invalid_url' using errcode = '22023', detail = 'not a host name';
  end if;
  v_host := m[1];
  v_port := m[2];
  if v_port is not null and v_port::int not between 1 and 65535 then
    raise exception 'invalid_url' using errcode = '22023', detail = 'not a port';
  end if;
  if not v_private then
    if v_host ~ '^\[' then
      raise exception 'invalid_url' using errcode = '22023', detail = 'use a host name, not an IPv6 address';
    end if;
    if v_host ~ '^[0-9.]+$' then
      begin
        v_ip := v_host::inet;
      exception when others then
        raise exception 'invalid_url' using errcode = '22023', detail = 'not a host name';
      end;
      if v_ip << any (array['0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8',
          '169.254.0.0/16', '172.16.0.0/12', '192.0.0.0/24', '192.168.0.0/16', '198.18.0.0/15',
          '224.0.0.0/4', '240.0.0.0/4']::inet[]) then
        raise exception 'invalid_url' using errcode = '22023', detail = 'a private or local address';
      end if;
    elsif position('.' in v_host) = 0 or v_host ~ '(^|\.)(localhost|local|internal|arpa|home|lan)$'
      or v_host !~ '^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]([a-z0-9-]*[a-z0-9])?$' then
      raise exception 'invalid_url' using errcode = '22023', detail = 'a private or local host';
    end if;
  end if;
  return v_scheme || '://' || v_host || coalesce(':' || v_port, '') || coalesce(v_path, '');
end;
$$;
revoke all on function internal.webhook_check_url(text) from public, anon, authenticated;

-- The host of a URL, for audit rows and notifications.
create function internal.webhook_host(p_url text)
returns text
language sql
immutable
set search_path = ''
as $$ select substring(p_url from '^[a-z]+://([^/?#:]+|\[[^]]+\])') $$;
revoke all on function internal.webhook_host(text) from public, anon, authenticated;

-- The events, each once and sorted; raises invalid_events when empty or unknown.
create function internal.webhook_check_events(p_events text[])
returns text[]
language plpgsql
immutable
set search_path = ''
as $$
declare
  v text[];
begin
  select array_agg(distinct e order by e) into v from unnest(p_events) e;
  if coalesce(cardinality(v), 0) = 0 or not v <@ internal.webhook_event_types() then
    raise exception 'invalid_events' using errcode = '22023';
  end if;
  return v;
end;
$$;
revoke all on function internal.webhook_check_events(text[]) from public, anon, authenticated;

-- A new signing secret: whsec_ and 43 base64url characters (32 random bytes).
create function internal.webhook_new_secret()
returns text
language sql
volatile
set search_path = ''
as $$ select 'whsec_' || translate(encode(extensions.gen_random_bytes(32), 'base64'), '+/=', '-_') $$;
revoke all on function internal.webhook_new_secret() from public, anon, authenticated;

create function internal.webhook_secret_name(p_id uuid)
returns text
language sql
immutable
set search_path = ''
as $$ select 'webhook_secret:' || p_id::text $$;
revoke all on function internal.webhook_secret_name(uuid) from public, anon, authenticated;

-- Admin RPCs (owners and admins, with MFA when the org requires it) ------------------------------

-- Adds an endpoint and returns it with its signing secret: the only time the secret is shown.
create function public.create_webhook(p_url text, p_events text[])
returns table (id uuid, url text, events text[], secret text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me public.users := internal.require_audit_reader();
  v_url text := internal.webhook_check_url(p_url);
  v_events text[] := internal.webhook_check_events(p_events);
  v_secret text := internal.webhook_new_secret();
  v_row public.webhooks;
begin
  -- One at a time per org, so two can't both pass the count.
  perform 1 from public.orgs o where o.id = v_me.org_id for update;
  if (select count(*) from public.webhooks w where w.org_id = v_me.org_id) >= 10 then
    raise exception 'too_many_webhooks' using errcode = '22023';
  end if;
  if exists (select 1 from public.webhooks w where w.org_id = v_me.org_id and w.url = v_url) then
    raise exception 'url_taken' using errcode = '23505';
  end if;

  insert into public.webhooks (org_id, url, events, created_by)
  values (v_me.org_id, v_url, v_events, v_me.id)
  returning * into v_row;
  perform vault.create_secret(v_secret, internal.webhook_secret_name(v_row.id),
    'Signing secret of a webhook endpoint (#320)');

  perform internal.audit(v_me.org_id, v_me.id, 'webhook.created', null,
    jsonb_build_object('webhook_id', v_row.id, 'host', internal.webhook_host(v_row.url),
      'events', to_jsonb(v_row.events)));
  return query select v_row.id, v_row.url, v_row.events, v_secret;
end;
$$;

-- Changes an endpoint's URL, events and whether it is on. Turning it on clears the failure
-- count; turning it off keeps its queued deliveries until it is on again (or they expire).
create function public.update_webhook(p_id uuid, p_url text, p_events text[], p_enabled boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me public.users := internal.require_audit_reader();
  v_old public.webhooks;
  v_url text := internal.webhook_check_url(p_url);
  v_events text[] := internal.webhook_check_events(p_events);
  v_changed jsonb := '{}'::jsonb;
begin
  if p_enabled is null then
    raise exception 'invalid_enabled' using errcode = '22023';
  end if;
  select * into v_old from public.webhooks w where w.id = p_id and w.org_id = v_me.org_id for update;
  if not found then
    raise exception 'webhook_not_found' using errcode = '42501';
  end if;
  if v_url <> v_old.url and exists (
    select 1 from public.webhooks w where w.org_id = v_me.org_id and w.url = v_url
  ) then
    raise exception 'url_taken' using errcode = '23505';
  end if;

  if v_url <> v_old.url then
    v_changed := v_changed || jsonb_build_object('host',
      jsonb_build_object('from', internal.webhook_host(v_old.url), 'to', internal.webhook_host(v_url)));
  end if;
  if v_events <> v_old.events then
    v_changed := v_changed || jsonb_build_object('events',
      jsonb_build_object('from', to_jsonb(v_old.events), 'to', to_jsonb(v_events)));
  end if;
  if p_enabled <> v_old.enabled then
    v_changed := v_changed || jsonb_build_object('enabled',
      jsonb_build_object('from', v_old.enabled, 'to', p_enabled));
  end if;
  if v_changed = '{}'::jsonb then
    return;
  end if;

  update public.webhooks
  set url = v_url, events = v_events, enabled = p_enabled,
      disabled_reason = case when p_enabled then null
                             when v_old.enabled then 'admin' else v_old.disabled_reason end,
      disabled_at = case when p_enabled then null
                         when v_old.enabled then now() else v_old.disabled_at end,
      failed_in_row = case when p_enabled and not v_old.enabled then 0 else v_old.failed_in_row end
  where id = v_old.id;

  perform internal.audit(v_me.org_id, v_me.id, 'webhook.changed', null,
    jsonb_build_object('webhook_id', v_old.id, 'host', internal.webhook_host(v_url),
      'changed', v_changed));
end;
$$;

-- Removes an endpoint, its secret and its delivery log.
create function public.delete_webhook(p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me public.users := internal.require_audit_reader();
  v_row public.webhooks;
begin
  -- Its secret goes with it (webhooks_forget_secret).
  delete from public.webhooks w where w.id = p_id and w.org_id = v_me.org_id returning * into v_row;
  if not found then
    raise exception 'webhook_not_found' using errcode = '42501';
  end if;
  perform internal.audit(v_me.org_id, v_me.id, 'webhook.deleted', null,
    jsonb_build_object('webhook_id', v_row.id, 'host', internal.webhook_host(v_row.url),
      'events', to_jsonb(v_row.events)));
end;
$$;

-- A new signing secret, returned once. Deliveries from now on are signed with it (a retry of
-- one the receiver refused while it still had the old secret goes out with the new one).
create function public.rotate_webhook_secret(p_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me public.users := internal.require_audit_reader();
  v_row public.webhooks;
  v_secret text := internal.webhook_new_secret();
  v_vault uuid;
begin
  select * into v_row from public.webhooks w where w.id = p_id and w.org_id = v_me.org_id for update;
  if not found then
    raise exception 'webhook_not_found' using errcode = '42501';
  end if;
  select s.id into v_vault from vault.secrets s where s.name = internal.webhook_secret_name(v_row.id);
  if v_vault is null then
    perform vault.create_secret(v_secret, internal.webhook_secret_name(v_row.id),
      'Signing secret of a webhook endpoint (#320)');
  else
    perform vault.update_secret(v_vault, v_secret);
  end if;
  update public.webhooks set secret_rotated_at = now() where id = v_row.id;
  perform internal.audit(v_me.org_id, v_me.id, 'webhook.secret_rotated', null,
    jsonb_build_object('webhook_id', v_row.id, 'host', internal.webhook_host(v_row.url)));
  return v_secret;
end;
$$;

-- The org's endpoints, oldest first, with their latest delivery. Never the secret.
create function public.list_webhooks()
returns table (
  id uuid,
  url text,
  events text[],
  enabled boolean,
  disabled_reason text,
  disabled_at timestamptz,
  failed_in_row int,
  created_at timestamptz,
  created_by_name text,
  secret_rotated_at timestamptz,
  last_delivery_at timestamptz,
  last_delivery_status text,
  pending int
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
  select w.id, w.url, w.events, w.enabled, w.disabled_reason, w.disabled_at, w.failed_in_row,
    w.created_at, u.full_name, w.secret_rotated_at, last.created_at, last.status,
    (select count(*)::int from public.webhook_deliveries d
     where d.webhook_id = w.id and d.status = 'pending')
  from public.webhooks w
  left join public.users u on u.id = w.created_by
  left join lateral (
    select d.created_at, d.status from public.webhook_deliveries d
    where d.webhook_id = w.id order by d.created_at desc, d.id limit 1
  ) last on true
  where w.org_id = v_me.org_id
  order by w.created_at, w.id;
end;
$$;

-- The delivery log, newest first: one endpoint's or all (p_webhook_id null), at most 500.
-- next_attempt_at only while a delivery is waiting for its next attempt.
create function public.list_webhook_deliveries(p_webhook_id uuid default null, p_limit int default 100)
returns table (
  id uuid,
  webhook_id uuid,
  url text,
  event_id uuid,
  event_type text,
  status text,
  attempts int,
  response_status int,
  last_error text,
  next_attempt_at timestamptz,
  last_attempt_at timestamptz,
  delivered_at timestamptz,
  created_at timestamptz
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
  select d.id, d.webhook_id, w.url, d.event_id, d.event_type, d.status, d.attempts,
    d.response_status, d.last_error,
    case when d.status = 'pending' then d.next_attempt_at end,
    d.last_attempt_at, d.delivered_at, d.created_at
  from public.webhook_deliveries d
  join public.webhooks w on w.id = d.webhook_id
  where d.org_id = v_me.org_id
    and (p_webhook_id is null or d.webhook_id = p_webhook_id)
  order by d.created_at desc, d.id
  limit least(greatest(coalesce(p_limit, 100), 1), 500);
end;
$$;

-- An endpoint's secret leaves Vault with it, also when its org is deleted.
create function internal.webhooks_forget_secret()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from vault.secrets s where s.name = internal.webhook_secret_name(old.id);
  return old;
end;
$$;
revoke all on function internal.webhooks_forget_secret() from public, anon, authenticated;
create trigger webhooks_forget_secret after delete on public.webhooks
  for each row execute function internal.webhooks_forget_secret();

revoke all on function public.create_webhook(text, text[]) from public, anon;
revoke all on function public.update_webhook(uuid, text, text[], boolean) from public, anon;
revoke all on function public.delete_webhook(uuid) from public, anon;
revoke all on function public.rotate_webhook_secret(uuid) from public, anon;
revoke all on function public.list_webhooks() from public, anon;
revoke all on function public.list_webhook_deliveries(uuid, int) from public, anon;
grant execute on function public.create_webhook(text, text[]) to authenticated;
grant execute on function public.update_webhook(uuid, text, text[], boolean) to authenticated;
grant execute on function public.delete_webhook(uuid) to authenticated;
grant execute on function public.rotate_webhook_secret(uuid) to authenticated;
grant execute on function public.list_webhooks() to authenticated;
grant execute on function public.list_webhook_deliveries(uuid, int) to authenticated;

-- Events ------------------------------------------------------------------------------------

-- Whether any endpoint of the org wants the event (so the triggers skip building a payload
-- nobody receives).
create function internal.webhook_wanted(p_org_id uuid, p_type text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.webhooks w where w.org_id = p_org_id and w.enabled and p_type = any (w.events)
  );
$$;

-- Queues one event for every enabled endpoint of the org that wants it. The same event id
-- twice for an endpoint is queued once.
create function internal.webhook_emit(
  p_org_id uuid,
  p_type text,
  p_event_id uuid,
  p_subject_user_id uuid,
  p_data jsonb
)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.webhook_deliveries (org_id, webhook_id, event_id, event_type,
    subject_user_id, payload)
  select p_org_id, w.id, p_event_id, p_type, p_subject_user_id,
    jsonb_build_object('id', p_event_id, 'type', p_type, 'created_at', now(),
      'api_version', 'v1', 'data', p_data)
  from public.webhooks w
  where w.org_id = p_org_id and w.enabled and p_type = any (w.events)
  on conflict (webhook_id, event_id) do nothing;
$$;

revoke all on function internal.webhook_wanted(uuid, text) from public, anon, authenticated;
revoke all on function internal.webhook_emit(uuid, text, uuid, uuid, jsonb) from public, anon, authenticated;

create function internal.webhooks_on_timesheet()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_type text := 'timesheet.' || new.status;
begin
  if new.status in ('submitted', 'approved', 'returned')
    and (tg_op = 'INSERT' or old.status is distinct from new.status)
    and internal.webhook_wanted(new.org_id, v_type)
  then
    perform internal.webhook_emit(new.org_id, v_type, gen_random_uuid(), new.user_id,
      internal.api_timesheet(new) || jsonb_build_object('previous_status',
        case when tg_op = 'UPDATE' then old.status end));
  end if;
  return null;
end;
$$;

-- One event per alert: the rows for each recipient share the person, kind and episode.
create function internal.webhooks_on_alert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if internal.webhook_wanted(new.org_id, 'alert.raised') then
    perform internal.webhook_emit(new.org_id, 'alert.raised',
      md5('alert.raised:' || new.user_id || ':' || new.kind || ':' || new.episode)::uuid,
      new.user_id,
      jsonb_build_object('user_id', new.user_id, 'kind', new.kind, 'details', new.details,
        'triggered_at', new.triggered_at));
  end if;
  return null;
end;
$$;

create function internal.webhooks_on_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if internal.webhook_wanted(new.org_id, 'person.invited') then
      perform internal.webhook_emit(new.org_id, 'person.invited', gen_random_uuid(), new.id,
        internal.api_person(new));
    end if;
  elsif old.active and not new.active
    and internal.webhook_wanted(new.org_id, 'person.deactivated') then
    perform internal.webhook_emit(new.org_id, 'person.deactivated', gen_random_uuid(), new.id,
      internal.api_person(new));
  end if;
  return null;
end;
$$;

create function internal.webhooks_on_leave()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status in ('approved', 'rejected')
    and (tg_op = 'INSERT' or old.status = 'pending')
    and internal.webhook_wanted(new.org_id, 'time_off.decided')
  then
    perform internal.webhook_emit(new.org_id, 'time_off.decided', gen_random_uuid(), new.user_id,
      internal.api_time_off(new));
  end if;
  return null;
end;
$$;

-- Deleting a person: their delivered and failed deliveries go; queued ones keep only ids.
create function internal.webhooks_forget_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.webhook_deliveries d
  where d.subject_user_id = old.id and d.status <> 'pending';
  update public.webhook_deliveries d
  set payload = (d.payload - 'data') || jsonb_build_object('redacted', true, 'data',
        jsonb_strip_nulls(jsonb_build_object('id', d.payload -> 'data' -> 'id',
          'user_id', coalesce(d.payload -> 'data' -> 'user_id', to_jsonb(old.id))))),
      subject_user_id = null
  where d.subject_user_id = old.id;
  return old;
end;
$$;

create trigger timesheets_webhooks after insert or update of status on public.timesheets
  for each row execute function internal.webhooks_on_timesheet();
create trigger alerts_webhooks after insert on public.alerts
  for each row execute function internal.webhooks_on_alert();
create trigger users_webhooks after insert or update of active on public.users
  for each row execute function internal.webhooks_on_user();
create trigger leave_requests_webhooks after insert or update of status on public.leave_requests
  for each row execute function internal.webhooks_on_leave();
create trigger users_webhooks_forget before delete on public.users
  for each row execute function internal.webhooks_forget_user();

revoke all on function internal.webhooks_on_timesheet() from public, anon, authenticated;
revoke all on function internal.webhooks_on_alert() from public, anon, authenticated;
revoke all on function internal.webhooks_on_user() from public, anon, authenticated;
revoke all on function internal.webhooks_on_leave() from public, anon, authenticated;
revoke all on function internal.webhooks_forget_user() from public, anon, authenticated;

-- Delivery (service role only: the deliver-webhooks Edge Function) ------------------------------

create function internal.webhook_max_attempts()
returns int
language sql
immutable
set search_path = ''
as $$ select 7 $$;

-- After a delivery's n-th failed attempt, the next is 4^(n-1) minutes later: 1, 4, 16, 64,
-- 256, 1024.
create function internal.webhook_backoff(p_attempt int)
returns interval
language sql
immutable
set search_path = ''
as $$ select make_interval(mins => power(4, greatest(p_attempt, 1) - 1)::int) $$;

revoke all on function internal.webhook_max_attempts() from public, anon, authenticated;
revoke all on function internal.webhook_backoff(int) from public, anon, authenticated;

-- Hands out up to p_limit due deliveries of enabled endpoints, counting the attempt and
-- setting when the next one is due, so overlapping runs never take the same row and an
-- attempt whose result is never recorded is retried. With each: the endpoint's URL and
-- secret, and whether private hosts are allowed (local stacks).
create function public.webhook_claim(p_limit int default 25)
returns table (
  id uuid,
  url text,
  secret text,
  payload jsonb,
  event_type text,
  event_id uuid,
  attempt int,
  allow_private boolean
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- An attempt whose result never came back: after the last one, the delivery has failed.
  update public.webhook_deliveries d
  set status = 'failed', last_error = coalesce(d.last_error, 'no result recorded')
  where d.status = 'pending' and d.attempts >= internal.webhook_max_attempts()
    and d.next_attempt_at <= now();

  return query
  with claimed as (
    update public.webhook_deliveries d
    set attempts = d.attempts + 1,
        last_attempt_at = now(),
        next_attempt_at = now() + internal.webhook_backoff(d.attempts + 1)
    where d.id in (
      select q.id from public.webhook_deliveries q
      join public.webhooks w on w.id = q.webhook_id and w.enabled
      where q.status = 'pending' and q.attempts < internal.webhook_max_attempts()
        and q.next_attempt_at <= now()
      order by q.next_attempt_at
      limit least(greatest(coalesce(p_limit, 25), 1), 100)
      for update of q skip locked
    )
    returning d.*
  )
  select c.id, w.url, s.decrypted_secret, c.payload, c.event_type, c.event_id, c.attempts,
    internal.webhooks_allow_private_hosts()
  from claimed c
  join public.webhooks w on w.id = c.webhook_id
  left join vault.decrypted_secrets s on s.name = internal.webhook_secret_name(w.id);
end;
$$;

-- Records an attempt's result. Delivered: done, and the endpoint's failure count resets.
-- Failed: kept for the next attempt, or, after the last, failed; the 5th failed delivery in
-- a row turns the endpoint off and tells the org's active owners and admins.
create function public.webhook_record(p_id uuid, p_ok boolean, p_status int, p_error text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_d public.webhook_deliveries;
  v_w public.webhooks;
  r uuid;
begin
  select * into v_d from public.webhook_deliveries d where d.id = p_id and d.status = 'pending'
  for update;
  if not found then
    return;
  end if;

  if p_ok then
    update public.webhook_deliveries
    set status = 'delivered', delivered_at = now(), response_status = p_status, last_error = null
    where id = v_d.id;
    update public.webhooks set failed_in_row = 0 where id = v_d.webhook_id and failed_in_row <> 0;
    return;
  end if;

  update public.webhook_deliveries
  set response_status = p_status, last_error = left(coalesce(p_error, 'failed'), 200),
      status = case when v_d.attempts >= internal.webhook_max_attempts() then 'failed' else 'pending' end
  where id = v_d.id;
  if v_d.attempts < internal.webhook_max_attempts() then
    return;
  end if;

  update public.webhooks set failed_in_row = failed_in_row + 1
  where id = v_d.webhook_id
  returning * into v_w;
  if v_w.enabled and v_w.failed_in_row >= 5 then
    update public.webhooks
    set enabled = false, disabled_reason = 'failing', disabled_at = now()
    where id = v_w.id;
    perform internal.audit(v_w.org_id, null, 'webhook.disabled', null,
      jsonb_build_object('webhook_id', v_w.id, 'host', internal.webhook_host(v_w.url),
        'reason', 'failing', 'failed_deliveries', v_w.failed_in_row));
    for r in
      select u.id from public.users u
      where u.org_id = v_w.org_id and u.active and u.role in ('owner', 'admin')
    loop
      perform internal.notify(v_w.org_id, r, 'webhook.disabled',
        jsonb_build_object('webhook_id', v_w.id, 'host', internal.webhook_host(v_w.url),
          'failed_deliveries', v_w.failed_in_row));
    end loop;
  end if;
end;
$$;

revoke all on function public.webhook_claim(int) from public, anon, authenticated;
revoke all on function public.webhook_record(uuid, boolean, int, text) from public, anon, authenticated;
grant execute on function public.webhook_claim(int) to service_role;
grant execute on function public.webhook_record(uuid, boolean, int, text) to service_role;

-- Cron ----------------------------------------------------------------------------------------

-- Every minute, when a delivery is due: ask deliver-webhooks to send. Needs the Vault secrets
-- project_url and service_role_key (as segments_kick); without them it does nothing.
create function internal.webhooks_kick()
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_url text;
  v_key text;
begin
  if not exists (
    select 1 from public.webhook_deliveries d
    join public.webhooks w on w.id = d.webhook_id and w.enabled
    where d.status = 'pending' and d.next_attempt_at <= now()
  ) then
    return null;
  end if;
  select s.decrypted_secret into v_url from vault.decrypted_secrets s where s.name = 'project_url';
  select s.decrypted_secret into v_key from vault.decrypted_secrets s where s.name = 'service_role_key';
  if coalesce(v_url, '') = '' or coalesce(v_key, '') = '' then
    return null;
  end if;
  return net.http_post(
    url := rtrim(v_url, '/') || '/functions/v1/deliver-webhooks',
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_key),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
end;
$$;

-- Deliveries are kept 30 days, delivered, failed or still queued for an endpoint that is off.
create function internal.webhooks_purge()
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_n int;
begin
  delete from public.webhook_deliveries d where d.created_at < now() - interval '30 days';
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

revoke all on function internal.webhooks_kick() from public, anon, authenticated;
revoke all on function internal.webhooks_purge() from public, anon, authenticated;

select cron.schedule('webhooks_kick', '* * * * *', 'select internal.webhooks_kick()');
select cron.schedule('webhooks_purge', '41 3 * * *', 'select internal.webhooks_purge()');
