-- #304: time off, part 1 (LV-01..04, LV-07; AUD-01). Leave types, the org holiday
-- calendar, time-off requests with their approval, and what an approved leave day or a
-- holiday changes: the On leave status, no late clock-in recorded or alerted, no offline
-- alert, no auto clock-in.
--
-- Leave types (LV-01) --------------------------------------------------------------------
-- Per org: a name, paid or unpaid, active or archived. Never deleted (a request keeps
-- pointing at its type). Every org starts with Vacation, Sick and Personal (paid) and
-- Unpaid; a trigger on orgs adds them to new orgs. Owners and admins manage them with
-- save_leave_type (leave_type.created / leave_type.changed). Everyone in the org reads them.
--
-- Holidays (LV-02) -----------------------------------------------------------------------
-- A date and a name, for everyone in the org or for one work location (ORG-06): a country,
-- plus a state for the US. A holiday with country US and no state is for everyone in the
-- US. The calendar starts empty. Owners and admins add, change and remove them
-- (holiday.added / holiday.changed / holiday.removed). A holiday is the person's whole
-- local day (their users.timezone). Everyone in the org reads the calendar.
--
-- Requests (LV-03) -----------------------------------------------------------------------
-- An employee asks for whole days (first..last, both included) or a part day (one date, a
-- start and an end time), in their own time zone when they ask, with an optional note.
-- start_at/end_at is the span that results; it is what everything else reads. Pending and
-- approved requests of one person never overlap. A person with no manager (the owner at
-- the top) has nothing to wait for, so theirs is approved when asked (as their weeks are,
-- TS-16). Otherwise the direct manager or the manager's active delegate decides (the
-- is_entry_decider rule, TS-12): owners and admins who are neither only read. The
-- employee may cancel a pending request, or an approved one before it starts. Every
-- request, decision and cancellation is audit-logged (leave.requested, leave.approved,
-- leave.rejected, leave.cancelled; the note's length, not its words, which the table
-- keeps) and the other side is notified (notifications of the same kinds). `paid` is the
-- type's flag when the request was made, so a later change to the type doesn't rewrite
-- leave already taken. No balances or accrual.
--
-- On leave (LV-04) ------------------------------------------------------------------------
-- internal.on_leave_at(person, instant): an approved request covers the instant, or a
-- holiday that applies to the person falls on that instant's local date. Then:
--   * status: compute_status returns on_leave instead of off_shift when the person is not
--     clocked in (status.ts agrees; vectors in packages/core/vectors/status.json). Clocked
--     in, the usual rules apply. leave_sweep (every minute) refreshes everyone whose
--     On leave state changed, since nothing else happens to someone who is away; a
--     decision or cancellation refreshes the person at once.
--   * late clock-ins (SHF-06): no row for a shift whose start is on leave; approving a
--     request or adding a holiday removes the rows it now covers. Reports and the digest
--     read those rows, so they follow.
--   * alerts (ALR-01): no late clock-in alert for a shift that starts on leave, no offline
--     alert for an Offline period that began on leave.
--   * auto clock-in (SHF-03): agent_config sends the person's leave spans (approved
--     requests and applicable holidays, from yesterday on), and the agent doesn't clock in
--     automatically inside one. A decision, cancellation or holiday change bumps the
--     person's config_version so their agent refetches.
--
-- Retention and deletion (LV-07) ----------------------------------------------------------
-- Requests keep the timesheet window (by end, like manual entries), go out in the
-- person's data export (supabase/functions/_shared/userData.ts) and are deleted with them.
--
-- Redefined here, each copied from its latest definition with only this change:
--   compute_status            (20261019143352_status_engine): + on_leave
--   status_input              (20261020195000_tamper_policy): + on_leave
--   offline_sweep             (20261019143352_status_engine): skips on_leave too
--   record_late_clock_in      (20261022150000_digest_top_apps): skips shifts on leave
--   alert_eval                (20261020192000_tamper_reason): late clock-in and offline
--                             skip leave
--   agent_config              (20261031150000_tray_task_picker): + leave
--   retention_purge_rows      (20261101200000_timesheet_comments): + leave_requests
--   internal.delete_user_data (20261101200000_timesheet_comments): + leave_requests

-- Leave types ------------------------------------------------------------------------------

create table public.leave_types (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  name text not null constraint leave_types_name_length check (length(btrim(name)) between 1 and 60),
  paid boolean not null default true,
  archived boolean not null default false,
  created_at timestamptz not null default now()
);

create unique index leave_types_org_name_idx on public.leave_types (org_id, lower(btrim(name)));
alter table public.leave_types enable row level security;

create policy "Everyone in the org reads leave types"
on public.leave_types for select to authenticated
using (org_id = (select internal.jwt_org_id()));

revoke insert, update, delete on public.leave_types from anon, authenticated;

