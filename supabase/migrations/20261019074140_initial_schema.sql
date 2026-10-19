-- First migration (#9): identity, devices, shifts and the presence/evidence tables.
-- Schema source: docs/architecture-lld.html section 05. Where issue #9 and the LLD
-- disagree the LLD wins: `checkin_events` replaces `checkins` + `captures`, and
-- `last_seen` is a separate table that is not published to Realtime.
--
-- Every table carries org_id and has row-level security enabled with no policies,
-- so nothing is readable or writable through the API until #31 adds the policies.
-- Times are timestamptz (UTC); IANA time zones live on users and shifts.

-- Not exposed through PostgREST; holds helpers that only migrations and cron call.
create schema if not exists internal;
revoke all on schema internal from public, anon, authenticated;

-- Weekly partitions live here so they stay out of the API and the generated types.
create schema if not exists partitions;
revoke all on schema partitions from public, anon, authenticated;

-- Types ---------------------------------------------------------------------

create type public.data_region as enum ('us', 'eu');
create type public.region_preset as enum ('us', 'eu', 'india');
create type public.user_role as enum ('owner', 'admin', 'manager', 'employee');
create type public.device_platform as enum ('macos', 'windows');
create type public.checkin_outcome as enum ('pass', 'miss', 'failed');

-- STS rules, in priority order (PRD 4.6).
create type public.presence_status as enum (
  'off_shift',
  'tamper',
  'offline',
  'on_break',
  'paused',
  'away_locked',
  'away',
  'in_meeting',
  'idle',
  'active'
);

-- Identity and org ------------------------------------------------------------

create table public.orgs (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) > 0),
  -- ORG-02: fixed at creation; pilots only offer US.
  data_region public.data_region not null default 'us',
  region_preset public.region_preset not null default 'us',
  policy jsonb not null default '{}'::jsonb,
  policy_version int not null default 1 check (policy_version > 0),
  created_at timestamptz not null default now()
);

create table public.users (
  id uuid primary key references auth.users (id) on delete cascade,
  org_id uuid not null references public.orgs (id) on delete cascade,
  -- Not in the LLD column list, but the dashboard needs a name and email to show,
  -- and auth.users is not readable through the API.
  full_name text not null check (length(trim(full_name)) > 0),
  email text not null,
  role public.user_role not null default 'employee',
  -- ORG-05: exactly one direct manager; null only for the owner / top of the tree.
  manager_id uuid references public.users (id) on delete set null,
  -- ORG-06: work location, state only for US.
  work_country text not null default 'US' check (work_country ~ '^[A-Z]{2}$'),
  work_state text check (work_state is null or work_state ~ '^[A-Z]{2}$'),
  timezone text not null default 'UTC',
  approval_required boolean not null default true,
  -- ORG-07: deactivated users keep their data.
  active boolean not null default true,
  created_at timestamptz not null default now(),
  constraint users_not_own_manager check (manager_id is null or manager_id <> id),
  constraint users_state_only_for_us check (work_state is null or work_country = 'US')
);

create index users_org_id_idx on public.users (org_id);
create index users_manager_id_idx on public.users (manager_id);
create unique index users_org_email_idx on public.users (org_id, lower(email));

create table public.devices (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  user_id uuid not null references public.users (id) on delete cascade,
  platform public.device_platform not null,
  os_version text not null,
  agent_version text not null,
  hardware_hash text not null,
  created_at timestamptz not null default now(),
  -- Every agent RPC checks this (tech-stack 4, "Device revocation").
  revoked_at timestamptz
);

create index devices_user_id_idx on public.devices (user_id);
create unique index devices_user_hardware_active_idx
  on public.devices (user_id, hardware_hash)
  where revoked_at is null;

-- SHF-01: days of week, start/end in the employee's time zone; may cross midnight
-- (end_time < start_time).
create table public.shifts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  user_id uuid not null references public.users (id) on delete cascade,
  -- ISO weekdays, 1 = Monday ... 7 = Sunday.
  days int[] not null check (
    cardinality(days) between 1 and 7 and days <@ array[1, 2, 3, 4, 5, 6, 7]
  ),
  start_time time not null,
  end_time time not null check (end_time <> start_time),
  timezone text not null,
  created_at timestamptz not null default now()
);

create index shifts_user_id_idx on public.shifts (user_id);

-- Presence and evidence -------------------------------------------------------

