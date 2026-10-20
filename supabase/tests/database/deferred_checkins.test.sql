begin;
create extension if not exists pgtap with schema extensions;

select plan(17);

\set org '''00000000-0000-4000-8000-000000000001'''
\set erin '''00000000-0000-4000-8000-0000000000c1'''

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

-- A deferred check-in payload, as the agent sends it; `extra` overrides fields.
create function pg_temp.deferred(due interval, extra jsonb default '{}') returns jsonb
language sql as $$
  select jsonb_build_object(
    'scheduled_at', pg_temp.ts(due), 'shown_at', null, 'responded_at', null,
    'outcome', 'deferred', 'deferral_reason', 'call', 'response_ms', null,
    'wrong_clicks', 0, 'idle_s_at_show', null, 'device_state', null,
    'object_keys', '[]'::jsonb, 'project_id', null, 'flags', '[]'::jsonb) || extra;
$$;

create temp table ids (n int primary key, id uuid not null default gen_random_uuid());
insert into ids (n) select generate_series(1, 20);
grant select on ids to authenticated;
create function pg_temp.id(n int) returns uuid language sql as $$ select id from ids where ids.n = $1 $$;

select is(
  (select array_agg(e.enumlabel::text order by e.enumsortorder)
   from pg_enum e join pg_type t on t.oid = e.enumtypid where t.typname = 'checkin_outcome'),
  array['pass', 'miss', 'failed', 'deferred'], 'checkin_outcome has the deferred value');

-- Erin registers and clocks in.
select pg_temp.act_as(:erin);
create temp table dev on commit drop as
  select device_id from public.register_device('macos', '26.0', '0.1.0', 'hash-erin-deferred');
grant select on dev to authenticated;
create function pg_temp.dev() returns uuid language sql as $$ select device_id from dev $$;
create function pg_temp.send(events jsonb) returns jsonb
language sql as $$ select public.agent_events(pg_temp.dev(), events) $$;

create temp table r on commit drop as
  select pg_temp.send(jsonb_build_array(
    pg_temp.ev(pg_temp.id(1), 1, 'clock_in', '{"reason": "manual"}', '60 minutes'),
    -- A miss first, so the status is Away and a deferral must not change that.
    pg_temp.ev(pg_temp.id(2), 2, 'checkin', jsonb_build_object(
      'scheduled_at', pg_temp.ts('50 minutes'), 'shown_at', pg_temp.ts('50 minutes'),
      'outcome', 'miss', 'wrong_clicks', 0, 'object_keys', '[]'::jsonb,
      'flags', '[]'::jsonb), '48 minutes')
  )) as res;
grant all on r to authenticated;
select is((select res -> 'accepted' from r), jsonb_build_array(pg_temp.id(1), pg_temp.id(2)),
  'clock-in and a miss are accepted');

select pg_temp.act_as_postgres();
select is((select status::text from public.presence where user_id = :erin), 'away', 'after a miss the status is Away');

-- A deferral -----------------------------------------------------------------------

select pg_temp.act_as(:erin);
update r set res = pg_temp.send(jsonb_build_array(
  pg_temp.ev(pg_temp.id(3), 3, 'checkin', pg_temp.deferred('30 minutes'), '30 minutes'),
  pg_temp.ev(pg_temp.id(4), 4, 'checkin', pg_temp.deferred('20 minutes', '{"deferral_reason": "screen_share"}'), '20 minutes'),
  pg_temp.ev(pg_temp.id(5), 5, 'checkin', pg_temp.deferred('10 minutes', '{"deferral_reason": "presenting"}'), '10 minutes')
));
select is((select res -> 'accepted' from r),
  jsonb_build_array(pg_temp.id(3), pg_temp.id(4), pg_temp.id(5)),
  'deferred check-ins for a call, a screen share and a presentation are accepted');

