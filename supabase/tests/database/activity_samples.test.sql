begin;
create extension if not exists pgtap with schema extensions;

select plan(14);

\set erin '''00000000-0000-4000-8000-0000000000c1'''
\set lucas '''00000000-0000-4000-8000-0000000000c2'''
\set max '''00000000-0000-4000-8000-0000000000b1'''

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

create function pg_temp.ts(t timestamptz) returns text
language sql as $$ select to_char(t at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') $$;

create temp table seqs (n int);
insert into seqs values (0);
grant all on seqs to authenticated;

-- A whole minute 20 minutes ago, so every bucket below is in the past.
create temp table m as select date_trunc('minute', now() - interval '20 minutes') as t;
grant select on m to authenticated;

-- Sends one event and returns its rejection reason (null when accepted).
create function pg_temp.send(type text, payload jsonb, at timestamptz)
returns text
language plpgsql as $$
declare
  n int;
begin
  update seqs set n = seqs.n + 1 returning seqs.n into n;
  return public.agent_events(
    (select device_id from dev),
    jsonb_build_array(jsonb_build_object('id', gen_random_uuid(), 'seq', n, 'type', type,
      'at', pg_temp.ts(at), 'mono_ms', n, 'payload', payload))
  ) -> 'rejected' -> 0 ->> 'reason';
end;
$$;

create function pg_temp.app(app text, title text, domain text, start_s int, end_s int)
returns jsonb
language sql as $$
  select jsonb_build_object('app', app, 'title', title, 'domain', domain,
    'start', pg_temp.ts((select t from m) + make_interval(secs => start_s)),
    'end', pg_temp.ts((select t from m) + make_interval(secs => end_s)))
$$;

select pg_temp.act_as(:erin);
create temp table dev as select device_id from public.register_device('macos', '26.0', '0.1.0', 'hash-erin-activity');
grant select on dev to authenticated;

select is(pg_temp.send('app_session', pg_temp.app('Safari', 'Docs', 'example.com', 0, 30), (select t from m)),
  'not_working', 'nothing is recorded off shift');

select pg_temp.send('clock_in', '{"reason": "manual"}', (select t from m) - interval '1 hour');

select is(pg_temp.send('app_session', pg_temp.app('Safari', 'Q3 plan - Docs', 'Docs.Example.com', 0, 42),
  (select t from m) + interval '42 seconds'), null, 'a minute bucket is accepted');
select is(pg_temp.send('app_session', pg_temp.app('Slack', 'general', null, 42, 60),
  (select t from m) + interval '1 minute'), null, 'a second app in the same minute');
select is(pg_temp.send('app_session', pg_temp.app('Slack', 'general', null, 50, 75),
  (select t from m) + interval '75 seconds'), 'invalid_app_session', 'a bucket that crosses the minute is rejected');
select is(pg_temp.send('app_session', pg_temp.app('1Password', 'Bank login', null, 0, 10),
  (select t from m) + interval '2 minutes'), null, 'an excluded app is accepted');

select pg_temp.send('break_start', '{"planned_min": 15}', (select t from m) + interval '3 minutes');
select is(pg_temp.send('app_session', pg_temp.app('Safari', 'Docs', null, 190, 220),
  (select t from m) + interval '4 minutes'), 'not_working', 'nothing is recorded on a break');
select pg_temp.send('break_end', '{}', (select t from m) + interval '5 minutes');
select pg_temp.send('clock_out', '{"reason": "manual"}', (select t from m) + interval '6 minutes');
select is(pg_temp.send('app_session', pg_temp.app('Xcode', 'Build', null, 330, 350),
  (select t from m) + interval '6 minutes 1 second'), null,
  'the last minute sent after clock-out is kept: judged by its own time');

select pg_temp.act_as_postgres();
select results_eq(
  $$ select app_name, window_title, domain, seconds from public.activity_samples
     where user_id = '00000000-0000-4000-8000-0000000000c1' and app_name in ('Safari', 'Slack') order by seconds desc $$,
  $$ values ('Safari', 'Q3 plan - Docs', 'docs.example.com', 42), ('Slack', 'general', null, 18) $$,
  'one row per bucket with seconds; domains are lower-cased'
);
select is((select minute from public.activity_samples where app_name = 'Safari' and user_id = :erin),
  (select t from m), 'stored against its minute');

-- ACT-02 / ACT-03: titles dropped for excluded apps and when the org turns them off.
update public.orgs set policy = policy || '{"excluded_apps": ["1password"]}'
where id = (select org_id from public.users where id = :erin);
select pg_temp.act_as(:erin);
select pg_temp.send('app_session', pg_temp.app('1Password', 'Bank login', null, 10, 20),
  (select t from m) + interval '2 minutes');
select pg_temp.act_as_postgres();
update public.orgs set policy = policy || '{"window_titles": false}'
where id = (select org_id from public.users where id = :erin);
select pg_temp.act_as(:erin);
select pg_temp.send('app_session', pg_temp.app('Mail', 'Re: salary review', null, 20, 30),
  (select t from m) + interval '2 minutes');
select pg_temp.act_as_postgres();
select is((select count(*)::int from public.activity_samples where app_name = '1Password' and user_id = :erin
  and window_title is not null), 1,
  'before the org listed it, the excluded app kept its title (the agent drops it on device)');
select is((select count(*)::int from public.activity_samples where app_name = '1Password' and user_id = :erin
  and window_title is null), 1, 'excluded app listed by the org: no title stored');
select is((select count(*)::int from public.activity_samples where app_name = 'Mail' and user_id = :erin
  and window_title is null), 1, 'window titles off: no title stored');

-- RLS: Erin's manager sees her activity, a peer doesn't.
select pg_temp.act_as(:max);
select ok((select count(*) from public.activity_samples where user_id = :erin) > 0, 'her manager can see it');
select pg_temp.act_as(:lucas);
select is((select count(*)::int from public.activity_samples where user_id = :erin), 0, 'a peer cannot');

select * from finish();
rollback;