-- The four every org starts with.
create function internal.add_default_leave_types(p_org_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.leave_types (org_id, name, paid)
  values (p_org_id, 'Vacation', true), (p_org_id, 'Sick', true),
         (p_org_id, 'Personal', true), (p_org_id, 'Unpaid', false)
  on conflict do nothing;
$$;

create function internal.orgs_default_leave_types()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform internal.add_default_leave_types(new.id);
  return null;
end;
$$;

create trigger orgs_default_leave_types
after insert on public.orgs
for each row execute function internal.orgs_default_leave_types();

select internal.add_default_leave_types(o.id) from public.orgs o;

revoke all on function internal.add_default_leave_types(uuid) from public, anon, authenticated;
revoke all on function internal.orgs_default_leave_types() from public, anon, authenticated;

-- LV-01: creates (null id) or changes a leave type. Owners and admins. Names are unique in
-- the org, ignoring case (name_taken). Returns its id.
create function public.save_leave_type(
  p_id uuid,
  p_name text,
  p_paid boolean,
  p_archived boolean default false
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me public.users := internal.current_app_user();
  v_old public.leave_types;
  v_name text := btrim(coalesce(p_name, ''));
  v_id uuid;
  v_changed jsonb := '{}'::jsonb;
begin
  perform internal.require_org_admin(v_me.org_id);
  if length(v_name) not between 1 and 60 or p_paid is null then
    raise exception 'invalid_leave_type' using errcode = '22023';
  end if;
  if exists (
    select 1 from public.leave_types t
    where t.org_id = v_me.org_id and lower(t.name) = lower(v_name)
      and t.id is distinct from p_id
  ) then
    raise exception 'name_taken' using errcode = '23505';
  end if;

  if p_id is null then
    insert into public.leave_types (org_id, name, paid, archived)
    values (v_me.org_id, v_name, p_paid, coalesce(p_archived, false))
    returning id into v_id;
    perform internal.audit(v_me.org_id, v_me.id, 'leave_type.created', null,
      jsonb_build_object('leave_type_id', v_id, 'name', v_name, 'paid', p_paid,
        'archived', coalesce(p_archived, false)));
    return v_id;
  end if;

  select * into v_old from public.leave_types t
  where t.id = p_id and t.org_id = v_me.org_id for update;
  if not found then
    raise exception 'leave_type_not_found' using errcode = '42501';
  end if;
  if v_old.name is distinct from v_name then
    v_changed := v_changed || jsonb_build_object('name', jsonb_build_object('from', v_old.name, 'to', v_name));
  end if;
  if v_old.paid is distinct from p_paid then
    v_changed := v_changed || jsonb_build_object('paid', jsonb_build_object('from', v_old.paid, 'to', p_paid));
  end if;
  if v_old.archived is distinct from coalesce(p_archived, false) then
    v_changed := v_changed || jsonb_build_object('archived',
      jsonb_build_object('from', v_old.archived, 'to', coalesce(p_archived, false)));
  end if;
  if v_changed <> '{}'::jsonb then
    update public.leave_types
    set name = v_name, paid = p_paid, archived = coalesce(p_archived, false)
    where id = v_old.id;
    perform internal.audit(v_me.org_id, v_me.id, 'leave_type.changed', null,
      jsonb_build_object('leave_type_id', v_old.id, 'name', v_name, 'changed', v_changed));
  end if;
  return v_old.id;
end;
$$;

revoke all on function public.save_leave_type(uuid, text, boolean, boolean) from public, anon;
grant execute on function public.save_leave_type(uuid, text, boolean, boolean) to authenticated;

-- Holidays ---------------------------------------------------------------------------------

create table public.holidays (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  day date not null,
  name text not null constraint holidays_name_length check (length(btrim(name)) between 1 and 80),
  -- Null: everyone. Else the work location it is for (users.work_country/work_state).
  country text constraint holidays_country_code check (country is null or country ~ '^[A-Z]{2}$'),
  state text constraint holidays_state_code check (state is null or state ~ '^[A-Z]{2}$'),
  created_by uuid references public.users (id) on delete set null,
  created_at timestamptz not null default now(),
  constraint holidays_state_only_for_us check (state is null or country = 'US')
);

create unique index holidays_org_day_place_idx
  on public.holidays (org_id, day, coalesce(country, ''), coalesce(state, ''));
alter table public.holidays enable row level security;

create policy "Everyone in the org reads holidays"
on public.holidays for select to authenticated
using (org_id = (select internal.jwt_org_id()));

revoke insert, update, delete on public.holidays from anon, authenticated;

-- Whether a holiday for (country, state) applies to someone working in (work_country,
-- work_state): everyone's, their country's, or their country and state's.
create function internal.holiday_applies(
  p_country text,
  p_state text,
  p_work_country text,
  p_work_state text
)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_country is null
    or (p_country = p_work_country and (p_state is null or p_state is not distinct from p_work_state));
$$;

revoke all on function internal.holiday_applies(text, text, text, text) from public, anon, authenticated;

-- Requests ---------------------------------------------------------------------------------

create table public.leave_requests (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  user_id uuid not null references public.users (id) on delete cascade,
  leave_type_id uuid not null references public.leave_types (id),
  -- The type's paid flag when asked (LV-05 reads it).
  paid boolean not null,
  kind text not null check (kind in ('days', 'part_day')),
  -- Local dates in `timezone`, both included; one date for a part day.
  first_day date not null,
  last_day date not null,
  -- The span: local midnight to midnight for days, the times asked for a part day.
  start_at timestamptz not null,
  end_at timestamptz not null,
  -- The person's time zone when they asked.
  timezone text not null,
  note text check (note is null or length(note) between 1 and 500),
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected', 'cancelled')),
  decided_by uuid references public.users (id) on delete set null,
  -- As written (an employee can't read their manager's user row).
  decided_by_name text,
  decided_at timestamptz,
  decision_note text check (decision_note is null or length(decision_note) between 1 and 500),
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  constraint leave_requests_days_in_order check (last_day >= first_day),
  constraint leave_requests_part_day_is_one_day check (kind = 'days' or last_day = first_day),
  constraint leave_requests_span check (end_at > start_at)
);

create index leave_requests_user_span_idx on public.leave_requests (user_id, start_at);
create index leave_requests_approved_idx on public.leave_requests (user_id, start_at, end_at)
  where status = 'approved';
create index leave_requests_org_days_idx on public.leave_requests (org_id, first_day);
alter table public.leave_requests enable row level security;

-- Same rule as the other per-employee tables. Writes only through the functions below.
create policy "Visible per can_view_user"
on public.leave_requests for select to authenticated
using (org_id = (select internal.jwt_org_id()) and public.can_view_user(user_id));

revoke insert, update, delete on public.leave_requests from anon, authenticated;

-- On leave ---------------------------------------------------------------------------------

-- LV-04: whether the person is on leave at p_at: an approved request covers it, or a
-- holiday that applies to them is on its local date (their time zone).
create function internal.on_leave_at(p_user_id uuid, p_at timestamptz)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.leave_requests r
    where r.user_id = p_user_id and r.status = 'approved'
      and r.start_at <= p_at and r.end_at > p_at
  )
  or exists (
    select 1
    from public.users u
    join public.holidays h on h.org_id = u.org_id
    where u.id = p_user_id
      and h.day = (p_at at time zone u.timezone)::date
      and internal.holiday_applies(h.country, h.state, u.work_country, u.work_state)
  );
$$;

revoke all on function internal.on_leave_at(uuid, timestamptz) from public, anon, authenticated;

-- The person's leave from p_from on, as spans for the agent (SHF-03): approved requests and
-- the holidays that apply to them (their whole local day). Unmerged; at most 200 of each.
create function internal.leave_spans(p_user_id uuid, p_from timestamptz)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object('start', s.start_at, 'end', s.end_at)
    order by s.start_at), '[]'::jsonb)
  from (
    (select r.start_at, r.end_at
     from public.leave_requests r
     where r.user_id = p_user_id and r.status = 'approved' and r.end_at > p_from
     order by r.start_at limit 200)
    union all
    (select h.day::timestamp at time zone u.timezone, (h.day + 1)::timestamp at time zone u.timezone
     from public.users u
     join public.holidays h on h.org_id = u.org_id
     where u.id = p_user_id
       and h.day >= (p_from at time zone u.timezone)::date
       and internal.holiday_applies(h.country, h.state, u.work_country, u.work_state)
     order by h.day limit 200)
  ) s;
$$;

revoke all on function internal.leave_spans(uuid, timestamptz) from public, anon, authenticated;

-- What changes for the people whose leave changed (a request approved or an approved one
-- cancelled, a holiday added, changed or removed): their agent refetches its config (auto
-- clock-in), their status is recomputed now, and late clock-ins now on leave go. Late
-- rows are only looked for between p_from and p_to (shift start), when given.
create function internal.leave_changed(p_user_ids uuid[], p_from timestamptz, p_to timestamptz)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid;
begin
  update public.users u set config_version = u.config_version + 1 where u.id = any (p_user_ids);
  delete from public.late_clock_ins l
  where l.user_id = any (p_user_ids)
    and l.shift_start >= p_from and l.shift_start < p_to
    and internal.on_leave_at(l.user_id, l.shift_start);
  foreach v_user in array p_user_ids loop
    perform internal.refresh_presence(v_user, now());
  end loop;
end;
$$;

