-- Timesheet reminders and escalation emails (#46; TS-17).
--
-- reminders_eval runs every 15 minutes (pg_cron job `reminders`; the LLD lists the
-- job, this is its schedule). It is plain SQL with no secrets: it writes in-app
-- `notifications` rows and `email_outbox` rows (template reminder_*), and the
-- send_emails job (#50) delivers them. The #50 alert batching is not involved.
--
-- Three reminders, each sent once:
--   submit      The employee, on the last day of their week at 16:00 in their own
--               time zone (the week is seven local days from the org's
--               policy.week_start, as for timesheets). Sent when the week has no
--               submitted or approved timesheet (draft, returned or not created
--               yet) and the person had time in it: a clock session or counted,
--               not excluded, time. People with no time are not nagged. People who
--               cannot submit (they need a manager and have none) are skipped. A
--               person whose approval is not required is still reminded: they
--               submit to get the week approved (TS-16). If the run was late the
--               reminder still goes out for 24 hours after 16:00.
--   approval    48 hours after a timesheet was submitted, if it is still
--               submitted: to the direct manager and to any active delegate of
--               that manager (one reminder each).
--   escalation  5 days after submission (the 2 days plus a further 3), if it is
--               still submitted: to every active owner and admin of the org except
--               the employee. Notify only: admins still cannot approve (TS-12).
-- Approval and escalation are durations. So that nobody is mailed at night, a
-- reminder due outside 09:00-18:00 in the recipient's time zone waits for the next
-- 09:00 there (reminder_send_at). Each recipient gets theirs on their own clock.
-- "Submitted" counts from the later of submitted_at and the latest reopen
-- (timesheet.reopened in the audit log): reopening an approved week (TS-18) starts
-- the clock again instead of escalating at once. A week the employee submits again
-- after a return is a new submission with its own reminders (the episode).
--
-- reminders_sent keeps the dedupe key (kind, recipient, employee, week, episode),
-- where the episode is the submission's start for approval and escalation.

create table public.reminders_sent (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  kind text not null check (kind in ('submit', 'approval', 'escalation')),
  -- The employee the reminder is about, and their week (its first local day).
  user_id uuid not null references public.users (id) on delete cascade,
  period_start date not null,
  -- Null while the week has no timesheet row (a submit reminder).
  timesheet_id uuid references public.timesheets (id) on delete set null,
  recipient_id uuid not null references public.users (id) on delete cascade,
  -- approval and escalation: when the submission began, in epoch microseconds, so a
  -- week submitted again after a return is reminded afresh. submit: ''.
  episode text not null default '',
  sent_at timestamptz not null default now(),
  constraint reminders_sent_once unique (kind, recipient_id, user_id, period_start, episode)
);

create index reminders_sent_user_idx on public.reminders_sent (user_id, period_start);
alter table public.reminders_sent enable row level security;
-- Internal bookkeeping: no policies, no grants.
revoke all on public.reminders_sent from anon, authenticated;

-- When a reminder that came due at p_due goes out for a recipient in p_tz: at once
-- inside 09:00-18:00 local, else at the next 09:00.
create function internal.reminder_send_at(p_due timestamptz, p_tz text)
returns timestamptz
language sql
stable
set search_path = ''
as $$
  select case
    when l::time < time '09:00' then (l::date + time '09:00') at time zone p_tz
    when l::time >= time '18:00' then ((l::date + 1) + time '09:00') at time zone p_tz
    else p_due
  end
  from (select p_due at time zone p_tz as l) x;
$$;

-- Records one reminder and, if it is new, writes the in-app notification and queues
-- the email. Returns true when it did. p_extra goes into both payloads.
create function internal.queue_reminder(
  p_kind text,
  p_employee_id uuid,
  p_recipient_id uuid,
  p_timesheet_id uuid,
  p_period_start date,
  p_episode text,
  p_extra jsonb,
  p_now timestamptz default now()
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rec public.users;
  v_emp public.users;
  v_id uuid;
  v_payload jsonb;
begin
  select * into v_rec from public.users u where u.id = p_recipient_id and u.active;
  select * into v_emp from public.users u where u.id = p_employee_id;
  if v_rec.id is null or v_emp.id is null then
    return false;
  end if;

  insert into public.reminders_sent (org_id, kind, user_id, period_start, timesheet_id,
    recipient_id, episode, sent_at)
  values (v_emp.org_id, p_kind, v_emp.id, p_period_start, p_timesheet_id, v_rec.id,
    coalesce(p_episode, ''), p_now)
  on conflict on constraint reminders_sent_once do nothing
  returning id into v_id;
  if v_id is null then
    return false;
  end if;

  v_payload := jsonb_build_object(
    'timesheet_id', p_timesheet_id,
    'period_start', p_period_start,
    'period_end', p_period_start + 6,
    'employee_id', v_emp.id,
    'employee_name', v_emp.full_name
  ) || coalesce(p_extra, '{}'::jsonb);

  perform internal.notify(v_rec.org_id, v_rec.id,
    case p_kind when 'submit' then 'timesheet.submit_reminder'
                when 'approval' then 'timesheet.approval_reminder'
                else 'timesheet.escalation' end,
    v_payload);

  insert into public.email_outbox (org_id, to_email, template, payload, batch_key, created_at, send_after)
  values (
    v_rec.org_id, v_rec.email, 'reminder_' || p_kind,
    v_payload || jsonb_build_object(
      'recipient_name', v_rec.full_name,
      'recipient_timezone', v_rec.timezone
    ),
    'reminder:' || p_kind || ':' || v_rec.id || ':' || v_emp.id || ':' || p_period_start
      || ':' || coalesce(p_episode, ''),
    p_now, p_now
  );
  return true;
end;
$$;

-- The evaluation (every 15 minutes). Returns the number of reminders queued. `p_now`
-- is for tests; cron uses the default.
create function internal.reminders_eval(p_now timestamptz default now())
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
  v_n int := 0;
begin
  -- A slow run must not overlap the next one.
  if not pg_try_advisory_xact_lock(hashtext('reminders_eval')) then
    return 0;
  end if;

  -- Employee: submit your week ----------------------------------------------------------
  -- Candidate weeks: the one the employee's local date is in and the one before it, so
  -- a 24 hour window that crosses local midnight still finds its week.
  for r in
    select u.id as user_id, w.wk as period_start, (
      select t.id from public.timesheets t
      where t.user_id = u.id and t.period_start = w.wk
    ) as timesheet_id
    from public.users u
    cross join lateral (
      select (p_now at time zone u.timezone)::date as today
    ) l
    cross join lateral (
      select unnest(array[internal.week_start(u.org_id, l.today),
                          internal.week_start(u.org_id, l.today) - 7]) as wk
    ) w
    cross join lateral (
      select (w.wk + 6 + time '16:00') at time zone u.timezone as fire_at,
             (w.wk::timestamp) at time zone u.timezone as week_from,
             ((w.wk + 7)::timestamp) at time zone u.timezone as week_to
    ) f
    where u.active
      and w.wk is not null
      and p_now >= f.fire_at and p_now < f.fire_at + interval '24 hours'
      -- Only people who can submit (submit_timesheet: a manager, or auto-approval).
      and (u.manager_id is not null or not u.approval_required or u.role = 'owner')
      and not exists (
        select 1 from public.timesheets t
        where t.user_id = u.id and t.status in ('submitted', 'approved')
          and t.period_start < w.wk + 7 and t.period_start + 7 > w.wk
      )
      and (
        exists (
          select 1 from public.clock_sessions cs
          where cs.user_id = u.id and cs.start_at < f.week_to
            and coalesce(cs.end_at, 'infinity') > f.week_from
        )
        or exists (
          select 1 from public.time_segments s
          where s.user_id = u.id and s.day >= w.wk and s.day < w.wk + 7
            and s.counted and not s.excluded
        )
      )
  loop
    if internal.queue_reminder('submit', r.user_id, r.user_id, r.timesheet_id, r.period_start,
         '', '{}'::jsonb, p_now) then
      v_n := v_n + 1;
    end if;
  end loop;

  -- Manager: a week has waited 2 days ---------------------------------------------------
  -- The direct manager and the manager's active delegates (as for alerts).
  for r in
    select t.id as timesheet_id, t.user_id, t.period_start,
           w.since, rec.id as recipient_id
    from public.timesheets t
    join public.users e on e.id = t.user_id
    cross join lateral (
      select greatest(t.submitted_at, (
        select max(a.at) from public.audit_log a
        where a.target_user_id = t.user_id and a.action = 'timesheet.reopened'
          and a.metadata ->> 'timesheet_id' = t.id::text
      )) as since
    ) w
    cross join lateral (
      select e.manager_id as id where e.manager_id is not null
      union
      select d.delegate_id
      from public.delegations d
      where d.manager_id = e.manager_id
        and (p_now at time zone 'UTC')::date between d.starts_on and d.ends_on
    ) rec
    join public.users ru on ru.id = rec.id and ru.active and ru.org_id = t.org_id
      and ru.id <> t.user_id
    where t.status = 'submitted' and w.since is not null
      and p_now >= internal.reminder_send_at(w.since + interval '48 hours', ru.timezone)
  loop
    if internal.queue_reminder('approval', r.user_id, r.recipient_id, r.timesheet_id,
         r.period_start, (extract(epoch from r.since) * 1000000)::bigint::text,
         jsonb_build_object('submitted_at', r.since), p_now) then
      v_n := v_n + 1;
    end if;
  end loop;

  -- Admins: a week has waited 5 days (notify only) --------------------------------------
  for r in
    select t.id as timesheet_id, t.user_id, t.period_start, w.since,
           ad.id as recipient_id, m.id as manager_id, m.full_name as manager_name
    from public.timesheets t
    join public.users e on e.id = t.user_id
    left join public.users m on m.id = e.manager_id
    cross join lateral (
      select greatest(t.submitted_at, (
        select max(a.at) from public.audit_log a
        where a.target_user_id = t.user_id and a.action = 'timesheet.reopened'
          and a.metadata ->> 'timesheet_id' = t.id::text
      )) as since
    ) w
    join public.users ad on ad.org_id = t.org_id and ad.active
      and ad.role in ('owner', 'admin') and ad.id <> t.user_id
    where t.status = 'submitted' and w.since is not null
      and p_now >= internal.reminder_send_at(w.since + interval '5 days', ad.timezone)
  loop
    if internal.queue_reminder('escalation', r.user_id, r.recipient_id, r.timesheet_id,
         r.period_start, (extract(epoch from r.since) * 1000000)::bigint::text,
         jsonb_build_object('submitted_at', r.since, 'manager_id', r.manager_id,
                            'manager_name', r.manager_name), p_now) then
      v_n := v_n + 1;
    end if;
  end loop;

  return v_n;
end;
$$;

revoke all on function internal.reminder_send_at(timestamptz, text) from public, anon, authenticated;
revoke all on function internal.queue_reminder(text, uuid, uuid, uuid, date, text, jsonb, timestamptz) from public, anon, authenticated;
revoke all on function internal.reminders_eval(timestamptz) from public, anon, authenticated;

select cron.schedule('reminders', '*/15 * * * *', 'select internal.reminders_eval()');
