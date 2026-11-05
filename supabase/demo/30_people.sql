-- Demo seed (#351), step 3: what people did after the history, through the RPCs the
-- dashboard calls (as the signed-in person): API keys and webhooks, a new version of the
-- monitoring notice, time off ahead, manual entries, reasons for misses, capture views,
-- anti-cheat reviews, a new invite, exports, alerts and notifications
-- read.

do $$
declare
  r record;
  v_id uuid;
  v_body jsonb;
  v_org uuid := '00000000-0000-4000-8000-000000000001';
begin
  -- API (API-01): one key in use, one revoked. The keys themselves are never shown again.
  perform demo.as_user('ada');
  perform 1 from public.create_api_key('Payroll export', array['people:read', 'timesheets:read', 'time:read', 'timeoff:read']);
  select k.id into v_id from public.create_api_key('Old BI connector', array['reports:read', 'checkins:read']) k;
  perform public.revoke_api_key(v_id);

  -- Webhooks (#320): payroll sync receives (a receiver inside the stack that exists while
  -- the seed delivers, see 50_finish.sql), the old HRIS endpoint no longer resolves.
  perform 1 from public.create_webhook('http://rest:3000/rpc/demo_webhook_sink',
    array['timesheet.submitted', 'timesheet.approved', 'timesheet.returned', 'time_off.decided',
          'person.invited', 'person.deactivated']);
  perform 1 from public.create_webhook('https://hris.acme-old.invalid/hooks/time',
    array['timesheet.approved', 'alert.raised', 'person.invited', 'person.deactivated']);
  perform public.send_test_webhook(w.id) from public.webhooks w where w.org_id = v_org;

  -- A new notice version (NOT-01, AGT-04): retention wording changed. Most people
  -- acknowledge it; three haven't yet.
  select n.body into v_body from public.notices n where n.org_id = v_org order by n.version desc limit 1;
  perform public.publish_notice(v_body || jsonb_build_object('retention',
    'Check-in images are kept for 14 days, then deleted automatically. Timesheets are kept for 3 years.'));
  perform demo.as_postgres();
  for r in
    select p.key from demo.people p join public.users u on u.id = p.id
    where u.active and not p.invited_only and p.key not in ('kwame', 'jonas', 'owen')
  loop
    perform demo.as_user(r.key);
    perform public.acknowledge_notice((select n.id from public.notices n where n.org_id = v_org order by n.version desc limit 1));
    perform demo.as_postgres();
  end loop;

  -- Time off ahead (LV-01..03): pending, approved (with cover), rejected, cancelled.
  for r in select n from demo.leaves where phase = 'later' order by n loop
    perform demo.leave(r.n);
  end loop;

  -- Manual entries (MAN-01..03): asked for by the person, decided by their manager.
  for r in
    select m.*, p.id as project_id, mp.manager_key
    from demo.manual m
    join demo.projects p on p.fake = m.project_fake
    join demo.people mp on mp.key = m.person
    order by m.start_at
  loop
    perform demo.as_user(r.person);
    v_id := public.request_manual_entry(r.start_at, r.end_at, r.project_id, r.reason, null, r.note);
    if r.outcome = 'cancelled' then
      perform public.cancel_manual_entry(v_id);
    end if;
    perform demo.as_postgres();
    if r.outcome in ('approved', 'rejected') then
      perform demo.as_user(r.manager_key);
      perform public.decide_manual_entry(v_id, r.outcome = 'approved',
        case when r.outcome = 'rejected' then 'Please log this in the app next time' end);
      perform demo.as_postgres();
    end if;
  end loop;

  -- Reasons for missed check-ins (CHK-07), given by the person for about half their misses.
  for r in
    select c.id, p.key, row_number() over (order by c.scheduled_at) as i
    from public.checkin_events c join demo.people p on p.id = c.user_id
    where c.outcome = 'miss' and c.scheduled_at > now() - interval '12 days'
      and (hashtext(c.id::text) % 2) = 0
  loop
    perform demo.as_user(r.key);
    perform public.set_miss_reason(r.id, (array['meeting', 'phone_call', 'break', 'away', 'other'])[1 + r.i % 5],
      case when r.i % 5 = 4 then 'Fire alarm drill' end);
    perform demo.as_postgres();
  end loop;

  -- Managers look at a few captures of their reports (CAP-09, audit-logged).
  for r in
    select c.id, m.manager_key
    from public.checkin_events c join demo.people m on m.id = c.user_id
    where c.outcome = 'pass' and c.scheduled_at > now() - interval '5 days'
      and m.manager_key in ('max', 'sofia', 'kenji', 'omar') and (hashtext(c.id::text) % 25) = 0
  loop
    perform demo.as_user(r.manager_key);
    perform public.capture_view(r.id);
    perform demo.as_postgres();
  end loop;

  -- Anti-cheat flags (ANT-08): the older ones reviewed by the manager, the recent ones
  -- still "needs review".
  for r in
    select f.id, m.manager_key, f.kind
    from public.anticheat_flags f join demo.people m on m.id = f.user_id
    where f.day < (now() - interval '7 days')::date and (hashtext(f.id::text) % 3) <> 0
  loop
    perform demo.as_user(r.manager_key);
    perform public.anticheat_mark_reviewed(r.id,
      case r.kind::text when 'virtual_machine' then 'Works from the company VDI, expected'
                        when 'synthetic_click' then 'Uses an accessibility tool; talked to them'
                        else 'Checked, nothing wrong' end);
    perform demo.as_postgres();
  end loop;

  -- A new hire invited, not signed in yet (ORG-03).
  perform demo.as_postgres();
  for r in select * from demo.people where invited_only loop
    insert into auth.users (
      instance_id, id, aud, role, email, encrypted_password, invited_at, raw_app_meta_data,
      raw_user_meta_data, created_at, updated_at, confirmation_token, email_change,
      email_change_token_new, recovery_token
    )
    values (
      '00000000-0000-0000-0000-000000000000', r.id, 'authenticated', 'authenticated', r.email, '',
      now(), '{"provider": "email", "providers": ["email"]}'::jsonb,
      jsonb_build_object('full_name', r.full_name), now(), now(), '', '', '', ''
    );
    perform public.add_invited_member(demo.uid('priya'), r.id, r.email, r.full_name, r.role,
      demo.uid(r.manager_key), r.country, r.state, r.tz);
  end loop;
  perform demo.as_user('ada');
  for r in select t.id, t.key from demo.teams t where t.key in (select team_key from demo.people where invited_only) loop
    perform public.set_team_members(r.id, array(
      select u.id from public.users u where u.team_id = r.id
      union select p.id from demo.people p where p.invited_only and p.team_key = r.key));
  end loop;

  -- Exports people ran (audit-logged, #283).
  perform demo.as_user('max');
  perform public.record_export('timesheets', 'csv', '{"team": "Support"}'::jsonb, 42);
  perform demo.as_user('priya');
  perform public.record_export('reports', 'xlsx', '{"report": "overtime"}'::jsonb, 18);
  perform demo.as_postgres();

  -- Alerts and notifications: what's older than two days has been read.
  for r in select distinct a.recipient_id, p.key from public.alerts a join demo.people p on p.id = a.recipient_id loop
    perform demo.as_user(r.key);
    perform public.mark_alerts_read(array(
      select a.id from public.alerts a where a.recipient_id = r.recipient_id and a.triggered_at < now() - interval '2 days'));
    perform demo.as_postgres();
  end loop;
end;
$$;