revoke all on function internal.leave_changed(uuid[], timestamptz, timestamptz) from public, anon, authenticated;

-- Holidays: managing (owners and admins) ----------------------------------------------------

-- Everyone a holiday for (country, state) in the org applies to.
create function internal.holiday_people(p_org_id uuid, p_country text, p_state text)
returns uuid[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(u.id), '{}')
  from public.users u
  where u.org_id = p_org_id
    and internal.holiday_applies(p_country, p_state, u.work_country, u.work_state);
$$;

revoke all on function internal.holiday_people(uuid, text, text) from public, anon, authenticated;

-- Checks a holiday's fields; raises 22023 with the field in DETAIL.
create function internal.check_holiday(p_day date, p_name text, p_country text, p_state text)
returns void
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_day is null then
    raise exception 'invalid_holiday' using errcode = '22023', detail = 'day';
  end if;
  if length(btrim(coalesce(p_name, ''))) not between 1 and 80 then
    raise exception 'invalid_holiday' using errcode = '22023', detail = 'name';
  end if;
  if p_country is not null and p_country !~ '^[A-Z]{2}$' then
    raise exception 'invalid_holiday' using errcode = '22023', detail = 'country';
  end if;
  if p_state is not null and (p_country is distinct from 'US' or p_state !~ '^[A-Z]{2}$') then
    raise exception 'invalid_holiday' using errcode = '22023', detail = 'state';
  end if;
end;
$$;

revoke all on function internal.check_holiday(date, text, text, text) from public, anon, authenticated;

