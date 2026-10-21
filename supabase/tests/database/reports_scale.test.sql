begin;
create extension if not exists pgtap with schema extensions;

select plan(10);

-- #156: report_rows holds up to 1000 people (too_many_people, 54000), counting the way it
-- picks them: deactivated people only when they have data in the span. The indexes that
-- keep it fast for 500 people (scripts/it-reports-scale.sql times it) exist.
-- Seed org: Ada owner -> Max manager -> Erin, Lucas. Ada's report holds those three; 997
-- more people under Ada bring it to exactly 1000.
\set ada '''00000000-0000-4000-8000-0000000000a1'''
\set max '''00000000-0000-4000-8000-0000000000b1'''
\set org '''00000000-0000-4000-8000-000000000001'''

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

create function pg_temp.person(n int) returns uuid
language sql immutable as $$
  select ('00000000-0000-4000-8000-' || lpad(to_hex(4096 + n), 12, '0'))::uuid
$$;

-- The report's row count, as the owner (everyone but herself) or for one manager's team.
create function pg_temp.count_all() returns int
language sql as $$
  select (public.report_rows('2026-03-16', '2026-03-22') ->> 'row_count')::int
$$;

select has_index('public', 'checkin_events', 'checkin_events_user_effective_idx',
  'check-ins are indexed by person and by when they were shown (or else scheduled)');
select has_index('public', 'clock_sessions', 'clock_sessions_user_end_idx',
  'clock sessions are indexed by person and by when they ended');

insert into auth.users (id, email)
select pg_temp.person(g), 'scale' || g || '@scale.test' from generate_series(1, 997) g;
insert into public.users (id, org_id, full_name, email, role, manager_id, active, timezone)
select pg_temp.person(g), :org, 'Scale ' || lpad(g::text, 4, '0'), 'scale' || g || '@scale.test',
  'employee', :ada, true, 'UTC'
from generate_series(1, 997) g;

select pg_temp.act_as(:ada);
select is(pg_temp.count_all(), 1000, 'exactly 1000 people is a report');

select pg_temp.act_as_postgres();
insert into auth.users (id, email) values (pg_temp.person(998), 'scale998@scale.test');
insert into public.users (id, org_id, full_name, email, role, manager_id, active, timezone)
values (pg_temp.person(998), :org, 'Scale 0998', 'scale998@scale.test', 'employee', :ada, true, 'UTC');

select pg_temp.act_as(:ada);
select throws_ok($$ select pg_temp.count_all() $$, '54000', 'too_many_people',
  'one more person is refused');

select pg_temp.act_as_postgres();
update public.users set active = false where id = pg_temp.person(998);
select pg_temp.act_as(:ada);
select is(pg_temp.count_all(), 1000, 'a deactivated person with no data in the span does not count');

select pg_temp.act_as_postgres();
insert into public.time_segments (org_id, user_id, day, start_at, end_at, type, counted, flagged)
values (:org, pg_temp.person(998), '2026-03-17', '2026-03-17 09:00:00+00', '2026-03-17 10:00:00+00',
  'verified', true, false);
select pg_temp.act_as(:ada);
select throws_ok($$ select pg_temp.count_all() $$, '54000', 'too_many_people',
  'but one with time in the span does');

select is((public.report_rows('2026-03-23', '2026-03-29') ->> 'row_count')::int, 1000,
  'and not outside the span');

select is((public.report_rows('2026-03-16', '2026-03-22', null, :max) ->> 'row_count')::int, 2,
  'a team is a way under the ceiling (Max has Erin and Lucas)');
select is((public.report_rows('2026-03-16', '2026-03-22', array[pg_temp.person(5)]) ->> 'row_count')::int, 1,
  'so are named people');

select pg_temp.act_as(:max);
select is(pg_temp.count_all(), 2, 'a manager whose team is small is not affected by the size of the org');

select * from finish();
rollback;
