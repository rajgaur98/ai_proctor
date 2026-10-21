begin;
create extension if not exists pgtap with schema extensions;

-- #64: face presence detection (CAP-07). Only a boolean on a pass; off for EU
-- organisations and biometric-law work locations; a collection key of the monitoring
-- notice; RLS on check-ins unchanged.

select plan(53);

\set ada '''00000000-0000-4000-8000-0000000000a1'''
\set max '''00000000-0000-4000-8000-0000000000b1'''
\set erin '''00000000-0000-4000-8000-0000000000c1'''
\set lucas '''00000000-0000-4000-8000-0000000000c2'''
\set org '''00000000-0000-4000-8000-000000000001'''
\set eu_owner '''00000000-0000-4000-8000-0000000000f1'''

create function pg_temp.act_as(uid uuid) returns void
language sql as $$
  select set_config('role', 'postgres', true);
  select set_config('request.jwt.claims',
    (internal.custom_access_token_hook(jsonb_build_object(
      'user_id', uid, 'claims', jsonb_build_object('sub', uid, 'role', 'authenticated')
    )) -> 'claims')::text, true);
  select set_config('role', 'authenticated', true);
$$;

create function pg_temp.act_as_postgres() returns void
language sql as $$
  select set_config('role', 'postgres', true);
  select set_config('request.jwt.claims', '', true);
$$;

-- Saves one key as the current user; the error text, or 'ok'.
create function pg_temp.save(k text, v jsonb) returns text
language plpgsql as $$
declare
  m text;
  d text;
begin
  perform public.update_policy(jsonb_build_object(k, v));
  return 'ok';
exception when others then
  get stacked diagnostics m = message_text, d = pg_exception_detail;
  return m || ':' || coalesce(d, '');
end;
$$;