-- LV-02: adds (null id) or changes a holiday. Owners and admins. One holiday per date and
-- place (holiday_exists). Returns its id.
create function public.save_holiday(
  p_id uuid,
  p_day date,
  p_name text,
  p_country text default null,
  p_state text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me public.users := internal.current_app_user();
  v_old public.holidays;
  v_name text := btrim(coalesce(p_name, ''));
  v_country text := nullif(upper(btrim(coalesce(p_country, ''))), '');
  v_state text := nullif(upper(btrim(coalesce(p_state, ''))), '');
  v_id uuid;
  v_people uuid[];
begin
  perform internal.require_org_admin(v_me.org_id);
  perform internal.check_holiday(p_day, v_name, v_country, v_state);
  if exists (
    select 1 from public.holidays h
    where h.org_id = v_me.org_id and h.day = p_day
      and coalesce(h.country, '') = coalesce(v_country, '')
      and coalesce(h.state, '') = coalesce(v_state, '')
      and h.id is distinct from p_id
  ) then
    raise exception 'holiday_exists' using errcode = '23505';
  end if;

  if p_id is null then
    insert into public.holidays (org_id, day, name, country, state, created_by)
    values (v_me.org_id, p_day, v_name, v_country, v_state, v_me.id)
    returning id into v_id;
    perform internal.audit(v_me.org_id, v_me.id, 'holiday.added', null,
      jsonb_build_object('holiday_id', v_id, 'day', p_day, 'name', v_name,
        'country', v_country, 'state', v_state));
    v_people := internal.holiday_people(v_me.org_id, v_country, v_state);
  else
    select * into v_old from public.holidays h
    where h.id = p_id and h.org_id = v_me.org_id for update;
    if not found then
      raise exception 'holiday_not_found' using errcode = '42501';
    end if;
    v_id := v_old.id;
    if (v_old.day, v_old.name, v_old.country, v_old.state)
      is not distinct from (p_day, v_name, v_country, v_state) then
      return v_id;
    end if;
    update public.holidays
    set day = p_day, name = v_name, country = v_country, state = v_state
    where id = v_old.id;
    perform internal.audit(v_me.org_id, v_me.id, 'holiday.changed', null,
      jsonb_build_object('holiday_id', v_id, 'day', p_day, 'name', v_name,
        'country', v_country, 'state', v_state,
        'from', jsonb_build_object('day', v_old.day, 'name', v_old.name,
          'country', v_old.country, 'state', v_old.state)));
    v_people := internal.holiday_people(v_me.org_id, v_old.country, v_old.state)
      || internal.holiday_people(v_me.org_id, v_country, v_state);
  end if;

  perform internal.leave_changed(
    array(select distinct unnest(v_people)),
    (p_day - 1)::timestamp at time zone 'UTC', (p_day + 2)::timestamp at time zone 'UTC');
  return v_id;
end;
$$;

-- LV-02: removes a holiday. Owners and admins.
create function public.delete_holiday(p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me public.users := internal.current_app_user();
  v_old public.holidays;
begin
  perform internal.require_org_admin(v_me.org_id);
  delete from public.holidays h where h.id = p_id and h.org_id = v_me.org_id
  returning * into v_old;
  if not found then
    raise exception 'holiday_not_found' using errcode = '42501';
  end if;
  perform internal.audit(v_me.org_id, v_me.id, 'holiday.removed', null,
    jsonb_build_object('holiday_id', v_old.id, 'day', v_old.day, 'name', v_old.name,
      'country', v_old.country, 'state', v_old.state));
  perform internal.leave_changed(internal.holiday_people(v_me.org_id, v_old.country, v_old.state),
    'infinity'::timestamptz, 'infinity'::timestamptz);
end;
$$;

revoke all on function public.save_holiday(uuid, date, text, text, text) from public, anon;
revoke all on function public.delete_holiday(uuid) from public, anon;
grant execute on function public.save_holiday(uuid, date, text, text, text) to authenticated;
grant execute on function public.delete_holiday(uuid) to authenticated;

-- Requests: asking, deciding, cancelling ------------------------------------------------------

-- The people who decide on p_emp's requests (direct manager and the manager's active
-- delegates, active, never the person themselves).
create function internal.leave_deciders(p_emp public.users)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select u.id from public.users u
  where u.org_id = p_emp.org_id and u.active and u.id <> p_emp.id
    and p_emp.manager_id is not null
    and (u.id = p_emp.manager_id or internal.is_active_delegate(p_emp.manager_id, u.id));
$$;

revoke all on function internal.leave_deciders(public.users) from public, anon, authenticated;

-- What a notification and the audit log say about a request.
create function internal.leave_payload(p_req public.leave_requests)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object('request_id', p_req.id, 'employee_id', p_req.user_id,
    'employee_name', (select u.full_name from public.users u where u.id = p_req.user_id),
    'leave_type_id', p_req.leave_type_id,
    'type_name', (select t.name from public.leave_types t where t.id = p_req.leave_type_id),
    'paid', p_req.paid, 'kind', p_req.kind, 'first_day', p_req.first_day,
    'last_day', p_req.last_day, 'start_at', p_req.start_at, 'end_at', p_req.end_at,
    'timezone', p_req.timezone);
$$;

revoke all on function internal.leave_payload(public.leave_requests) from public, anon, authenticated;

-- LV-03: the caller asks for time off: whole days p_first_day..p_last_day (both included;
-- null last day: one day), or, with p_start_time and p_end_time, part of p_first_day. In
-- the caller's time zone. From 31 days back to a year ahead, at most 366 days long, not
-- overlapping their other pending or approved requests (leave_overlaps). The type must be
-- active. Returns the request's id.
create function public.request_leave(
  p_leave_type_id uuid,
  p_first_day date,
  p_last_day date default null,
  p_start_time time default null,
  p_end_time time default null,
  p_note text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me public.users := internal.current_app_user();
  v_type public.leave_types;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_last date := coalesce(p_last_day, p_first_day);
  v_today date := (now() at time zone v_me.timezone)::date;
  v_kind text := case when p_start_time is null and p_end_time is null then 'days' else 'part_day' end;
  v_start timestamptz;
  v_end timestamptz;
  v_auto boolean := v_me.manager_id is null;
  v_req public.leave_requests;
  r uuid;
begin
  select * into v_type from public.leave_types t
  where t.id = p_leave_type_id and t.org_id = v_me.org_id and not t.archived;
  if not found then
    raise exception 'leave_type_not_found' using errcode = '22023';
  end if;
  if p_first_day is null or v_last < p_first_day or v_last - p_first_day > 365
    or p_first_day < v_today - 31 or v_last > v_today + 366 then
    raise exception 'invalid_dates' using errcode = '22023';
  end if;
  if v_note is not null and length(v_note) > 500 then
    raise exception 'invalid_note' using errcode = '22023';
  end if;

  if v_kind = 'days' then
    v_start := p_first_day::timestamp at time zone v_me.timezone;
    v_end := (v_last + 1)::timestamp at time zone v_me.timezone;
  else
    if p_start_time is null or p_end_time is null or p_end_time <= p_start_time
      or v_last <> p_first_day then
      raise exception 'invalid_times' using errcode = '22023';
    end if;
    v_start := (p_first_day + p_start_time) at time zone v_me.timezone;
    v_end := (p_first_day + p_end_time) at time zone v_me.timezone;
  end if;

  -- One request at a time per person, so two can't both pass the overlap check.
  perform 1 from public.users u where u.id = v_me.id for update;
  if exists (
    select 1 from public.leave_requests x
    where x.user_id = v_me.id and x.status in ('pending', 'approved')
      and x.start_at < v_end and x.end_at > v_start
  ) then
    raise exception 'leave_overlaps' using errcode = '23P01';
  end if;

  insert into public.leave_requests (org_id, user_id, leave_type_id, paid, kind, first_day,
    last_day, start_at, end_at, timezone, note, status, decided_by, decided_by_name, decided_at)
  values (v_me.org_id, v_me.id, v_type.id, v_type.paid, v_kind, p_first_day, v_last, v_start,
    v_end, v_me.timezone, v_note,
    case when v_auto then 'approved' else 'pending' end,
    case when v_auto then v_me.id end, case when v_auto then v_me.full_name end,
    case when v_auto then now() end)
  returning * into v_req;

  perform internal.audit(v_me.org_id, v_me.id, 'leave.requested', v_me.id,
    internal.leave_payload(v_req) - 'employee_name'
      || jsonb_build_object('note_length', coalesce(length(v_note), 0), 'auto_approved', v_auto));

  if v_auto then
    perform internal.leave_changed(array[v_me.id], v_start, v_end);
  else
    for r in select internal.leave_deciders(v_me) loop
      perform internal.notify(v_me.org_id, r, 'leave.requested',
        internal.leave_payload(v_req) || jsonb_build_object('note', left(v_note, 140)));
    end loop;
  end if;
  return v_req.id;
end;
$$;

-- LV-03: the direct manager or their active delegate approves (p_approve) or rejects a
-- pending request, with an optional note to the employee. Audit-logged; the employee is
-- told.
create function public.decide_leave(p_request_id uuid, p_approve boolean, p_note text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me public.users := internal.current_app_user();
  v_req public.leave_requests;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_status text := case when p_approve then 'approved' else 'rejected' end;
begin
  if p_approve is null then
    raise exception 'invalid_decision' using errcode = '22023';
  end if;
  if v_note is not null and length(v_note) > 500 then
    raise exception 'invalid_note' using errcode = '22023';
  end if;
  select * into v_req from public.leave_requests r where r.id = p_request_id for update;
  if not found or v_req.org_id <> v_me.org_id or not public.can_view_user(v_req.user_id) then
    raise exception 'leave_not_found' using errcode = '42501';
  end if;
  if not internal.is_entry_decider(v_me, v_req.user_id) then
    raise exception 'not_allowed' using errcode = '42501';
  end if;
  if v_req.status <> 'pending' then
    raise exception 'not_pending' using errcode = '55000';
  end if;

  update public.leave_requests
  set status = v_status, decided_by = v_me.id, decided_by_name = v_me.full_name,
      decided_at = now(), decision_note = v_note
  where id = v_req.id
  returning * into v_req;

  perform internal.audit(v_me.org_id, v_me.id, 'leave.' || v_status, v_req.user_id,
    internal.leave_payload(v_req) - 'employee_name'
      || jsonb_build_object('note_length', coalesce(length(v_note), 0)));
  perform internal.notify(v_req.org_id, v_req.user_id, 'leave.' || v_status,
    internal.leave_payload(v_req)
      || jsonb_build_object('by', v_me.id, 'by_name', v_me.full_name, 'note', v_note));
  if p_approve then
    perform internal.leave_changed(array[v_req.user_id], v_req.start_at, v_req.end_at);
  end if;
end;
$$;

-- LV-03: the employee cancels their own pending request, or an approved one that hasn't
-- started. Audit-logged; the people who decide are told.
create function public.cancel_leave(p_request_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me public.users := internal.current_app_user();
  v_req public.leave_requests;
  v_was text;
  r uuid;
begin
  select * into v_req from public.leave_requests x where x.id = p_request_id for update;
  if not found or v_req.org_id <> v_me.org_id or not public.can_view_user(v_req.user_id) then
    raise exception 'leave_not_found' using errcode = '42501';
  end if;
  if v_req.user_id <> v_me.id then
    raise exception 'not_allowed' using errcode = '42501';
  end if;
  v_was := v_req.status;
  if not (v_was = 'pending' or (v_was = 'approved' and v_req.start_at > now())) then
    raise exception 'cannot_cancel' using errcode = '55000';
  end if;

  update public.leave_requests set status = 'cancelled', cancelled_at = now()
  where id = v_req.id
  returning * into v_req;

  perform internal.audit(v_me.org_id, v_me.id, 'leave.cancelled', v_me.id,
    internal.leave_payload(v_req) - 'employee_name' || jsonb_build_object('was', v_was));
  for r in select internal.leave_deciders(v_me) loop
    perform internal.notify(v_me.org_id, r, 'leave.cancelled',
      internal.leave_payload(v_req) || jsonb_build_object('was', v_was));
  end loop;
  if v_was = 'approved' then
    perform internal.leave_changed(array[v_me.id], v_req.start_at, v_req.end_at);
  end if;
end;
$$;

revoke all on function public.request_leave(uuid, date, date, time, time, text) from public, anon;
revoke all on function public.decide_leave(uuid, boolean, text) from public, anon;
revoke all on function public.cancel_leave(uuid) from public, anon;
grant execute on function public.request_leave(uuid, date, date, time, time, text) to authenticated;
grant execute on function public.decide_leave(uuid, boolean, text) to authenticated;
grant execute on function public.cancel_leave(uuid) to authenticated;

-- Reading ------------------------------------------------------------------------------------

-- The requests the caller may view (can_view_user: their own, their reports', an active
-- delegate's, everyone's for owners and admins), with the names an employee can't read
-- themselves and what the caller may do with each: decide (pending, and they are the
-- direct manager or active delegate) or cancel (their own, pending or not yet started).
-- Optional filters: days overlapping p_from..p_to, one person, one status. Newest first, at
-- most 2000.
create function public.leave_requests_list(
  p_from date default null,
  p_to date default null,
  p_user_id uuid default null,
  p_status text default null
)
returns table (
  id uuid,
  user_id uuid,
  employee_name text,
  leave_type_id uuid,
  type_name text,
  paid boolean,
  kind text,
  first_day date,
  last_day date,
  start_at timestamptz,
  end_at timestamptz,
  timezone text,
  note text,
  status text,
  decided_by_name text,
  decided_at timestamptz,
  decision_note text,
  cancelled_at timestamptz,
  created_at timestamptz,
  can_decide boolean,
  can_cancel boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_me public.users := internal.current_app_user();
begin
  return query
    select r.id, r.user_id, u.full_name, r.leave_type_id, t.name, r.paid, r.kind,
           r.first_day, r.last_day, r.start_at, r.end_at, r.timezone, r.note, r.status,
           r.decided_by_name, r.decided_at, r.decision_note, r.cancelled_at, r.created_at,
           r.status = 'pending' and internal.is_entry_decider(v_me, r.user_id),
           r.user_id = v_me.id
             and (r.status = 'pending' or (r.status = 'approved' and r.start_at > now()))
    from public.leave_requests r
    join public.users u on u.id = r.user_id
    join public.leave_types t on t.id = r.leave_type_id
    where r.org_id = v_me.org_id
      and public.can_view_user(r.user_id)
      and (p_from is null or r.last_day >= p_from)
      and (p_to is null or r.first_day <= p_to)
      and (p_user_id is null or r.user_id = p_user_id)
      and (p_status is null or r.status = p_status)
    order by r.first_day desc, r.start_at desc, r.id
    limit 2000;
end;
$$;

revoke all on function public.leave_requests_list(date, date, uuid, text) from public, anon;
grant execute on function public.leave_requests_list(date, date, uuid, text) to authenticated;

-- Status (copied from 20261019143352_status_engine; + on_leave) -------------------------------

-- Mirror of computeStatus() in packages/core/src/status.ts. Keep in step with the
-- shared vectors (supabase/tests/database/status_vectors.test.sql).
create or replace function internal.compute_status(s jsonb)
returns public.presence_status
language sql
immutable
set search_path = ''
as $$
  select case
    when not coalesce((s ->> 'clocked_in')::boolean, false) then
      case when coalesce((s ->> 'on_leave')::boolean, false) then 'on_leave' else 'off_shift' end
    when coalesce((s ->> 'tamper')::boolean, false) then 'tamper'
    when coalesce((s ->> 'offline')::boolean, false) then 'offline'
    when coalesce((s ->> 'on_break')::boolean, false) then 'on_break'
    when coalesce((s ->> 'paused')::boolean, false) then 'paused'
    when coalesce((s ->> 'locked')::boolean, false) then 'away_locked'
    when s ->> 'last_checkin' in ('miss', 'failed') then 'away'
    when coalesce((s ->> 'in_call')::boolean, false) then 'in_meeting'
    when coalesce((s ->> 'idle')::boolean, false) then 'idle'
    else 'active'
  end::public.presence_status;
$$;

-- Copied from 20261020195000_tamper_policy; + on_leave.
create or replace function internal.status_input(p_user_id uuid, p_now timestamptz)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'clocked_in', (s).state <> 'off_shift',
    'tamper', internal.capture_blocked(p_user_id, p.screen_permission, p.camera_permission),
    'offline', coalesce(p.last_contact_at, '-infinity'::timestamptz) < p_now - internal.offline_after(),
    'on_break', (s).state = 'on_break',
    'paused', (s).state = 'paused',
    'locked', p.locked,
    'last_checkin', p.last_checkin_outcome,
    'in_call', cardinality(p.call_sources) > 0,
    'idle', p.idle,
    'on_leave', internal.on_leave_at(p_user_id, p_now)
  )
  from public.presence p
  cross join lateral (select internal.shift_state(p_user_id) as s) st
  where p.user_id = p_user_id;
$$;

-- Copied from 20261019143352_status_engine; On leave is not clocked in either.
create or replace function internal.offline_sweep()
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
  n int := 0;
begin
  for r in
    select p.user_id, p.last_contact_at
    from public.presence p
    where p.status not in ('off_shift', 'offline', 'on_leave')
      and p.last_contact_at < now() - internal.offline_after()
  loop
    if internal.refresh_presence(r.user_id, r.last_contact_at + internal.offline_after()) = 'offline' then
      n := n + 1;
    end if;
  end loop;
  return n;
end;
$$;

-- Every minute: people who aren't clocked in and whose On leave state changed (a leave or
-- holiday began or ended, a local midnight passed) get their status recomputed. Returns
-- how many changed.
create function internal.leave_sweep()
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
  n int := 0;
begin
  if not pg_try_advisory_xact_lock(hashtext('leave_sweep')) then
    return 0;
  end if;
  for r in
    select p.user_id, p.status
    from public.presence p
    where p.status in ('off_shift', 'on_leave')
      and (p.status = 'on_leave') <> internal.on_leave_at(p.user_id, now())
  loop
    if internal.refresh_presence(r.user_id, now()) is distinct from r.status then
      n := n + 1;
    end if;
  end loop;
  return n;
end;
$$;

revoke all on function internal.leave_sweep() from public, anon, authenticated;

select cron.schedule('leave_sweep', '* * * * *', 'select internal.leave_sweep()');

-- Late clock-ins (copied from 20261022150000_digest_top_apps; a shift that starts on leave
-- is not late) ------------------------------------------------------------------------------

create or replace function internal.record_late_clock_in(p_session public.clock_sessions)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_grace int;
begin
  select internal.alert_policy_int(o.policy, 'late_clock_in_min', 15, 5, 60) into v_grace
  from public.orgs o where o.id = p_session.org_id;

  -- A session that covers a recorded shift start (it came in late, out of order) means
  -- the person was on time after all.
  delete from public.late_clock_ins l
  where l.user_id = p_session.user_id
    and l.clock_session_id <> p_session.id
    and p_session.start_at <= l.shift_start + make_interval(mins => l.grace_min)
    and coalesce(p_session.end_at, 'infinity'::timestamptz) > l.shift_start;

  insert into public.late_clock_ins (org_id, user_id, clock_session_id, day, shift_start,
    clocked_in_at, late_s, grace_min)
  select p_session.org_id, p_session.user_id, p_session.id, o.day, o.starts_at,
         p_session.start_at,
         floor(extract(epoch from p_session.start_at - o.starts_at))::int, v_grace
  from public.shifts s
  cross join lateral (
    select unnest(array[(p_session.start_at at time zone s.timezone)::date - 1,
                        (p_session.start_at at time zone s.timezone)::date]) as day
  ) d
  cross join lateral (
    select d.day,
           (d.day + s.start_time) at time zone s.timezone as starts_at,
           ((d.day + case when s.end_time <= s.start_time then 1 else 0 end) + s.end_time)
             at time zone s.timezone as ends_at
  ) o
  where s.user_id = p_session.user_id
    and extract(isodow from d.day)::int = any (s.days)
    and p_session.start_at > o.starts_at + make_interval(mins => v_grace)
    and p_session.start_at < o.ends_at
    and not exists (
      select 1 from public.clock_sessions cs
      where cs.user_id = p_session.user_id
        and cs.id <> p_session.id
        and cs.start_at <= o.starts_at + make_interval(mins => v_grace)
        and coalesce(cs.end_at, 'infinity'::timestamptz) > o.starts_at
    )
    -- LV-04: a shift that starts on an approved leave or a holiday is not late.
    and not internal.on_leave_at(p_session.user_id, o.starts_at)
  on conflict on constraint late_clock_ins_one_per_shift do update
    set clock_session_id = excluded.clock_session_id,
        clocked_in_at = excluded.clocked_in_at,
        late_s = excluded.late_s
    where excluded.clocked_in_at < public.late_clock_ins.clocked_in_at;
end;
$$;

-- Alerts (copied from 20261020192000_tamper_reason; late clock-in and offline skip leave) ---

create or replace function internal.alert_eval(p_now timestamptz default now())
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
  v_n int := 0;
  -- Conditions older than this when first seen are not raised.
  v_recent interval := interval '1 hour';
begin
  -- A slow run must not overlap the next one.
  if not pg_try_advisory_xact_lock(hashtext('alert_eval')) then
    return 0;
  end if;

  -- N consecutive misses -------------------------------------------------------------
  for r in
    select u.id as user_id, o.policy,
           run.misses, run.first_miss_id, run.first_miss_at, n.n as threshold
    from public.users u
    join public.orgs o on o.id = u.org_id
    cross join lateral (
      select internal.alert_policy_int(o.policy, 'alert_consecutive_misses', 3, 1, 10) as n
    ) n
    cross join lateral (
      select cs.start_at from public.clock_sessions cs
      where cs.user_id = u.id order by cs.start_at desc limit 1
    ) cs
    cross join lateral (
      with last_ok as (
        select max(c.scheduled_at) as at
        from public.checkin_events c
        where c.user_id = u.id and c.scheduled_at >= cs.start_at and c.outcome <> 'miss'
      ),
      misses as (
        select c.id, c.scheduled_at, c.created_at
        from public.checkin_events c, last_ok
        where c.user_id = u.id and c.scheduled_at >= cs.start_at and c.outcome = 'miss'
          and (last_ok.at is null or c.scheduled_at > last_ok.at)
      )
      select count(*)::int as misses,
             (array_agg(m.id order by m.scheduled_at))[1] as first_miss_id,
             min(m.scheduled_at) as first_miss_at,
             max(m.created_at) as last_seen_at
      from misses m
    ) run
    where u.active
      and internal.alert_enabled(o.policy, 'consecutive_misses')
      and run.misses >= n.n
      and run.last_seen_at > p_now - v_recent
  loop
    v_n := v_n + internal.raise_alert(r.user_id, 'consecutive_misses', r.first_miss_id::text,
      jsonb_build_object('misses', r.misses, 'threshold', r.threshold,
                         'first_miss_at', r.first_miss_at), p_now);
  end loop;

  -- Offline during a shift --------------------------------------------------------------
  for r in
    select p.user_id, p.since, m.minutes
    from public.presence p
    join public.users u on u.id = p.user_id
    join public.orgs o on o.id = u.org_id
    cross join lateral (
      select internal.alert_policy_int(o.policy, 'alert_offline_min', 15, 5, 240) as minutes
    ) m
    where p.status = 'offline' and u.active
      and internal.alert_enabled(o.policy, 'offline')
      and p.since <= p_now - make_interval(mins => m.minutes)
      and exists (
        select 1 from public.clock_sessions cs where cs.user_id = p.user_id and cs.end_at is null
      )
      -- LV-04: no offline alert for an Offline period that began on leave.
      and not internal.on_leave_at(p.user_id, p.since)
  loop
    v_n := v_n + internal.raise_alert(r.user_id, 'offline',
      (extract(epoch from r.since) * 1000000)::bigint::text,
      jsonb_build_object('since', r.since, 'threshold_min', r.minutes), p_now);
  end loop;

  -- Tamper -----------------------------------------------------------------------------
  for r in
    select sp.id, sp.user_id, sp.start_at, sp.end_at, sp.reason
    from public.status_periods sp
    join public.users u on u.id = sp.user_id
    join public.orgs o on o.id = u.org_id
    where sp.status = 'tamper' and u.active
      and internal.alert_enabled(o.policy, 'tamper')
      and (sp.end_at is null or sp.end_at > p_now - v_recent)
  loop
    v_n := v_n + internal.raise_alert(r.user_id, 'tamper', r.id::text,
      jsonb_build_object('since', r.start_at, 'until', r.end_at, 'reason', r.reason), p_now);
  end loop;

  -- Late clock-in -----------------------------------------------------------------------
  -- Shift occurrences that started today or yesterday in the shift's own time zone
  -- (a shift past midnight belongs to the day it starts on).
  for r in
    select u.id as user_id, g.grace, s.start_at
    from public.users u
    join public.orgs o on o.id = u.org_id
    join public.shifts sh on sh.user_id = u.id
    cross join lateral (
      select internal.alert_policy_int(o.policy, 'late_clock_in_min', 15, 5, 60) as grace
    ) g
    cross join lateral (
      select unnest(array[(p_now at time zone sh.timezone)::date - 1,
                          (p_now at time zone sh.timezone)::date]) as day
    ) d
    cross join lateral (
      select ((d.day + sh.start_time) at time zone sh.timezone) as start_at,
             (((d.day + case when sh.end_time < sh.start_time then 1 else 0 end) + sh.end_time)
                at time zone sh.timezone) as end_at
    ) s
    where u.active
      and internal.alert_enabled(o.policy, 'late_clock_in')
      and extract(isodow from d.day)::int = any (sh.days)
      and p_now >= s.start_at + make_interval(mins => g.grace)
      and p_now < s.end_at
      and exists (
        select 1 from public.devices dv where dv.user_id = u.id and dv.revoked_at is null
      )
      and not exists (
        select 1 from public.clock_sessions cs
        where cs.user_id = u.id
          and cs.start_at <= s.start_at + make_interval(mins => g.grace)
          and (cs.end_at is null or cs.end_at > s.start_at)
      )
      -- LV-04: a shift that starts on leave or a holiday is not late.
      and not internal.on_leave_at(u.id, s.start_at)
  loop
    v_n := v_n + internal.raise_alert(r.user_id, 'late_clock_in',
      (extract(epoch from r.start_at) * 1000000)::bigint::text,
      jsonb_build_object('shift_start', r.start_at, 'grace_min', r.grace), p_now);
  end loop;

  -- Pause time over the daily cap ---------------------------------------------------------
  for r in
    select t.user_id, t.day, t.total_s, pol.pause_daily_max_min as cap_min
    from (
      select p.user_id, p.org_id,
             (p.start_at at time zone u.timezone)::date as day,
             sum(floor(extract(epoch from coalesce(p.end_at, p_now) - p.start_at)))::int as total_s
      from public.pauses p
      join public.users u on u.id = p.user_id
      where u.active
        and exists (
          select 1 from public.pauses recent
          where recent.user_id = p.user_id
            and coalesce(recent.end_at, p_now) > p_now - v_recent
            and (recent.start_at at time zone u.timezone)::date
              = (p.start_at at time zone u.timezone)::date
        )
      group by p.user_id, p.org_id, (p.start_at at time zone u.timezone)::date
    ) t
    join public.orgs o on o.id = t.org_id
    cross join lateral internal.break_pause_policy(t.org_id) pol
    where internal.alert_enabled(o.policy, 'pause_over_cap')
      and t.total_s > pol.pause_daily_max_min * 60
  loop
    v_n := v_n + internal.raise_alert(r.user_id, 'pause_over_cap', r.day::text,
      jsonb_build_object('day', r.day, 'total_s', r.total_s, 'cap_min', r.cap_min), p_now);
  end loop;

  perform internal.queue_alert_emails(p_now);
  return v_n;
end;
$$;

-- The agent's config (copied from 20261031150000_tray_task_picker; + leave) ------------------

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
      -- LV-04 (SHF-03): approved leave and the holidays that apply, from yesterday on; no
      -- auto clock-in inside one.
      'leave', internal.leave_spans(u.id, now() - interval '1 day'),
      'shifts', coalesce((
        select jsonb_agg(jsonb_build_object('days', s.days, 'start', to_char(s.start_time, 'HH24:MI'),
          'end', to_char(s.end_time, 'HH24:MI'), 'timezone', s.timezone) order by s.start_time, s.days)
        from public.shifts s where s.user_id = u.id
      ), '[]'::jsonb),
      -- PRJ-02: what the person can pick in the tray and on the card; #268 (PRJ-05): with
      -- each project's active tasks in their order, for the tray's task picker.
      'projects', coalesce((
        select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name, 'client', c.name,
          'tasks', coalesce((
            select jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name, 'sort_order', t.sort_order)
              order by t.sort_order, lower(t.name), t.id)
            from public.project_tasks t
            where t.project_id = p.id and not t.archived
          ), '[]'::jsonb))
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

-- Retention (copied from 20261101200000_timesheet_comments; + leave_requests) -----------------

create or replace function public.retention_purge_rows()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  o record;
  n bigint;
  v_counts jsonb;
  v_from bigint := coalesce((select max(id) from public.retention_runs), 0);
  v_longest timestamptz := now() - make_interval(
    months => coalesce((select max(internal.event_retention_months(policy)) from public.orgs), 12));
  v_events timestamptz;
  v_timesheets timestamptz;
  v_day date;
begin
  for o in select id, policy from public.orgs loop
    v_events := now() - make_interval(months => internal.event_retention_months(o.policy));
    v_timesheets := now() - make_interval(years => internal.timesheet_retention_years(o.policy));
    v_day := (v_timesheets at time zone 'UTC')::date - 1;
    v_counts := '{}'::jsonb;

    if v_events > v_longest then
      delete from public.agent_events_raw where org_id = o.id and at < v_events;
      get diagnostics n = row_count;
      v_counts := v_counts || jsonb_build_object('agent_events_raw', n);
      delete from public.activity_samples where org_id = o.id and minute < v_events;
      get diagnostics n = row_count;
      v_counts := v_counts || jsonb_build_object('activity_samples', n);
    end if;

    -- A check-in whose files are still in Storage stays until they are gone.
    delete from public.checkin_events
    where org_id = o.id and scheduled_at < v_events
      and (cardinality(object_keys) = 0 or captures_purged_at is not null);
    get diagnostics n = row_count;
    v_counts := v_counts || jsonb_build_object('checkin_events', n);

    -- Closed periods only: an open one is the user's current state.
    delete from public.status_periods
    where org_id = o.id and end_at is not null and end_at < v_events;
    get diagnostics n = row_count;
    v_counts := v_counts || jsonb_build_object('status_periods', n);

    delete from public.agent_event_rejections r
    using public.devices d
    where d.id = r.device_id and d.org_id = o.id and r.received_at < v_events;
    get diagnostics n = row_count;
    v_counts := v_counts || jsonb_build_object('agent_event_rejections', n);

    -- Shift records are what timesheets are built from, so they keep the
    -- timesheet window. Breaks and pauses go first for their own counts.
    delete from public.breaks b
    using public.clock_sessions s
    where s.id = b.clock_session_id and s.org_id = o.id
      and s.end_at is not null and s.end_at < v_timesheets;
    get diagnostics n = row_count;
    v_counts := v_counts || jsonb_build_object('breaks', n);
    delete from public.pauses p
    using public.clock_sessions s
    where s.id = p.clock_session_id and s.org_id = o.id
      and s.end_at is not null and s.end_at < v_timesheets;
    get diagnostics n = row_count;
    v_counts := v_counts || jsonb_build_object('pauses', n);
    delete from public.clock_sessions
    where org_id = o.id and end_at is not null and end_at < v_timesheets;
    get diagnostics n = row_count;
    v_counts := v_counts || jsonb_build_object('clock_sessions', n);

    -- Timesheet window (#130). Whole days and weeks only, and only once they ended
    -- everywhere before the cutoff: v_day is the UTC date of the cutoff less one day,
    -- so a local day (UTC-12 to UTC+14) or a week of them is over by then. Children
    -- before parents. A draft or submitted week that old goes too: nobody can still
    -- approve three years on, and the window is the promise made to the org.
    delete from public.dirty_days d
    using public.users u
    where u.id = d.user_id and u.org_id = o.id and d.day < v_day;
    get diagnostics n = row_count;
    v_counts := v_counts || jsonb_build_object('dirty_days', n);

    delete from public.time_segments where org_id = o.id and day < v_day;
    get diagnostics n = row_count;
    v_counts := v_counts || jsonb_build_object('time_segments', n);

    -- Reminder bookkeeping of a week (kept by its week, like the sheet it was about).
    delete from public.reminders_sent where org_id = o.id and period_start + 6 < v_day;
    get diagnostics n = row_count;
    v_counts := v_counts || jsonb_build_object('reminders_sent', n);

    -- #265: a week's comments go with it.
    delete from public.timesheet_comments c
    using public.timesheets t
    where t.id = c.timesheet_id and c.org_id = o.id and t.period_start + 6 < v_day;
    get diagnostics n = row_count;
    v_counts := v_counts || jsonb_build_object('timesheet_comments', n);
    delete from public.timesheet_edits e
    using public.timesheets t
    where t.id = e.timesheet_id and e.org_id = o.id and t.period_start + 6 < v_day;
    get diagnostics n = row_count;
    v_counts := v_counts || jsonb_build_object('timesheet_edits', n);
    delete from public.timesheets where org_id = o.id and period_start + 6 < v_day;
    get diagnostics n = row_count;
    v_counts := v_counts || jsonb_build_object('timesheets', n);

    -- By end time, whatever the status: a pending request is as old as the others.
    delete from public.manual_entries where org_id = o.id and end_at < v_timesheets;
    get diagnostics n = row_count;
    v_counts := v_counts || jsonb_build_object('manual_entries', n);

    -- #304 (LV-07): time-off requests keep the timesheet window too, by end time.
    delete from public.leave_requests where org_id = o.id and end_at < v_timesheets;
    get diagnostics n = row_count;
    v_counts := v_counts || jsonb_build_object('leave_requests', n);

    -- In-app notifications are transient, so they follow the events window, not
    -- the timesheet one.
    delete from public.notifications where org_id = o.id and created_at < v_events;
    get diagnostics n = row_count;
    v_counts := v_counts || jsonb_build_object('notifications', n);

    -- Messages (#185), on the events window like notifications. Alerts first: they
    -- point at their email (on delete set null), and an alert is always older than
    -- its email, so none outlives the email it went out in.
    delete from public.alerts where org_id = o.id and triggered_at < v_events;
    get diagnostics n = row_count;
    v_counts := v_counts || jsonb_build_object('alerts', n);

    -- Only mail that is done: sent, or given up on (5 attempts, see email_claim). A
    -- row still waiting to go out stays however old, so nothing undelivered is lost.
    delete from public.email_outbox
    where org_id = o.id and created_at < v_events
      and (sent_at is not null or attempts >= 5);
    get diagnostics n = row_count;
    v_counts := v_counts || jsonb_build_object('email_outbox', n);

    -- The rebuild log (when each employee-day was last rebuilt) only matters while a
    -- day can still be rebuilt, which needs its raw events: the events window. The
    -- kick only looks at days of an open shift, so a purged entry is never read.
    delete from internal.segment_rebuilds r
    using public.users u
    where u.id = r.user_id and u.org_id = o.id and r.rebuilt_at < v_events;
    get diagnostics n = row_count;
    v_counts := v_counts || jsonb_build_object('segment_rebuilds', n);

    perform internal.log_retention(o.id, v_counts);
  end loop;

  return coalesce((
    select jsonb_object_agg(category, total)
    from (
      select category, sum(deleted)::bigint as total
      from public.retention_runs where id > v_from and org_id is not null
      group by category
    ) t
  ), '{}'::jsonb);
end;
$$;

-- Deletion (copied from 20261101200000_timesheet_comments; + leave_requests) ------------------

create or replace function internal.delete_user_data(p_actor_id uuid, p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user public.users;
  v_counts jsonb := '{}'::jsonb;
  v_n bigint;
begin
  select * into v_user from public.users u where u.id = p_user_id for update;
  if not found then
    raise exception 'user_not_found' using errcode = '42501';
  end if;
  if exists (
    select 1 from storage.objects o
    where o.bucket_id = 'captures'
      and starts_with(o.name, v_user.org_id::text || '/' || v_user.id::text || '/')
  ) then
    raise exception 'captures_remain' using errcode = '55000';
  end if;

  -- Raw agent data and what was computed from it.
  delete from public.agent_events_raw where user_id = p_user_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('agent_events', v_n);
  delete from public.activity_samples where user_id = p_user_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('activity_samples', v_n);
  delete from public.agent_event_rejections
  where device_id in (select d.id from public.devices d where d.user_id = p_user_id);
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('agent_event_rejections', v_n);
  delete from public.checkin_events where user_id = p_user_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('checkin_events', v_n);
  delete from public.status_periods where user_id = p_user_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('status_periods', v_n);
  delete from public.time_segments where user_id = p_user_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('time_segments', v_n);
  delete from internal.segment_rebuilds where user_id = p_user_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('segment_rebuilds', v_n);
  delete from public.anticheat_flags where user_id = p_user_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('anticheat_flags', v_n);

  -- Clock sessions and what hangs off them.
  delete from public.pauses where user_id = p_user_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('pauses', v_n);
  delete from public.breaks where user_id = p_user_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('breaks', v_n);
  delete from public.clock_sessions where user_id = p_user_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('clock_sessions', v_n);

  -- Timesheets and the edits and entries on them.
  delete from public.timesheet_comments where user_id = p_user_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('timesheet_comments', v_n);
  delete from public.timesheet_edits where user_id = p_user_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('timesheet_edits', v_n);
  delete from public.manual_entries where user_id = p_user_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('manual_entries', v_n);
  -- #304 (LV-07): their time-off requests.
  delete from public.leave_requests where user_id = p_user_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('leave_requests', v_n);
  delete from public.timesheets where user_id = p_user_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('timesheets', v_n);

  -- Messages: about them or to them, and the emails behind the alerts and reminders.
  delete from public.alerts where user_id = p_user_id or recipient_id = p_user_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('alerts', v_n);
  delete from public.reminders_sent where user_id = p_user_id or recipient_id = p_user_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('reminders_sent', v_n);
  delete from public.notifications where user_id = p_user_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('notifications', v_n);
  delete from public.email_outbox
  where org_id = v_user.org_id
    and (lower(to_email) = lower(v_user.email) or payload ->> 'employee_id' = p_user_id::text);
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('email_outbox', v_n);

  -- Their own settings and acknowledgements, and delegations in either direction (a
  -- delegation to or from them ends with them).
  delete from public.notice_acks where user_id = p_user_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('notice_acks', v_n);
  delete from public.project_members where user_id = p_user_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('project_members', v_n);
  delete from public.shifts where user_id = p_user_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('shifts', v_n);
  delete from public.delegations where manager_id = p_user_id or delegate_id = p_user_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('delegations', v_n);
  delete from public.presence where user_id = p_user_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('presence', v_n);
  delete from public.last_seen where user_id = p_user_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('last_seen', v_n);

  -- Devices and sign-in sessions (ending the sessions revokes the refresh tokens).
  perform internal.end_sessions(array(select s.id from auth.sessions s where s.user_id = p_user_id));
  delete from public.device_sessions where user_id = p_user_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('device_sessions', v_n);
  delete from public.devices where user_id = p_user_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('devices', v_n);

  -- Last of the data: the dirty-day marks the deletes above may have left.
  delete from public.dirty_days where user_id = p_user_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('dirty_days', v_n);

  -- The tombstone (AUD-01), written while the names can still be snapshotted. No email.
  perform internal.audit(v_user.org_id, p_actor_id, 'user_data.deleted', v_user.id,
    jsonb_build_object('role', v_user.role, 'counts', v_counts));

  -- The person: the users row (anything with a cascading key to it goes too), then the
  -- Auth account, which frees the email address and ends sign-in for good.
  delete from public.users where id = v_user.id;
  delete from auth.users where id = v_user.id;
  return v_counts;
end;
$$;
