begin;
create extension if not exists pgtap with schema extensions;

select plan(35);

\set erin '''00000000-0000-4000-8000-0000000000c1'''
\set lucas '''00000000-0000-4000-8000-0000000000c2'''
\set owner '''00000000-0000-4000-8000-0000000000a1'''

create function pg_temp.act_as(uid uuid) returns void
language sql as $$
  select set_config('role', 'authenticated', true);
  select set_config('request.jwt.claims',
    jsonb_build_object('sub', uid, 'role', 'authenticated')::text, true);
$$;

create function pg_temp.act_as_postgres() returns void
language sql as $$
  select set_config('role', 'postgres', true);
  select set_config('request.jwt.claims', '', true);
$$;

-- ISO timestamp `ago` before now, as the agent sends it.
create function pg_temp.ts(ago interval default '0') returns text
language sql as $$
  select to_char((now() - ago) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
$$;

create function pg_temp.ev(id uuid, seq int, type text, payload jsonb default '{}', ago interval default '0')
returns jsonb
language sql as $$
  select jsonb_build_object('id', id, 'seq', seq, 'type', type, 'at', pg_temp.ts(ago),
                            'mono_ms', seq * 1000, 'payload', payload);
$$;

-- Fixed event ids so results can be compared.
create temp table ids (n int primary key, id uuid not null default gen_random_uuid());
insert into ids (n) select generate_series(1, 20);
grant select on ids to authenticated;
create function pg_temp.id(n int) returns uuid language sql as $$ select id from ids where ids.n = $1 $$;

-- Erin registers her Mac.
select pg_temp.act_as(:erin);
create temp table dev on commit drop as
  select device_id from public.register_device('macos', '26.0', '0.1.0', 'hash-erin-sync');
grant select on dev to authenticated;
create function pg_temp.dev() returns uuid language sql as $$ select device_id from dev $$;

create function pg_temp.send(events jsonb) returns jsonb
language sql as $$ select public.agent_events(pg_temp.dev(), events) $$;

-- Clock in -----------------------------------------------------------------------

create temp table r on commit drop as
  select pg_temp.send(jsonb_build_array(
    pg_temp.ev(pg_temp.id(1), 1, 'clock_in', '{"reason": "manual"}', '30 minutes')
  )) as res;
grant all on r to authenticated;

select is((select res -> 'accepted' from r), jsonb_build_array(pg_temp.id(1)), 'clock_in is accepted');
select is((select (res ->> 'acked_seq')::int from r), 1, 'acked_seq advances to 1');
select ok((select res ? 'server_time' from r), 'reply carries server_time for clock-offset correction');

select is(
  pg_temp.send(jsonb_build_array(pg_temp.ev(pg_temp.id(1), 1, 'clock_in', '{"reason": "manual"}', '30 minutes'))) -> 'duplicates',
  jsonb_build_array(pg_temp.id(1)),
  'resending the same event is reported as a duplicate'
);

select pg_temp.act_as_postgres();
select is((select count(*)::int from public.clock_sessions where user_id = :erin and end_at is null), 1,
  'one open clock session, even after the resend');
select is((select count(*)::int from public.agent_events_raw where device_id = (select device_id from dev)), 1,
  'the raw event is stored once');

-- Out of order and illegal transitions ------------------------------------------

select pg_temp.act_as(:erin);
-- seq 3 arrives before seq 2.
select is(
  pg_temp.send(jsonb_build_array(pg_temp.ev(pg_temp.id(3), 3, 'break_start', '{"planned_min": 15}', '25 minutes'))) ->> 'acked_seq',
  '1', 'a gap in seq holds acked_seq back'
);
select is(
  pg_temp.send(jsonb_build_array(pg_temp.ev(pg_temp.id(2), 2, 'project_switch', '{"project_id": null}', '26 minutes'))) ->> 'acked_seq',
  '3', 'filling the gap advances acked_seq past both'
);

update r set res = pg_temp.send(jsonb_build_array(
  pg_temp.ev(pg_temp.id(4), 4, 'pause_start', '{"planned_min": 5}', '24 minutes'),
  pg_temp.ev(pg_temp.id(5), 5, 'checkin', jsonb_build_object(
    'scheduled_at', pg_temp.ts('24 minutes'), 'outcome', 'pass', 'wrong_clicks', 0,
    'object_keys', jsonb_build_array('screen-1.webp'), 'flags', '[]'::jsonb), '24 minutes')
));
select is((select res -> 'rejected' -> 0 ->> 'reason' from r), 'on_break', 'pause_start during a break is rejected');
select is((select res -> 'rejected' -> 1 ->> 'reason' from r), 'checkin_while_on_break', 'a check-in during a break is rejected');
select is((select (res ->> 'acked_seq')::int from r), 5, 'rejected events still advance acked_seq');

select is(
  pg_temp.send(jsonb_build_array(pg_temp.ev(pg_temp.id(4), 4, 'pause_start', '{"planned_min": 5}', '24 minutes'))) -> 'duplicates',
  jsonb_build_array(pg_temp.id(4)),
  'resending a rejected event is a duplicate, not a second rejection'
);

-- Check-ins ------------------------------------------------------------------------

update r set res = pg_temp.send(jsonb_build_array(
  pg_temp.ev(pg_temp.id(6), 6, 'break_end', '{}', '20 minutes'),
  pg_temp.ev(pg_temp.id(7), 7, 'checkin', jsonb_build_object(
    'scheduled_at', pg_temp.ts('19 minutes'), 'shown_at', pg_temp.ts('19 minutes'),
    'responded_at', pg_temp.ts('19 minutes'), 'outcome', 'pass', 'response_ms', 4200,
    'wrong_clicks', 1, 'object_keys', jsonb_build_array('screen-1.webp', 'webcam.webp'),
    'capture_errors', '{}'::jsonb, 'flags', '[]'::jsonb), '19 minutes'),
  pg_temp.ev(pg_temp.id(8), 8, 'checkin', jsonb_build_object(
    'scheduled_at', pg_temp.ts('10 minutes'), 'outcome', 'miss', 'wrong_clicks', 0,
    'object_keys', jsonb_build_array('screen-1.webp'), 'flags', '[]'::jsonb), '10 minutes'),
  pg_temp.ev(pg_temp.id(9), 9, 'checkin', jsonb_build_object(
    'scheduled_at', pg_temp.ts('8 minutes'), 'outcome', 'pass', 'wrong_clicks', 0,
    'object_keys', '[]'::jsonb, 'capture_errors', '{"webcam": "camera_busy"}'::jsonb,
    'flags', '[]'::jsonb), '8 minutes')
));
select is((select res -> 'accepted' from r), jsonb_build_array(pg_temp.id(6), pg_temp.id(7), pg_temp.id(9)),
  'break_end and both passing check-ins are accepted');
select is((select res -> 'rejected' -> 0 ->> 'reason' from r), 'invalid_checkin', 'a miss that lists captures is rejected');

select pg_temp.act_as_postgres();
select is(
  (select object_keys from public.checkin_events where id = pg_temp.id(7)),
  array['screen-1.webp', 'webcam.webp'], 'check-in row stores its file names'
);
select is(
  (select capture_errors ->> 'webcam' from public.checkin_events where id = pg_temp.id(9)),
  'camera_busy', 'a capture failure reason is stored and the check-in still passes (CAP-08)'
);
select is(
  (select last_checkin_outcome::text from public.presence where user_id = :erin),
  'pass', 'presence shows the last check-in outcome'
);

-- Validation -------------------------------------------------------------------------

select pg_temp.act_as(:erin);
update r set res = pg_temp.send(jsonb_build_array(
  pg_temp.ev(pg_temp.id(10), 10, 'pause_start', '{"planned_min": 7}', '5 minutes'),
  pg_temp.ev(pg_temp.id(11), 11, 'lock', '{"surprise": true}', '5 minutes'),
  pg_temp.ev(pg_temp.id(12), 12, 'teleport', '{}', '5 minutes'),
  pg_temp.ev(pg_temp.id(13), 13, 'lock', '{}', '8 days'),
  pg_temp.ev(pg_temp.id(14), 14, 'unlock', '{}', '-10 minutes')
));
select is((select res -> 'rejected' -> 0 ->> 'reason' from r), 'invalid_event', 'a pause preset outside 5/10/15 fails the schema');
select is((select res -> 'rejected' -> 1 ->> 'reason' from r), 'invalid_event', 'an unknown payload field fails the schema');
select is((select res -> 'rejected' -> 2 ->> 'reason' from r), 'invalid_event', 'an unknown event type fails the schema');
select is((select res -> 'rejected' -> 3 ->> 'reason' from r), 'at_out_of_range', 'an event older than 7 days is rejected');
select is((select res -> 'rejected' -> 4 ->> 'reason' from r), 'at_out_of_range', 'an event more than 5 min in the future is rejected');
select is((select (res ->> 'acked_seq')::int from r), 14, 'invalid events still advance acked_seq');

select throws_ok(
  format('select public.agent_events(%L, %L)', pg_temp.dev(),
    (select jsonb_agg(pg_temp.ev(gen_random_uuid(), 100 + g, 'lock')) from generate_series(1, 101) g)),
  '22023', 'batch_too_many_events', 'more than 100 events in one call is refused'
);
select throws_ok(
  format('select public.agent_events(%L, %L)', pg_temp.dev(),
    jsonb_build_array(pg_temp.ev(gen_random_uuid(), 200, 'app_session',
      jsonb_build_object('app', repeat('x', 300000))))),
  '22023', 'batch_too_large', 'a batch over 256 KB is refused'
);
select throws_ok(
  format('select public.agent_events(%L, %L)', pg_temp.dev(), '{"not": "an array"}'),
  '22023', 'events_not_array', 'events must be an array'
);

-- Clock out --------------------------------------------------------------------------

select is(
  pg_temp.send(jsonb_build_array(pg_temp.ev(pg_temp.id(15), 15, 'clock_out', '{"reason": "manual"}', '1 minute'))) -> 'accepted',
  jsonb_build_array(pg_temp.id(15)), 'clock_out is accepted'
);
select is(
  pg_temp.send(jsonb_build_array(pg_temp.ev(pg_temp.id(16), 16, 'lock', '{}'))) -> 'rejected' -> 0 ->> 'reason',
  'not_clocked_in', 'activity events after clock-out are rejected'
);
select pg_temp.act_as_postgres();
select is((select end_reason from public.clock_sessions where user_id = :erin), 'manual', 'clock_out closes the session');
select is((select count(*)::int from public.breaks where user_id = :erin and end_at is null), 0, 'no break left open');

-- Heartbeat ---------------------------------------------------------------------------

select pg_temp.act_as(:erin);
select is(
  (public.agent_heartbeat(pg_temp.dev(), now(), 42, false, true, '0.1.1', '{"screen": "granted", "camera": "granted"}')) ->> 'policy_version',
  '1', 'heartbeat returns the org policy version'
);
select pg_temp.act_as_postgres();
select is((select (state ->> 'idle_s')::int from public.last_seen where user_id = :erin), 42, 'heartbeat records idle seconds');
select is((select agent_version from public.devices where id = pg_temp.dev()), '0.1.1', 'heartbeat updates the agent version');

-- Ownership and revocation -------------------------------------------------------------

select pg_temp.act_as(:lucas);
select throws_ok(
  format('select public.agent_events(%L, %L)', pg_temp.dev(), '[]'),
  '42501', 'device_not_found', 'another user cannot send events for Erin''s device'
);

select pg_temp.act_as(:owner);
select public.revoke_device(pg_temp.dev());
select pg_temp.act_as(:erin);
select throws_ok(
  format('select public.agent_heartbeat(%L, now(), 0, false, false, %L, %L)', pg_temp.dev(), '0.1.1', '{}'),
  '42501', 'device_revoked', 'a revoked device''s next heartbeat is rejected'
);

select pg_temp.act_as_postgres();
select * from finish();
rollback;