create function pg_temp.ts(ago interval) returns text
language sql as $$ select to_char((now() - ago) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') $$;

create temp table seqs (who uuid constraint seqs_pkey primary key, n int not null);
create temp table devs (who uuid primary key, device_id uuid not null);
grant all on seqs, devs to authenticated;

-- Sends one event from `who`'s device (as them) and returns what agent_events said
-- about it: 'accepted', or the rejection reason.
create function pg_temp.send(who uuid, type text, payload jsonb, ago interval default '0')
returns text
language plpgsql as $$
declare
  n int;
  r jsonb;
  id uuid := gen_random_uuid();
begin
  perform pg_temp.act_as(who);
  insert into seqs as s (who, n) values (send.who, 1)
  on conflict on constraint seqs_pkey do update set n = s.n + 1
  returning s.n into n;
  r := public.agent_events(
    (select device_id from devs d where d.who = send.who),
    jsonb_build_array(jsonb_build_object('id', id, 'seq', n, 'type', type,
      'at', pg_temp.ts(ago), 'mono_ms', n, 'payload', payload)));
  if exists (select 1 from jsonb_array_elements(r -> 'rejected') x where x ->> 'id' = id::text) then
    return (select x ->> 'reason' from jsonb_array_elements(r -> 'rejected') x where x ->> 'id' = id::text);
  end if;
  return 'accepted';
end;
$$;

-- A check-in from `who` with `extra` merged into an ordinary payload.
create function pg_temp.checkin(who uuid, outcome text, extra jsonb, ago interval) returns text
language sql as $$
  select pg_temp.send(who, 'checkin', jsonb_build_object(
    'scheduled_at', pg_temp.ts(ago + interval '10 seconds'),
    'shown_at', pg_temp.ts(ago + interval '10 seconds'),
    'responded_at', case when outcome = 'pass' then pg_temp.ts(ago) end,
    'response_ms', case when outcome = 'pass' then 4000 end,
    'outcome', outcome, 'wrong_clicks', 0, 'object_keys', '[]'::jsonb, 'flags', '[]'::jsonb
  ) || extra, ago)
$$;

-- face_present of `who`'s latest check-in, read as postgres.
create function pg_temp.latest_face(who uuid) returns text
language plpgsql as $$
declare
  v text;
begin
  perform pg_temp.act_as_postgres();
  select coalesce(face_present::text, 'null') into v from public.checkin_events
  where user_id = who order by scheduled_at desc, created_at desc limit 1;
  return v;
end;
$$;

-- Where it is always off ---------------------------------------------------------------------

select pg_temp.act_as_postgres();
select ok(internal.biometric_law_location('US', 'IL') and internal.biometric_law_location('US', 'TX')
  and internal.biometric_law_location('US', 'WA'),
  'Illinois (BIPA), Texas (CUBI) and Washington are biometric-law locations');
select ok(not internal.biometric_law_location('US', 'CA') and not internal.biometric_law_location('US', 'NY')
  and not internal.biometric_law_location('US', null) and not internal.biometric_law_location('IN', null),
  'California, New York, an unknown state and India are not');
select ok(internal.biometric_law_location('DE', null) and internal.biometric_law_location('NO', null),
  'the EU and EEA are, for someone working there for an organisation elsewhere');
select ok(internal.biometric_law_places() @> array['Illinois', 'Texas', 'Washington', 'the European Economic Area'],
  'the places are named for the dashboard and the notice');
select ok(internal.face_presence_allowed(:erin), 'Erin works in California for a US org: allowed');
select ok(not internal.face_presence_allowed(:max), 'Max works in Illinois: never');
select ok(not internal.face_presence_allowed(:lucas), 'Lucas works in Texas: never');
select ok(not internal.face_presence_allowed('00000000-0000-4000-8000-00000000ffff'), 'an unknown person: never');

-- The policy key -------------------------------------------------------------------------------

select is((select count(*)::int from unnest(enum_range(null::public.region_preset)) r
           where (internal.region_preset(r) ->> 'face_presence')::boolean is false), 3,
  'every preset has face presence off');
select is((select kind from internal.policy_spec() where key = 'face_presence'), 'bool', 'it is a switch');
select is(internal.collection_snapshot('{}') ->> 'face_presence', 'false', 'off when the org never set it');
select is(internal.collection_off() ->> 'face_presence', 'false', 'and off for someone who acknowledged nothing');

select pg_temp.act_as(:ada);
select is(public.policy_settings() -> 'policy' ->> 'face_presence', 'false', 'the settings show it off');
select is(public.policy_settings() ->> 'face_presence_available', 'true', 'a US org can turn it on');
select is((public.policy_settings() ->> 'biometric_law_members')::int, 2,
  'two active people work where it is always off (Max, Lucas)');
select ok((public.policy_settings() -> 'biometric_law_places') ? 'Illinois', 'and the places are listed');
select is(pg_temp.save('face_presence', '"yes"'), 'invalid_policy:face_presence', 'only a boolean');

-- EU organisations: unavailable ---------------------------------------------------------------

select pg_temp.act_as_postgres();
insert into auth.users (id, email) values (:eu_owner, 'owner@eu-face.test');
select pg_temp.act_as(:eu_owner);
select public.create_org('EuFace', 'eu', 'Eva Owner', 'Europe/Berlin');
select is(public.policy_settings() ->> 'face_presence_available', 'false', 'an EU org cannot use it');
select is(pg_temp.save('face_presence', 'true'), 'face_presence_unavailable:face_presence',
  'turning it on in an EU org is refused');
select is(pg_temp.save('face_presence', 'false'), 'ok', 'leaving it off is fine');
select pg_temp.act_as_postgres();
-- Even if it got stored somehow, the effective value stays off.
update public.orgs set policy = policy || '{"face_presence": true, "webcam": true}' where name = 'EuFace';
select ok(not internal.face_presence_allowed(:eu_owner), 'nobody in an EU org is allowed');
select is(internal.effective_collection(:eu_owner) ->> 'face_presence', 'false',
  'so the effective collection has it off whatever is stored');

-- Turning it on: a new notice, and it runs only once acknowledged --------------------------------

select pg_temp.act_as(:ada);
select ok((public.update_policy('{"face_presence": true}') ->> 'notice_version') is not null,
  'turning it on publishes a new monitoring notice');
select pg_temp.act_as_postgres();
select is((select collection ->> 'face_presence' from public.notices where org_id = :org order by version desc limit 1),
  'true', 'whose collection has it');
select ok((select body ->> 'collected' from public.notices where org_id = :org order by version desc limit 1)
  ~ 'detection only.*never identifies you.*Illinois',
  'and whose text says what it does and where it is off');
select is(internal.effective_collection(:erin) ->> 'face_presence', 'false',
  'it does not run for Erin until she acknowledges that notice');
select pg_temp.act_as(:erin);
select public.acknowledge_notice((select id from public.notices where org_id = :org order by version desc limit 1));
select pg_temp.act_as(:lucas);
select public.acknowledge_notice((select id from public.notices where org_id = :org order by version desc limit 1));
select pg_temp.act_as_postgres();
select is(internal.effective_collection(:erin) ->> 'face_presence', 'true', 'after acknowledging, it runs for Erin');
select is(internal.effective_collection(:lucas) ->> 'face_presence', 'false',
  'never for Lucas in Texas, acknowledged or not');

-- The agent's config carries the effective value, not the org's.
select pg_temp.act_as(:erin);
insert into devs select :erin, device_id from public.register_device('macos', '26.0', '0.1.0', 'hash-erin-face');
select is(public.agent_config((select device_id from devs where who = :erin)) -> 'policy' ->> 'face_presence', 'true',
  'Erin''s agent is told to run it');
select pg_temp.act_as(:lucas);
insert into devs select :lucas, device_id from public.register_device('windows', '11', '0.1.0', 'hash-lucas-face');
select is(public.agent_config((select device_id from devs where who = :lucas)) -> 'policy' ->> 'face_presence', 'false',
  'Lucas''s agent is told it is off, though the org has it on');

-- It needs the webcam it looks at.
select pg_temp.act_as_postgres();
update public.orgs set policy = policy || '{"webcam": false}' where id = :org;
select is(internal.effective_collection(:erin) ->> 'face_presence', 'false', 'off while the webcam is off');
update public.orgs set policy = policy || '{"webcam": true}' where id = :org;

-- A new work location switches it, and the person's devices refetch.
create temp table cv as select config_version as v from public.users where id = :erin;
update public.users set work_state = 'IL' where id = :erin;
select is(internal.effective_collection(:erin) ->> 'face_presence', 'false', 'moving to Illinois turns it off');
select is((select config_version from public.users where id = :erin), (select v + 1 from cv),
  'and bumps her config version');
update public.users set work_state = 'CA' where id = :erin;
select is(internal.effective_collection(:erin) ->> 'face_presence', 'true', 'back in California it is on again');

-- Older notices predate the key: they count as "off", not as a change -----------------------------

-- As every notice published before this migration: a snapshot without face_presence.
update public.orgs set policy = policy || '{"face_presence": false}' where id = :org;
insert into public.notices (org_id, version, region, body, collection)
select org_id, version + 1, region, body, collection - 'face_presence'
from public.notices where org_id = :org order by version desc limit 1;
create temp table nv as select max(version) as v from public.notices where org_id = :org;
grant select on nv to authenticated;
select pg_temp.act_as(:ada);
select is(public.update_policy('{"week_start": "sunday"}') -> 'notice_version', 'null'::jsonb,
  'a change outside collection still publishes no notice after an old snapshot');
select pg_temp.act_as_postgres();
select is((select max(version) from public.notices where org_id = :org), (select v from nv), 'none was published');
select pg_temp.act_as(:ada);
select public.update_policy('{"face_presence": true}');
select pg_temp.act_as(:erin);
select public.acknowledge_notice((select id from public.notices where org_id = :org order by version desc limit 1));

-- What a check-in stores ------------------------------------------------------------------------

select is(pg_temp.send(:erin, 'clock_in', '{"reason": "manual"}', '60 minutes'), 'accepted', 'Erin clocks in');
select is(pg_temp.checkin(:erin, 'pass', '{"face_present": false}', '50 minutes'), 'accepted',
  'a pass with no face is accepted');
select is(pg_temp.latest_face(:erin), 'false', 'and stores false');
select is(pg_temp.checkin(:erin, 'pass', '{"face_present": true}', '40 minutes'), 'accepted', 'a pass with a face');
select is(pg_temp.latest_face(:erin), 'true', 'stores true');
select is(pg_temp.checkin(:erin, 'pass', '{}', '30 minutes'), 'accepted', 'a pass where detection did not run');
select is(pg_temp.latest_face(:erin), 'null', 'stores nothing');
select is(pg_temp.checkin(:erin, 'miss', '{"face_present": true}', '20 minutes'), 'accepted',
  'a miss that claims an answer is still recorded');
select is(pg_temp.latest_face(:erin), 'null', 'without it: a miss never has a face answer');
select is(pg_temp.checkin(:erin, 'pass', '{"face_present": "no"}', '15 minutes'), 'invalid_event',
  'anything but a boolean or null is refused by the contract');

select is(pg_temp.send(:lucas, 'clock_in', '{"reason": "manual"}', '60 minutes'), 'accepted', 'Lucas clocks in');
select is(pg_temp.checkin(:lucas, 'pass', '{"face_present": false}', '50 minutes'), 'accepted',
  'an agent that sends it where it is off');
select is(pg_temp.latest_face(:lucas), 'null', 'gets nothing stored');

select throws_ok($$
  insert into public.checkin_events (id, org_id, user_id, device_id, scheduled_at, outcome, face_present)
  values (gen_random_uuid(), '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000c1',
          (select device_id from devs where who = '00000000-0000-4000-8000-0000000000c1'), now(), 'miss', false)
$$, '23514', null, 'the table refuses a face answer on anything but a pass');

-- RLS unchanged ------------------------------------------------------------------------------------

select policies_are('public', 'checkin_events', array['Visible per can_view_user'],
  'check-ins keep their one read policy');
select pg_temp.act_as(:max);
select is((select count(*)::int from public.checkin_events where user_id = :erin and face_present is not null), 2,
  'Erin''s manager sees her answers');
select pg_temp.act_as(:lucas);
select is((select count(*)::int from public.checkin_events where user_id = :erin), 0, 'a colleague sees none');

select * from finish();
rollback;