-- Raw agent events, weekly partitions on `at`. A partitioned table's unique key
-- must include the partition key, hence (id, at). The agent's event id is stable
-- across resends; the plain index on id lets the sync RPC (#23) find duplicates
-- even if a resend carries a corrected `at`.
create table public.agent_events_raw (
  id uuid not null,
  org_id uuid not null references public.orgs (id) on delete cascade,
  device_id uuid not null references public.devices (id) on delete cascade,
  user_id uuid not null references public.users (id) on delete cascade,
  seq bigint not null,
  type text not null,
  at timestamptz not null,
  received_at timestamptz not null default now(),
  payload jsonb not null default '{}'::jsonb,
  primary key (id, at)
) partition by range (at);

create index agent_events_raw_id_idx on public.agent_events_raw (id);
create index agent_events_raw_user_at_idx on public.agent_events_raw (user_id, at);

-- One row per check-in; id = the agent's checkin event id. object_keys lists the
-- uploaded files (empty for a miss: misses never capture anything).
create table public.checkin_events (
  id uuid primary key,
  org_id uuid not null references public.orgs (id) on delete cascade,
  user_id uuid not null references public.users (id) on delete cascade,
  device_id uuid not null references public.devices (id) on delete cascade,
  -- FK to projects is added with the projects table (#38).
  project_id uuid,
  scheduled_at timestamptz not null,
  shown_at timestamptz,
  responded_at timestamptz,
  outcome public.checkin_outcome not null,
  response_ms int check (response_ms is null or response_ms >= 0),
  wrong_clicks int not null default 0 check (wrong_clicks >= 0),
  idle_s_at_show int check (idle_s_at_show is null or idle_s_at_show >= 0),
  device_state text,
  object_keys text[] not null default '{}',
  face_present boolean,
  flags text[] not null default '{}',
  missed_reason text,
  created_at timestamptz not null default now(),
  constraint checkin_events_miss_has_no_captures
    check (outcome = 'pass' or cardinality(object_keys) = 0)
);

create index checkin_events_user_scheduled_idx on public.checkin_events (user_id, scheduled_at);

-- Current status per user, published to Realtime for the live grid (STS-02/03).
create table public.presence (
  user_id uuid primary key references public.users (id) on delete cascade,
  org_id uuid not null references public.orgs (id) on delete cascade,
  status public.presence_status not null default 'off_shift',
  since timestamptz not null default now(),
  last_checkin_at timestamptz,
  last_checkin_outcome public.checkin_outcome,
  project_id uuid
);

create index presence_org_id_idx on public.presence (org_id);

-- Heartbeat timestamps. Kept apart from presence so a heartbeat every 60 s does not
-- fan out a Realtime message; not published.
create table public.last_seen (
  user_id uuid primary key references public.users (id) on delete cascade,
  org_id uuid not null references public.orgs (id) on delete cascade,
  device_id uuid not null references public.devices (id) on delete cascade,
  at timestamptz not null
);

-- Row-level security: deny by default until #31 adds policies.
alter table public.orgs enable row level security;
alter table public.users enable row level security;
alter table public.devices enable row level security;
alter table public.shifts enable row level security;
alter table public.agent_events_raw enable row level security;
alter table public.checkin_events enable row level security;
alter table public.presence enable row level security;
alter table public.last_seen enable row level security;

-- Realtime: only presence.
alter publication supabase_realtime add table public.presence;

-- Partitions ------------------------------------------------------------------

-- Creates the missing weekly partitions (Monday 00:00 UTC to the next Monday) of a
-- table partitioned by range on a timestamptz, covering [from_ts, to_ts]. Named
-- partitions.<table>_pYYYYMMDD after the week's Monday. The weekly cron job and dropping
-- expired partitions come with #51.
create function internal.ensure_weekly_partitions(
  parent regclass,
  from_ts timestamptz,
  to_ts timestamptz
) returns int
language plpgsql
set search_path = ''
as $$
declare
  week_start timestamptz := date_trunc('week', from_ts at time zone 'UTC') at time zone 'UTC';
  parent_name text := (select relname from pg_class where oid = parent);
  part_name text;
  created int := 0;
begin
  while week_start <= to_ts loop
    part_name := parent_name || '_p' || to_char(week_start at time zone 'UTC', 'YYYYMMDD');
    if to_regclass(format('partitions.%I', part_name)) is null then
      execute format(
        'create table partitions.%I partition of %s for values from (%L) to (%L)',
        part_name, parent, week_start, week_start + interval '1 week'
      );
      -- Partitions are tables in their own right: without this, querying one
      -- directly would skip the parent's row-level security.
      execute format('alter table partitions.%I enable row level security', part_name);
      created := created + 1;
    end if;
    week_start := week_start + interval '1 week';
  end loop;
  return created;
end;
$$;

revoke all on function internal.ensure_weekly_partitions(regclass, timestamptz, timestamptz)
  from public, anon, authenticated;

-- The sync RPC accepts events up to 7 days old, so cover last week through four
-- weeks ahead until the weekly job (#51) takes over.
select internal.ensure_weekly_partitions(
  'public.agent_events_raw', now() - interval '7 days', now() + interval '4 weeks'
);
