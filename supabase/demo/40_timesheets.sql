-- Demo seed (#351), step 4: timesheets in every state (TS-07..10), through the RPCs:
-- people tidy and submit their weeks, managers (or their delegate) decide flagged time,
-- edit, comment, return, approve and reopen. Runs once time_segments are current.
--   week 0 (this week)  draft
--   week 1              submitted / approved / returned / draft (not submitted yet)
--   week 2              mostly approved, some still submitted, one reopened
--   weeks 3-4           approved, some after a return and a resubmission
-- A week with a pending manual entry can't be approved (it stays submitted).

create function demo.decider(p_key text) returns text
language sql stable as $$
  -- Grace is away: Daniel decides for her team (delegation).
  select case when p.manager_key = 'grace' then 'daniel' else p.manager_key end
  from demo.people p where p.key = p_key;
$$;

create function demo.decide_flagged(p_ts uuid, p_decider text, p_key text) returns void
language plpgsql as $$
declare
  t public.timesheets;
  f record;
begin
  select * into t from public.timesheets where id = p_ts;
  perform demo.as_user(p_decider);
  for f in
    select * from public.timesheet_flagged_segments(t.user_id, t.period_start, t.period_start + 6)
    where decision is null and not excluded
    order by start_at
  loop
    if (hashtext(f.id::text) % 5) = 0 then
      perform public.edit_segment(p_ts, 'exclude', f.start_at, f.end_at, null, 'Not at the desk after the missed check-in');
    else
      perform public.edit_segment(p_ts, 'keep', f.start_at, f.end_at);
    end if;
  end loop;
  perform demo.as_postgres();
end;
$$;

do $$
declare
  r record;
  s record;
  v_ts uuid;
  v_start date;
  v_decider text;
  v_proj uuid;
  v_status text;
  v_failed int := 0;
begin
  for r in
    select sh.person, sh.week, sh.outcome, p.id as uid, p.tz, demo.decider(p.key) as decider
    from demo.sheets sh
    join demo.people p on p.key = sh.person
    join public.users u on u.id = p.id
    where u.active
    order by sh.week desc, sh.person
  loop
    v_start := (now() at time zone r.tz)::date;
    v_start := v_start - (extract(isodow from v_start)::int - 1) - 7 * r.week;
    perform demo.as_user(r.person);
    v_ts := public.ensure_timesheet(r.uid, v_start);

    -- The person moves a stretch to another project before submitting (TS-05).
    if (hashtext(r.person || r.week) % 9) = 0 then
      select ts.start_at, ts.project_id into s from public.time_segments ts
      where ts.user_id = r.uid and ts.day between v_start and v_start + 6 and ts.type = 'work' and not ts.flagged
        and ts.end_at - ts.start_at > interval '40 minutes'
      order by ts.start_at limit 1;
      select pm.project_id into v_proj from public.project_members pm join public.projects pr on pr.id = pm.project_id
      where pm.user_id = r.uid and not pr.archived and pm.project_id is distinct from s.project_id
      order by pr.name limit 1;
      if s.start_at is not null and v_proj is not null then
        perform public.reassign_my_time(s.start_at, s.start_at + interval '20 minutes', v_proj, 'Was on the other project, forgot to switch');
      end if;
    end if;
    -- A note on a day (TS-09).
    if (hashtext(r.person || r.week || 'note') % 6) = 0 then
      perform public.save_day_note(r.uid, v_start + 1, (array[
        'Dentist in the morning, made the time up in the evening',
        'Internet outage around lunch',
        'Covered for Aisha on the Umbrella queue',
        'Onboarding the new hire most of the day'])[1 + abs(hashtext(r.person)) % 4]);
    end if;

    if r.outcome = 'draft' then
      perform demo.as_postgres();
      continue;
    end if;

    v_status := public.submit_timesheet(v_ts);
    perform demo.as_postgres();
    if v_status = 'approved' then
      continue;
    end if;

    if r.outcome in ('returned', 'resubmitted') then
      perform demo.as_user(r.decider);
      perform public.return_timesheet(v_ts, case when r.outcome = 'returned'
        then 'Tuesday looks short; did you forget to clock in after lunch?'
        else 'Please check the project on Thursday afternoon.' end);
      perform demo.as_postgres();
      if r.outcome = 'resubmitted' then
        perform demo.as_user(r.person);
        perform public.add_timesheet_comment(v_ts, 'Fixed, thanks. Thursday was the Mobile app workshop.');
        perform public.submit_timesheet(v_ts);
        perform demo.as_postgres();
      end if;
    end if;

    if r.outcome in ('approved', 'resubmitted') then
      begin
        perform demo.decide_flagged(v_ts, r.decider, r.person);
        perform demo.as_user(r.decider);
        -- Now and then the manager corrects a project, or adds time they know about.
        if (hashtext(r.person || r.week || 'edit') % 7) = 0 then
          select ts.start_at, ts.project_id into s from public.time_segments ts
          where ts.user_id = r.uid and ts.day between v_start and v_start + 6 and ts.type = 'work' and not ts.flagged
            and ts.end_at - ts.start_at > interval '45 minutes'
          order by ts.start_at desc limit 1;
          select pm.project_id into v_proj from public.project_members pm join public.projects pr on pr.id = pm.project_id
          where pm.user_id = r.uid and not pr.archived and pm.project_id is distinct from s.project_id
          order by pr.name desc limit 1;
          if s.start_at is not null and v_proj is not null then
            perform public.edit_segment(v_ts, 'project', s.start_at, s.start_at + interval '30 minutes', v_proj,
              'That call was for the other client');
            perform public.add_timesheet_comment(v_ts, 'Moved the 30 min call to the right project.', v_proj);
          end if;
        end if;
        if (hashtext(r.person || r.week || 'adjust') % 11) = 0 then
          select cs.end_at, cs.project_id into s from public.clock_sessions cs
          where cs.user_id = r.uid and cs.end_at is not null
            and (cs.start_at at time zone r.tz)::date between v_start and v_start + 4
          order by cs.start_at limit 1;
          if s.end_at is not null and s.project_id is not null then
            perform public.adjust_time(v_ts, s.end_at + interval '20 minutes', s.end_at + interval '50 minutes',
              s.project_id, 'Customer call after hours, confirmed with them');
          end if;
        end if;
        perform public.approve_timesheet(v_ts);
        perform demo.as_postgres();
      exception when others then
        -- pending_entries / undecided_flagged: the week waits for the manager.
        perform demo.as_postgres();
        v_failed := v_failed + 1;
      end;
    end if;
  end loop;

  -- One approved week reopened by the manager (TS-10): back with them as submitted.
  select t.id, demo.decider(p.key) as decider into r
  from public.timesheets t join demo.people p on p.id = t.user_id
  where t.status = 'approved' and t.approver_id is not null
    and t.period_start = (select max(period_start) from public.timesheets) - 14
  order by p.key limit 1;
  if r.id is not null then
    perform demo.as_user(r.decider);
    perform public.reopen_timesheet(r.id, 'Payroll found a missing holiday; reopening to fix');
    perform demo.as_postgres();
  end if;

  -- Comments on a few submitted weeks waiting for a decision (TS-08).
  for r in
    select t.id, p.key, demo.decider(p.key) as decider
    from public.timesheets t join demo.people p on p.id = t.user_id
    where t.status = 'submitted' and (hashtext(t.id::text) % 4) = 0
  loop
    perform demo.as_user(r.decider);
    perform public.add_timesheet_comment(r.id, 'Looks good overall; can you add a note for Monday?');
    perform demo.as_user(r.key);
    perform public.add_timesheet_comment(r.id, 'Added. Monday I was at the customer workshop.');
    perform demo.as_postgres();
  end loop;

  -- A check-in Arjun's agent held back last Friday (a deferral, during a call) reaches
  -- the server only now, through the agent_events RPC itself: his approved week gets
  -- late data and his manager a notification (#43).
  select x.id as device_id, (select max(seq) from public.agent_events_raw a where a.device_id = x.id) as seq,
         p.tz into r
  from demo.devices x join demo.people p on p.key = x.person
  join public.clock_sessions cs on cs.device_id = x.id and cs.end_at is null
  where x.person = 'arjun';
  if r.device_id is not null then
    v_start := (now() at time zone r.tz)::date;
    v_start := v_start - (extract(isodow from v_start)::int - 1) - 3;
    perform demo.as_user('arjun');
    perform public.agent_events(r.device_id, jsonb_build_array(jsonb_build_object(
      'id', ('00000000-0000-4000-8000-' || substr(md5('demo-late-checkin'), 1, 12))::uuid, 'seq', r.seq + 1,
      'at', to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), 'mono_ms', 1,
      'type', 'checkin', 'payload', jsonb_build_object(
        'scheduled_at', to_char(((v_start + time '15:10') at time zone r.tz) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
        'shown_at', null, 'responded_at', null, 'outcome', 'deferred', 'deferral_reason', 'call',
        'response_ms', null, 'wrong_clicks', 0, 'idle_s_at_show', null, 'device_state', null,
        'object_keys', '[]'::jsonb, 'flags', '[]'::jsonb))));
    perform demo.as_postgres();
  end if;

  -- Pedro left at the end of his last week: deactivated now that it's settled (ORG-06).
  perform demo.as_user('ada');
  perform public.set_user_active(p.id, false) from demo.people p where p.last_day is not null;
  perform demo.as_postgres();
  raise notice 'timesheets waiting on a decision: %', v_failed;
end;
$$;