select pg_temp.act_as_postgres();
select is(
  (select array_agg(deferral_reason order by scheduled_at) from public.checkin_events where outcome = 'deferred'),
  array['call', 'screen_share', 'presenting'], 'each row stores its reason');
select is(
  (select count(*)::int from public.checkin_events
   where outcome = 'deferred' and shown_at is null and responded_at is null
     and response_ms is null and object_keys = '{}'),
  3, 'a deferral has no shown time, no response and no capture');
select is(
  (select to_char(scheduled_at at time zone 'UTC', 'HH24:MI') from public.checkin_events where id = pg_temp.id(3)),
  to_char((now() - interval '30 minutes') at time zone 'UTC', 'HH24:MI'), 'scheduled_at is the time it was due');
select is(
  (select outcome::text from public.checkin_events where id = pg_temp.id(2)), 'miss',
  'the miss is still a miss');
select is(
  (select last_checkin_outcome::text from public.presence where user_id = :erin), 'miss',
  'a deferral is not a pass: the last check-in is still the miss');
select is((select status::text from public.presence where user_id = :erin), 'away',
  'and the status stays Away (no pass since the miss)');

-- Validation -----------------------------------------------------------------------

select pg_temp.act_as(:erin);
update r set res = pg_temp.send(jsonb_build_array(
  pg_temp.ev(pg_temp.id(6), 6, 'checkin', pg_temp.deferred('9 minutes', '{"deferral_reason": null}'), '9 minutes'),
  pg_temp.ev(pg_temp.id(7), 7, 'checkin', pg_temp.deferred('8 minutes', '{"outcome": "miss"}'), '8 minutes'),
  pg_temp.ev(pg_temp.id(8), 8, 'checkin', pg_temp.deferred('7 minutes', '{"object_keys": ["screen-1.webp"]}'), '7 minutes'),
  pg_temp.ev(pg_temp.id(9), 9, 'checkin', pg_temp.deferred('6 minutes', '{"response_ms": 1200}'), '6 minutes'),
  pg_temp.ev(pg_temp.id(10), 10, 'checkin', pg_temp.deferred('5 minutes', '{"deferral_reason": "lunch"}'), '5 minutes')
));
select is((select res -> 'rejected' -> 0 ->> 'reason' from r), 'invalid_checkin', 'a deferral without a reason is rejected');
select is((select res -> 'rejected' -> 1 ->> 'reason' from r), 'invalid_checkin', 'a reason on a miss is rejected');
select is((select res -> 'rejected' -> 2 ->> 'reason' from r), 'invalid_checkin', 'a deferral that lists captures is rejected');
select is((select res -> 'rejected' -> 3 ->> 'reason' from r), 'invalid_checkin', 'a deferral with a response time is rejected');
select is((select res -> 'rejected' -> 4 ->> 'reason' from r), 'invalid_event', 'an unknown reason fails the schema');

-- A deferral can't get a capture -----------------------------------------------------

select pg_temp.act_as_postgres();
select throws_ok(
  format($q$insert into public.checkin_events (id, org_id, user_id, device_id, scheduled_at, outcome, deferral_reason, object_keys)
    values (gen_random_uuid(), %L, %L, %L, now(), 'deferred', 'call', array['screen-1.webp'])$q$,
    :org, :erin, pg_temp.dev()),
  '23514', null, 'the table refuses captures on a deferred check-in');

create function pg_temp.upload(path text) returns void
language sql as $$
  insert into storage.objects (bucket_id, name, owner_id) values ('captures', path, auth.uid()::text);
$$;
select pg_temp.act_as(:erin);
select throws_ok(
  format('select pg_temp.upload(%L)', format('%s/%s/%s/%s/screen-1.webp', :org, :erin,
    to_char((now() - interval '30 minutes') at time zone 'UTC', 'YYYY-MM-DD'), pg_temp.id(3))),
  '42501', null, 'the storage policy refuses a file for a deferred check-in');

select * from finish();
rollback;
