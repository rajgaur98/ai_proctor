-- Demo seed (#351), step 1: the org as people set it up, through the same RPCs the
-- dashboard and the agent call (acting as the signed-in person), before any history is
-- replayed: policy, teams, clients/projects/tasks, people (invited by Ada; their sign-in
-- rows as in seed.sql), shifts, notice acknowledgements, devices, delegations, the
-- leave and holidays that lie in the past, notification preferences.
-- Runs in the same transaction as the plan and the replay (scripts/demo-seed.sh).

do $$
declare
  r record;
  v_id uuid;
  v_ids uuid[];
  v_org uuid := '00000000-0000-4000-8000-000000000001';
begin
  -- Policy (POL-01): face presence on (CAP-07), overtime thresholds for the reports, and
  -- check-in images kept 14 days (ADM-03), so the older half of the history shows
  -- captures deleted by retention.
  perform demo.as_user('ada');
  perform public.update_policy('{"face_presence": true, "overtime_daily_hours": 9, "overtime_weekly_hours": 40, "image_retention_days": 14}'::jsonb);
  perform demo.as_postgres();

  -- People: an auth account each (email + password, as in seed.sql), then the member row
  -- through add_invited_member, managers before the people who report to them. The one
  -- invite nobody has accepted yet comes later (30_people.sql).
  for r in
    with recursive tree as (
      select p.*, 0 as depth from demo.people p where p.seed
      union all
      select c.*, t.depth + 1 from demo.people c join tree t on c.manager_key = t.key where not c.seed
    )
    select * from tree where not seed and not invited_only order by depth, key
  loop
    insert into auth.users (
      instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, invited_at,
      raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
      confirmation_token, email_change, email_change_token_new, recovery_token
    )
    values (
      '00000000-0000-0000-0000-000000000000', r.id, 'authenticated', 'authenticated', r.email,
      extensions.crypt('password123', extensions.gen_salt('bf')), now(), now(),
      '{"provider": "email", "providers": ["email"]}'::jsonb,
      jsonb_build_object('full_name', r.full_name), now(), now(), '', '', '', ''
    );
    insert into auth.identities (id, user_id, provider_id, provider, identity_data, last_sign_in_at, created_at, updated_at)
    values (gen_random_uuid(), r.id, r.id::text, 'email',
      jsonb_build_object('sub', r.id::text, 'email', r.email, 'email_verified', true), now(), now(), now());
    -- The invite-users function's own step (service role): the inviter is checked inside.
    perform public.add_invited_member(demo.uid('ada'), r.id, r.email, r.full_name, r.role,
      demo.uid(r.manager_key), r.country, r.state, r.tz);
  end loop;

  -- Teams (TEAM-01) with their members, billable targets, and Night Ops' own policy.
  perform demo.as_user('ada');
  for r in select * from demo.teams order by key loop
    v_id := public.save_team(null, r.name);
    update demo.teams set id = v_id where key = r.key;
    perform public.set_team_members(v_id, array(select id from demo.people where team_key = r.key and not invited_only));
    if r.billable_target is not null then
      perform public.set_team_billable_target(v_id, r.billable_target);
    end if;
  end loop;
  perform public.set_team_policy((select id from demo.teams where key = 'nightops'),
    '{"auto_clock_in": true, "forgotten_clock_out_min": 30}'::jsonb);
  perform public.set_approval_required(p.id, false) from demo.people p where not p.approval_required;

  -- Clients, projects, tasks (PRJ-01..05) and who may log to each.
  for r in select * from demo.clients order by key loop
    v_id := coalesce(r.seed_id, public.save_client(null, r.name));
    update demo.clients set id = v_id where key = r.key;
  end loop;
  for r in select * from demo.projects order by key loop
    if r.seed_id is not null then
      v_id := r.seed_id;
    else
      v_id := public.save_project(null, r.name, (select id from demo.clients where key = r.client_key), r.billable, false);
    end if;
    update demo.projects set id = v_id where key = r.key;
  end loop;
  for r in select t.*, p.id as project_id from demo.tasks t join demo.projects p on p.key = t.project_key order by t.project_key, t.ord loop
    update demo.tasks set id = public.save_task(null, r.project_id, r.name) where fake = r.fake;
  end loop;
  for r in select * from demo.projects where not archived loop
    v_ids := array(
      select distinct u.id from public.users u
      left join demo.people p on p.id = u.id
      where p.team_key = any (r.teams) and not p.invited_only
        or u.id in (select pm.user_id from public.project_members pm where pm.project_id = r.id)
    );
    perform public.set_project_members(r.id, v_ids);
  end loop;
  -- An old client project, archived (PRJ-04).
  perform public.save_project(p.id, p.name, (select id from demo.clients where key = p.client_key), p.billable, true)
  from demo.projects p where p.archived;

  -- Shifts (SHF-01). Like the base seed, they applied all along; one person changed
  -- shift ten days ago (shift history, #329).
  for r in select * from demo.people where not seed and jsonb_array_length(shifts) > 0 loop
    perform public.set_shifts(r.id, (
      select jsonb_agg(jsonb_build_object('days', s -> 'days', 'start', s ->> 'start', 'end', s ->> 'end', 'timezone', s ->> 'timezone'))
      from jsonb_array_elements(r.shifts) s));
  end loop;
  perform demo.as_postgres();
  update public.shift_history h set valid_from = '-infinity'
  where h.user_id in (select id from demo.people where not seed);
  perform demo.as_user('ada');
  for r in select * from demo.people where shift_change is not null loop
    perform public.set_shifts(r.id, (
      select jsonb_agg(jsonb_build_object('days', s -> 'days', 'start', s ->> 'start', 'end', s ->> 'end', 'timezone', s ->> 'timezone'))
      from jsonb_array_elements(r.shift_change -> 'shifts') s));
    perform demo.as_postgres();
    update public.shift_history h set valid_to = (r.shift_change ->> 'from')::date
    where h.user_id = r.id and h.valid_to is not null;
    update public.shift_history h set valid_from = (r.shift_change ->> 'from')::date
    where h.user_id = r.id and h.valid_to is null;
    perform demo.as_user('ada');
  end loop;
  perform demo.as_postgres();

  -- The monitoring notice (AGT-04): everyone who has signed in acknowledges the current
  -- version (the base seed's people acknowledged version 1; a policy change republishes).
  for r in select p.key from demo.people p where not p.invited_only loop
    perform demo.as_user(r.key);
    perform public.acknowledge_notice((select n.id from public.notices n where n.org_id = v_org order by n.version desc limit 1));
    perform demo.as_postgres();
  end loop;

  -- Devices (AGT-02): registered at sign-in. Joiners and the replacement laptop register
  -- during the replay, on the day it happened.
  for r in select * from demo.people where tracked and not invited_only and devices > 0 and join_day is null loop
    perform demo.register(r.key, 1);
    if r.devices = 2 and r.key <> 'zara' then
      perform demo.register(r.key, 2);
    end if;
  end loop;

  -- Notification preferences (NOT-03): digests and weekly insights, varied.
  for r in select * from (values ('max', true, true), ('sofia', true, false), ('grace', false, true),
      ('daniel', false, true), ('kenji', true, true), ('omar', false, false), ('priya', true, true)) v(k, digest, weekly) loop
    perform demo.as_user(r.k);
    perform public.set_daily_digest(r.digest);
    perform public.set_weekly_insights(r.weekly);
    perform demo.as_postgres();
  end loop;

  -- Delegation (DLG-01): Grace is away this week and Daniel covers her team; Sofia's
  -- cover next week is Kenji; Max set one up and called it off (ended).
  perform demo.as_user('grace');
  perform public.set_delegation(demo.uid('daniel'), (now() at time zone 'America/New_York')::date,
    (now() at time zone 'America/New_York')::date + 3);
  perform demo.as_user('sofia');
  perform public.set_delegation(demo.uid('kenji'), (now() at time zone 'America/Denver')::date + 6,
    (now() at time zone 'America/Denver')::date + 10);
  perform demo.as_user('max');
  v_id := public.set_delegation(demo.uid('priya'), (now() at time zone 'America/Chicago')::date + 14,
    (now() at time zone 'America/Chicago')::date + 18);
  perform public.end_delegation(v_id);
  perform demo.as_postgres();

  -- Holidays that are not today (HOL-01): org-wide, per state, per country.
  perform demo.as_user('ada');
  for r in select * from demo.holidays where at is null loop
    perform public.save_holiday(null, r.day, r.name, r.country, r.state);
  end loop;
  perform demo.as_postgres();

  -- Time off that doesn't cover today (LV-01..04).
  for r in select n from demo.leaves where phase = 'setup' order by n loop
    perform demo.leave(r.n);
  end loop;
end;
$$;
