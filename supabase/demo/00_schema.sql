-- Demo seed (#351), step 0: a scratch `demo` schema that holds the generated plan and
-- the helpers the later steps use. Dropped again by 90_finish.sql, so a demo-seeded
-- database has nothing the migrations don't create. Never part of a test run.

create schema demo;
-- The helpers switch to the signed-in role and back (act-as, as the pgTAP tests do);
-- reading the plan in between needs this.
grant usage on schema demo to authenticated;
alter default privileges in schema demo grant all on tables to authenticated;
alter default privileges in schema demo grant all on sequences to authenticated;

create table demo.people (
  key text primary key,
  id uuid not null unique,
  seed boolean not null,
  full_name text not null,
  email text not null,
  role public.user_role not null,
  manager_key text,
  team_key text,
  country text not null,
  state text,
  tz text not null,
  shifts jsonb not null,
  shift_change jsonb,
  tracked boolean not null,
  devices int not null,
  live text,
  invited_only boolean not null,
  join_day date,
  last_day date,
  approval_required boolean not null
);
create table demo.teams (key text primary key, name text not null, billable_target int, id uuid);
create table demo.clients (key text primary key, name text not null, seed_id uuid, id uuid);
create table demo.projects (
  key text primary key, fake uuid not null, name text not null, client_key text, billable boolean not null,
  archived boolean not null, seed_id uuid, teams text[] not null, id uuid
);
create table demo.tasks (fake uuid primary key, project_key text not null, name text not null, ord int not null, id uuid);
create table demo.holidays (n int primary key, day date not null, name text not null, country text, state text, at timestamptz);
create table demo.leaves (
  n int primary key, person text not null, leave_type text not null, first_day date not null, last_day date not null,
  start_time time, end_time time, outcome text not null, decider text, note text, decision_note text, phase text not null,
  id uuid
);
create table demo.manual (
  person text not null, start_at timestamptz not null, end_at timestamptz not null, project_fake uuid not null,
  reason text not null, note text, outcome text not null, id uuid
);
create table demo.sheets (person text not null, week int not null, outcome text not null, primary key (person, week));
create table demo.actions (n serial primary key, at timestamptz not null, kind text not null, person text not null, args jsonb not null);
create table demo.events (
  n bigserial primary key, person text not null, device_no int not null, seq bigint not null, id uuid not null,
  at timestamptz not null, type text not null, payload jsonb not null
);
create table demo.devices (person text not null, device_no int not null, id uuid not null, primary key (person, device_no));
create table demo.rejections (person text, type text, at timestamptz, reason text, payload jsonb);

-- Act as a signed-in person (claims as the access-token hook builds them), and back.
create function demo.as_user(p_key text) returns void
language sql as $$
  select set_config('role', 'authenticated', true);
  select set_config('request.jwt.claims', jsonb_build_object(
    'sub', p.id, 'role', 'authenticated', 'org_id', u.org_id, 'app_role', u.role, 'aal', 'aal1'
  )::text, true)
  from demo.people p join public.users u on u.id = p.id
  where p.key = p_key;
$$;
create function demo.as_postgres() returns void
language sql as $$
  select set_config('role', 'postgres', true);
  select set_config('request.jwt.claims', '', true);
$$;
grant execute on all functions in schema demo to authenticated;

create function demo.uid(p_key text) returns uuid
language sql stable as $$ select id from demo.people where key = p_key $$;
grant execute on function demo.uid(text) to authenticated;

-- Registers a device the way the agent does at sign-in (register_device, as the person).
create function demo.register(p_key text, p_no int) returns uuid
language plpgsql as $$
declare
  v_id uuid;
begin
  perform demo.as_user(p_key);
  select r.device_id into v_id
  from public.register_device(
    case when p_no = 2 then 'windows' else 'macos' end::public.device_platform,
    case when p_no = 2 then '10.0.26100' else '26.1' end,
    '0.9.0',
    'demo-' || p_key || '-' || p_no
  ) r;
  perform demo.as_postgres();
  insert into demo.devices (person, device_no, id) values (p_key, p_no, v_id);
  return v_id;
end;
$$;

-- One planned time-off request, as people do it: the person asks (request_leave), the
-- approver decides (decide_leave), or the person withdraws it (cancel_leave).
create function demo.leave(p_n int) returns uuid
language plpgsql as $$
declare
  l demo.leaves;
  v_id uuid;
begin
  select * into l from demo.leaves where n = p_n;
  perform demo.as_user(l.person);
  v_id := public.request_leave(
    (select t.id from public.leave_types t join public.users u on u.org_id = t.org_id
     where u.id = demo.uid(l.person) and t.name = l.leave_type),
    l.first_day, l.last_day, l.start_time, l.end_time, l.note);
  if l.outcome = 'cancelled' then
    perform public.cancel_leave(v_id);
  end if;
  perform demo.as_postgres();
  if l.decider is not null and l.outcome in ('approved', 'rejected', 'approved_cancelled') then
    perform demo.as_user(l.decider);
    perform public.decide_leave(v_id, l.outcome <> 'rejected', l.decision_note);
    perform demo.as_postgres();
  end if;
  if l.outcome = 'approved_cancelled' then
    perform demo.as_user(l.person);
    perform public.cancel_leave(v_id);
    perform demo.as_postgres();
  end if;
  update demo.leaves set id = v_id where n = p_n;
  return v_id;
end;
$$;
