-- #264 (#254 part 5, TS-34): favourite rows on the week grid, and copying last week.
--
-- Favourite rows: a project, and optionally one of its tasks, that the person pins so it is
-- a row of every week's grid (TS-32). Pinned per person and kept here, so they follow the
-- person across devices. Only the person reads or changes their own (row-level security on
-- reads; writes through set_timesheet_favourite). A pin is a preference, not time: it isn't
-- audit-logged, retention leaves it alone, and it goes with the person (deletion cascades
-- from users, and the data export lists it), with the project or with the task. A project
-- the person can no longer log to keeps its pin, and the grid ignores it.
--
-- Copying last week: the grid copies last week's rows itself (they need no time). With
-- "include hours" it copies last week's manual entries too, through
-- copy_week_manual_entries: each chosen entry of the caller's previous week (pending or
-- approved; rejected time isn't copied) becomes a new request seven local days later, at
-- the same local times, with the same project, task, reason and note. Each one goes through
-- internal.create_manual_entry, the body of request_manual_entry, so it follows every rule
-- of a request (TS-07..09, TS-24): pending unless the person needs no approval (TS-16),
-- not in the future, a project they can log to and a task of it, no overlap with clocked
-- time or other entries, nothing in an approved week (TS-18); and it is audit-logged as a
-- request (manual_entry.requested, with copied_from). An entry that breaks a rule is
-- skipped with that rule's code, in its own subtransaction, so nothing of it stays; every
-- other error fails the whole call. The week copied into must be the caller's own and open
-- for their changes (a draft or returned week, as the grid allows, TS-30), checked once
-- for the call. One call does the lot, so the result lists every entry, copied or skipped.
--
-- No existing function is redefined.

-- Favourite rows ----------------------------------------------------------------------------

create table public.timesheet_favourites (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  org_id uuid not null references public.orgs (id) on delete cascade,
  project_id uuid not null references public.projects (id) on delete cascade,
  -- Null: the project's row without a task.
  task_id uuid references public.project_tasks (id) on delete cascade,
  created_at timestamptz not null default now(),
  unique nulls not distinct (user_id, project_id, task_id)
);
create index timesheet_favourites_project_idx on public.timesheet_favourites (project_id);
create index timesheet_favourites_task_idx on public.timesheet_favourites (task_id);
alter table public.timesheet_favourites enable row level security;

create policy "Own favourites"
on public.timesheet_favourites for select to authenticated
using (user_id = (select auth.uid()));

revoke all on public.timesheet_favourites from anon, authenticated;
grant select on public.timesheet_favourites to authenticated;

-- The caller pins (p_pinned) or unpins a row of their grid: a project they can log to and,
-- optionally, an active task of it. Unpinning needs neither, so a pin of a project they
-- have since left can go. At most 50 pins. Returns whether the row is now pinned.
create function public.set_timesheet_favourite(p_project_id uuid, p_task_id uuid, p_pinned boolean)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me public.users := internal.current_app_user();
begin
  if p_project_id is null or p_pinned is null then
    raise exception 'invalid_favourite' using errcode = '22023';
  end if;
  if not p_pinned then
    delete from public.timesheet_favourites f
    where f.user_id = v_me.id and f.project_id = p_project_id
      and f.task_id is not distinct from p_task_id;
    return false;
  end if;

  if internal.allowed_project(v_me.id, p_project_id::text) is null then
    raise exception 'project_not_allowed' using errcode = '22023';
  end if;
  if not internal.task_allowed(p_project_id, p_task_id) then
    raise exception 'task_not_allowed' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtext('timesheet_favourites:' || v_me.id::text));
  if (select count(*) from public.timesheet_favourites f where f.user_id = v_me.id) >= 50
    and not exists (
      select 1 from public.timesheet_favourites f
      where f.user_id = v_me.id and f.project_id = p_project_id
        and f.task_id is not distinct from p_task_id)
  then
    raise exception 'too_many_favourites' using errcode = '22023';
  end if;
  insert into public.timesheet_favourites (user_id, org_id, project_id, task_id)
  values (v_me.id, v_me.org_id, p_project_id, p_task_id)
  on conflict (user_id, project_id, task_id) do nothing;
  return true;
end;
$$;

revoke all on function public.set_timesheet_favourite(uuid, uuid, boolean) from public, anon;
grant execute on function public.set_timesheet_favourite(uuid, uuid, boolean) to authenticated;

-- Copying last week's entries -------------------------------------------------------------------

-- The caller copies `p_entry_ids`, manual entries of theirs that start in the week before
-- `p_week` (the start of one of their weeks), into `p_week` (see the header). Returns one
-- item per entry, in start order: {entry_id, start_at, end_at} and the new entry's `id`
-- when it was copied, or `skipped` with the rule's code. An id that isn't one of those
-- entries is skipped as entry_not_found.
create function public.copy_week_manual_entries(p_week date, p_entry_ids uuid[])
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me public.users := internal.current_app_user();
  v_zone text;
  v_from timestamptz;
  v_to timestamptz;
  v_e public.manual_entries;
  v_start timestamptz;
  v_end timestamptz;
  v_new uuid;
  v_code text;
  v_out jsonb := '[]'::jsonb;
  v_id uuid;
begin
  if p_week is null or p_entry_ids is null or cardinality(p_entry_ids) not between 1 and 200
    or internal.week_start(v_me.org_id, p_week) <> p_week
  then
    raise exception 'invalid_copy' using errcode = '22023';
  end if;
  -- The week copied into is the caller's own and open for their changes.
  perform internal.own_open_week(v_me, p_week);

  v_zone := v_me.timezone;
  v_from := (p_week - 7)::timestamp at time zone v_zone;
  v_to := p_week::timestamp at time zone v_zone;

  for v_e in
    select * from public.manual_entries me
    where me.id = any (p_entry_ids) and me.user_id = v_me.id
      and me.status in ('pending', 'approved')
      and me.start_at >= v_from and me.start_at < v_to
    order by me.start_at, me.id
  loop
    -- Seven local days later: the same weekday and wall-clock times.
    v_start := ((v_e.start_at at time zone v_zone) + interval '7 days') at time zone v_zone;
    v_end := ((v_e.end_at at time zone v_zone) + interval '7 days') at time zone v_zone;
    begin
      v_new := internal.create_manual_entry(v_me, v_me, v_start, v_end, v_e.project_id,
        v_e.reason, v_e.task_id, v_e.note, jsonb_build_object('copied_from', v_e.id));
      v_out := v_out || jsonb_build_array(jsonb_build_object('entry_id', v_e.id,
        'start_at', v_start, 'end_at', v_end, 'id', v_new));
    exception when sqlstate '22023' or sqlstate '23P01' or sqlstate '55000' then
      get stacked diagnostics v_code = message_text;
      v_out := v_out || jsonb_build_array(jsonb_build_object('entry_id', v_e.id,
        'start_at', v_start, 'end_at', v_end, 'skipped', v_code));
    end;
  end loop;

  for v_id in
    select distinct i from unnest(p_entry_ids) i
    where not exists (select 1 from jsonb_array_elements(v_out) o where (o ->> 'entry_id')::uuid = i)
  loop
    v_out := v_out || jsonb_build_array(jsonb_build_object('entry_id', v_id,
      'skipped', 'entry_not_found'));
  end loop;
  return v_out;
end;
$$;

revoke all on function public.copy_week_manual_entries(date, uuid[]) from public, anon;
grant execute on function public.copy_week_manual_entries(date, uuid[]) to authenticated;
