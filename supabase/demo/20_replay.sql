-- Demo seed (#351), step 2: replays the generated agent events in time order through
-- the server's own code, so everything derived (clock sessions, breaks, pauses,
-- presence and status periods, check-ins and their anti-cheat flags, late clock-ins,
-- activity samples, alerts) is produced the way production produces it.
--
-- What differs from a live agent, and why:
--  - Events go to internal.apply_event, the function public.agent_events runs for each
--    event, not to the RPC itself: the RPC refuses events more than 7 days old, and
--    this history is 4 weeks long. The envelope was already checked against the events
--    contract (generate.ts); the raw row and the device's acked cursor are written as
--    the RPC writes them.
--  - app_session events go straight to internal.record_activity (what apply_event
--    calls for them) without apply_event's presence refresh, which an activity bucket
--    never changes, after the rest and in parallel (demo.activity, scripts/demo-seed.sh):
--    tens of thousands of buckets that nothing else in the replay reads.
--  - The cron jobs that react to time run at the replayed time: internal.alert_eval at
--    the moments an alert can start (`_tick`: past a shift's grace with no clock-in, a
--    third miss in a row, 15 minutes offline, a tamper gap, the pause cap crossed; the
--    generator knows them), offline_sweep's step (no contact for offline_after() marks
--    the person Offline) where the agent went quiet (`_offline`), and the heartbeat's
--    step where contact came back (`_contact`).
--  - Planned moments (a laptop registered or revoked, a leave or holiday that covers
--    today) run as RPCs at their time (`demo.actions`).

create function demo.action(p_kind text, p_person text, p_args jsonb, p_at timestamptz) returns void
language plpgsql as $$
declare
  v_users uuid[];
  h demo.holidays;
  u uuid;
begin
  case p_kind
  when 'register_device' then
    perform demo.register(p_person, (p_args ->> 'device')::int);
  when 'revoke_device' then
    perform demo.as_user(p_args ->> 'by');
    perform public.revoke_device((select id from demo.devices where person = p_person and device_no = (p_args ->> 'device')::int));
    perform demo.as_postgres();
  when 'leave' then
    perform demo.leave((p_args ->> 'leave')::int);
    v_users := array[demo.uid(p_person)];
  when 'holiday' then
    select * into h from demo.holidays where n = (p_args ->> 'holiday')::int;
    perform demo.as_user('ada');
    perform public.save_holiday(null, h.day, h.name, h.country, h.state);
    perform demo.as_postgres();
    v_users := array(select id from public.users where work_country = h.country and work_state is not distinct from h.state);
  end case;
  -- Approving the leave (or saving the holiday) refreshes presence at the moment of the
  -- call; in this story it was decided earlier and leave_sweep flipped them at their
  -- midnight, so the On leave period starts there.
  foreach u in array coalesce(v_users, '{}') loop
    perform internal.refresh_presence(u, p_at);
    update public.status_periods set end_at = p_at
    where user_id = u and end_at = now() and start_at < p_at;
    update public.status_periods set start_at = p_at
    where user_id = u and end_at is null and start_at = now() and status = 'on_leave';
    update public.presence set since = p_at where user_id = u and status = 'on_leave' and since = now();
  end loop;
end;
$$;

-- A procedure that commits every few hundred events: the trigger that marks a day for
-- a timesheet rebuild updates the same dirty_days row for every event of that day, and
-- one long transaction would keep every version of it. scripts/demo-seed.sh pauses the
-- stack's cron jobs meanwhile, so none of them acts on half-replayed history.
create procedure demo.replay()
language plpgsql as $$
declare
  v_i int := 0;
  r record;
  v_dev public.devices;
  v_reason text;
  v_user uuid;
  v_from timestamptz;
begin
  -- Projects and tasks were generated with stand-in ids.
  for r in
    select fake, id from demo.projects
    union all
    select fake, id from demo.tasks
  loop
    update demo.events set payload = replace(payload::text, r.fake::text, r.id::text)::jsonb
    where type in ('clock_in', 'project_switch', 'checkin') and payload::text like '%' || r.fake::text || '%';
  end loop;

  select min(at) into v_from from demo.events;
  perform internal.ensure_weekly_partitions('public.agent_events_raw', v_from, now());
  perform internal.ensure_weekly_partitions('public.activity_samples', v_from, now());
  commit;

  for r in
    select 1 as src, e.n, e.person, e.device_no, e.seq, e.id, e.at, e.type, e.payload, null::text as kind, null::jsonb as args
    from demo.events e
    where e.type <> 'app_session'
    union all
    select 0, a.n, a.person, null, 0, null, a.at, null, null, a.kind, a.args
    from demo.actions a
    order by at, src, n
  loop
    v_i := v_i + 1;
    if v_i % 500 = 0 then
      commit;
    end if;
    if r.src = 0 then
      perform demo.action(r.kind, r.person, r.args, r.at);
      continue;
    end if;
    v_user := demo.uid(r.person);
    if r.type = '_tick' then
      perform internal.alert_eval(r.at);
      continue;
    elsif r.type = '_offline' then
      update public.presence set last_contact_at = r.at - internal.offline_after() where user_id = v_user;
      perform internal.refresh_presence(v_user, r.at);
      continue;
    elsif r.type = '_contact' then
      update public.presence set last_contact_at = now() where user_id = v_user;
      perform internal.refresh_presence(v_user, r.at);
      continue;
    end if;
    select d.* into v_dev from public.devices d
    join demo.devices x on x.id = d.id
    where x.person = r.person and x.device_no = r.device_no;
    v_reason := internal.apply_event(v_dev, r.id, r.type, r.at, r.payload);
    if v_reason is null then
      insert into public.agent_events_raw (id, org_id, device_id, user_id, seq, type, at, received_at, payload)
      values (r.id, v_dev.org_id, v_dev.id, v_dev.user_id, r.seq, r.type, r.at, r.at + interval '2 seconds', r.payload);
    else
      insert into public.agent_event_rejections (device_id, event_id, seq, type, reason)
      values (v_dev.id, r.id, r.seq, r.type, v_reason);
      insert into demo.rejections (person, type, at, reason, payload) values (r.person, r.type, r.at, v_reason, r.payload);
    end if;
  end loop;
  perform internal.alert_eval(now());
end;
$$;

-- Activity buckets for one slice of the people (scripts/demo-seed.sh runs the slices in
-- parallel once the replay is committed: the clock sessions, breaks and pauses
-- record_activity checks against are all there by then).
create function demo.activity(p_part int, p_parts int) returns int
language plpgsql as $$
declare
  r record;
  v_dev public.devices;
  v_reason text;
  v_n int := 0;
begin
  for r in
    select e.*, x.id as device_id
    from demo.events e
    join demo.devices x on x.person = e.person and x.device_no = e.device_no
    where e.type = 'app_session' and abs(hashtext(e.person)) % p_parts = p_part
    order by e.at, e.n
  loop
    select d.* into v_dev from public.devices d where d.id = r.device_id;
    v_reason := internal.record_activity(v_dev, r.id, r.payload);
    if v_reason is null then
      insert into public.agent_events_raw (id, org_id, device_id, user_id, seq, type, at, received_at, payload)
      values (r.id, v_dev.org_id, v_dev.id, v_dev.user_id, r.seq, r.type, r.at, r.at + interval '2 seconds', r.payload);
      v_n := v_n + 1;
    else
      insert into public.agent_event_rejections (device_id, event_id, seq, type, reason)
      values (v_dev.id, r.id, r.seq, r.type, v_reason);
      insert into demo.rejections (person, type, at, reason, payload) values (r.person, r.type, r.at, v_reason, r.payload);
    end if;
  end loop;
  return v_n;
end;
$$;

-- Every event was answered: the devices' contiguous cursor is at their last seq (as
-- agent_events advances it).
create function demo.ack_devices() returns void
language sql as $$
  update public.devices d set acked_seq = greatest(
    coalesce((select max(seq) from public.agent_events_raw x where x.device_id = d.id), 0),
    coalesce((select max(seq) from public.agent_event_rejections x where x.device_id = d.id), 0))
  where d.id in (select id from demo.devices);
$$;

-- After the replay (scripts/demo-seed.sh: `call demo.replay(); select demo.settle();`).
create function demo.settle() returns void
language plpgsql as $$
declare
  r record;
begin
  -- The nightly anti-cheat pass (ANT-04, cron anticheat_daily) for each replayed day.
  perform internal.anticheat_eval(d::date, now())
  from generate_series((now() - interval '28 days')::date, (now() - interval '1 day')::date, interval '1 day') d;

  -- Now: everyone still clocked in sends a heartbeat (agent_heartbeat, as themselves,
  -- with the state their agent sees), except the one whose agent went quiet (Offline).
  for r in
    select p.key, cs.device_id, pr.idle, pr.locked, pr.call_sources, pr.screen_permission, pr.camera_permission
    from demo.people p
    join public.presence pr on pr.user_id = p.id
    join public.clock_sessions cs on cs.user_id = p.id and cs.end_at is null
    where pr.status <> 'offline'
  loop
    perform demo.as_user(r.key);
    perform public.agent_heartbeat(r.device_id, now(), case when r.idle then 1500 else 4 end, r.locked,
      cardinality(r.call_sources) > 0, '0.9.0',
      jsonb_build_object('screen', coalesce(r.screen_permission, 'granted'), 'camera', coalesce(r.camera_permission, 'granted')));
    perform demo.as_postgres();
  end loop;

  -- Hold "now" for a demo session: offline_sweep turns anyone without a heartbeat for 3
  -- minutes Offline, and nothing heartbeats once the seed is done. The people clocked in
  -- are treated as heard from for the next 8 hours (rerun the seed to move "now").
  update public.presence p set last_contact_at = now() + interval '8 hours'
  where p.status not in ('off_shift', 'on_leave', 'offline')
    and exists (select 1 from public.clock_sessions cs where cs.user_id = p.user_id and cs.end_at is null);
end;
$$;
