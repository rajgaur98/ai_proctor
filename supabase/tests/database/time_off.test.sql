-- #304: time off (LV-01..04, LV-07): leave types, holidays, requests and their approval,
-- and what leave changes (On leave status, late clock-ins, alerts, the agent's config).
begin;
create extension if not exists pgtap with schema extensions;

select plan(104);

\set ada '''00000000-0000-4000-8000-0000000000a1'''
\set max '''00000000-0000-4000-8000-0000000000b1'''
\set erin '''00000000-0000-4000-8000-0000000000c1'''
\set lucas '''00000000-0000-4000-8000-0000000000c2'''
\set org '''00000000-0000-4000-8000-000000000001'''
\set dev '''00000000-0000-4000-8000-00000000d304'''

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

create table pg_temp.ids (name text primary key, id uuid);
grant select, insert on pg_temp.ids to authenticated;
create function pg_temp.id(p_name text) returns uuid
language sql as $$ select id from pg_temp.ids where name = p_name $$;

-- Read as the database owner.
create function pg_temp.audited(act text) returns int
language sql security definer as $$
  select count(*)::int from public.audit_log where action = act
$$;
create function pg_temp.audit_meta(act text, p_request uuid) returns jsonb
language sql security definer as $$
  select metadata from public.audit_log
  where action = act and metadata ->> 'request_id' = p_request::text order by id desc limit 1
$$;
create function pg_temp.told(uid uuid, p_kind text) returns int
language sql security definer as $$
  select count(*)::int from public.notifications where user_id = uid and kind = p_kind
$$;
create function pg_temp.req(p_name text) returns public.leave_requests
language sql security definer as $$
  select * from public.leave_requests where id = (select id from pg_temp.ids where name = p_name)
$$;
create function pg_temp.status_of(uid uuid) returns text
language sql security definer as $$ select status::text from public.presence where user_id = uid $$;
create function pg_temp.config_version(uid uuid) returns int
language sql security definer as $$ select config_version from public.users where id = uid $$;
create function pg_temp.type_id(p_name text) returns uuid
language sql security definer as $$
  select id from public.leave_types
  where org_id = '00000000-0000-4000-8000-000000000001' and name = p_name
$$;

-- Erin is in America/Los_Angeles with a 9-to-5 weekday shift there. Her dates come from
-- her today, never current_date. mon/tue/wed: a past week (Monday two weeks back, within
-- the 31 days a request may reach back).
create function pg_temp.today() returns date
language sql as $$ select (now() at time zone 'America/Los_Angeles')::date $$;
create function pg_temp.mon() returns date
language sql as $$ select date_trunc('week', pg_temp.today())::date - 14 $$;
create function pg_temp.la(p_day date, p_time text) returns timestamptz
language sql as $$ select (p_day::text || ' ' || p_time)::timestamp at time zone 'America/Los_Angeles' $$;

select has_table('public', 'leave_types', 'leave_types exists');
select has_table('public', 'holidays', 'holidays exists');
select has_table('public', 'leave_requests', 'leave_requests exists');

-- Leave types (LV-01) ---------------------------------------------------------------------

select results_eq(
  $$ select name, paid from public.leave_types where org_id = '00000000-0000-4000-8000-000000000001'
     order by name $$,
  $$ values ('Personal', true), ('Sick', true), ('Unpaid', false), ('Vacation', true) $$,
  'the seed org starts with Vacation, Sick and Personal (paid) and Unpaid'
);
insert into public.orgs (id, name, data_region, region_preset)
values ('00000000-0000-4000-8000-0000000003a4', 'Other org', 'us', 'us');
select is((select count(*)::int from public.leave_types where org_id = '00000000-0000-4000-8000-0000000003a4'),
  4, 'a new org gets the four default types');

select pg_temp.act_as(:erin);
select is((select count(*)::int from public.leave_types), 4, 'an employee reads her org''s types, not another org''s');
select throws_ok($$ insert into public.leave_types (org_id, name) values ('00000000-0000-4000-8000-000000000001', 'Sneaky') $$,
  '42501', null, 'leave_types: no direct writes');
select throws_ok($$ select public.save_leave_type(null, 'Jury duty', true) $$,
  '42501', 'admin_only', 'an employee can''t add a type');
select pg_temp.act_as(:max);
select throws_ok($$ select public.save_leave_type(null, 'Jury duty', true) $$,
  '42501', 'admin_only', 'nor can a manager');

select pg_temp.act_as(:ada);
insert into pg_temp.ids values ('jury', public.save_leave_type(null, 'Jury duty', true));
select is((select paid from public.leave_types where id = pg_temp.id('jury')), true, 'an admin adds a paid type');
select is(pg_temp.audited('leave_type.created'), 1, 'and it is audit-logged');
select throws_ok($$ select public.save_leave_type(null, ' vacation ', true) $$,
  '23505', 'name_taken', 'names are unique in the org, ignoring case and spaces');
select throws_ok($$ select public.save_leave_type(null, '', true) $$,
  '22023', 'invalid_leave_type', 'a name is needed');
select lives_ok(format($$ select public.save_leave_type(%L, 'Jury service', false, true) $$, pg_temp.id('jury')),
  'renamed, made unpaid and archived');
select results_eq(
  format($$ select name, paid, archived from public.leave_types where id = %L $$, pg_temp.id('jury')),
  $$ values ('Jury service', false, true) $$, 'all three are saved');
select pg_temp.act_as_postgres();
select is(
  (select metadata -> 'changed' ? 'archived' from public.audit_log where action = 'leave_type.changed'),
  true, 'the change is audit-logged with what changed');

-- Holidays (LV-02) ------------------------------------------------------------------------

select pg_temp.act_as(:erin);
select throws_ok($$ select public.save_holiday(null, current_date, 'Mine') $$,
  '42501', 'admin_only', 'an employee can''t add a holiday');
select throws_ok($$ insert into public.holidays (org_id, day, name) values ('00000000-0000-4000-8000-000000000001', current_date, 'x') $$,
  '42501', null, 'holidays: no direct writes');

select pg_temp.act_as(:ada);
select throws_ok($$ select public.save_holiday(null, current_date, 'Bad', 'DE', 'BY') $$,
  '22023', 'invalid_holiday', 'a state is only for the US');
select throws_ok($$ select public.save_holiday(null, current_date, 'Bad', 'usa') $$,
  '22023', 'invalid_holiday', 'a country is a two-letter code');
-- Wednesday of the past week: California only.
insert into pg_temp.ids values ('ca_day', public.save_holiday(null, pg_temp.mon() + 2, 'Cesar Chavez Day', 'us', 'ca'));
select results_eq(
  format($$ select country, state from public.holidays where id = %L $$, pg_temp.id('ca_day')),
  $$ values ('US'::text, 'CA'::text) $$, 'codes are stored upper case');
select throws_ok(format($$ select public.save_holiday(null, %L, 'Again', 'US', 'CA') $$, pg_temp.mon() + 2),
  '23505', 'holiday_exists', 'one holiday per date and place');
select is(pg_temp.audited('holiday.added'), 1, 'adding a holiday is audit-logged');

select pg_temp.act_as(:lucas);
select is((select count(*)::int from public.holidays), 1, 'everyone in the org reads the calendar');

-- on_leave_at: the holiday applies by work location.
select pg_temp.act_as_postgres();
select ok(internal.on_leave_at(:erin, pg_temp.la(pg_temp.mon() + 2, '12:00')),
  'a California holiday applies to Erin (US, CA) all her local day');
select ok(not internal.on_leave_at(:erin, pg_temp.la(pg_temp.mon() + 3, '00:30')),
  'and not the next day');
select ok(not internal.on_leave_at(:lucas, pg_temp.la(pg_temp.mon() + 2, '12:00')),
  'nor to Lucas (US, TX)');
select ok(internal.holiday_applies(null, null, 'IN', null), 'a holiday with no place applies to everyone');
select ok(internal.holiday_applies('US', null, 'US', 'TX'), 'a US holiday applies to every state');
select ok(not internal.holiday_applies('GB', null, 'US', 'TX'), 'another country''s doesn''t');

-- Requests (LV-03) -------------------------------------------------------------------------

select pg_temp.act_as(:erin);
select throws_ok(format($$ select public.request_leave(%L, %L) $$, pg_temp.id('jury'), pg_temp.today() + 5),
  '22023', 'leave_type_not_found', 'an archived type can''t be asked for');
select throws_ok(format($$ select public.request_leave(%L, %L) $$, pg_temp.type_id('Vacation'), pg_temp.today() - 40),
  '22023', 'invalid_dates', 'not more than 31 days back');
select throws_ok(format($$ select public.request_leave(%L, %L, %L) $$, pg_temp.type_id('Vacation'),
    pg_temp.today() + 5, pg_temp.today() + 4),
  '22023', 'invalid_dates', 'the last day is not before the first');
select throws_ok(format($$ select public.request_leave(%L, %L, null, '15:00', '13:00') $$,
    pg_temp.type_id('Vacation'), pg_temp.today() + 5),
  '22023', 'invalid_times', 'a part day ends after it starts');
select throws_ok(format($$ select public.request_leave(%L, %L, %L, '13:00', '15:00') $$,
    pg_temp.type_id('Vacation'), pg_temp.today() + 5, pg_temp.today() + 6),
  '22023', 'invalid_times', 'a part day is one day');

-- A week of vacation ahead, and a part day after it.
insert into pg_temp.ids values
  ('trip', public.request_leave(pg_temp.type_id('Vacation'), pg_temp.today() + 10, pg_temp.today() + 14,
    null, null, 'Family trip')),
  ('dentist', public.request_leave(pg_temp.type_id('Personal'), pg_temp.today() + 20, null,
    '13:00', '15:30', null));
select results_eq(
  $$ select status, kind, paid, timezone, note from pg_temp.req('trip') $$,
  $$ values ('pending'::text, 'days'::text, true, 'America/Los_Angeles'::text, 'Family trip'::text) $$,
  'a request is pending, whole days, paid as its type, in her zone, with her note');
select is((pg_temp.req('trip')).start_at, pg_temp.la(pg_temp.today() + 10, '00:00'),
  'whole days start at her local midnight');
select is((pg_temp.req('trip')).end_at, pg_temp.la(pg_temp.today() + 15, '00:00'),
  'and end at the midnight after the last day');
select results_eq(
  $$ select kind, first_day = last_day, end_at - start_at from pg_temp.req('dentist') $$,
  $$ values ('part_day'::text, true, interval '2 hours 30 minutes') $$,
  'a part day is its own span');
select throws_ok(format($$ select public.request_leave(%L, %L) $$, pg_temp.type_id('Sick'), pg_temp.today() + 12),
  '23P01', 'leave_overlaps', 'a request can''t overlap a pending one');
select is(pg_temp.told(:max, 'leave.requested'), 2, 'her manager is told of each request');
select is(pg_temp.told(:ada, 'leave.requested'), 0, 'an admin who isn''t her manager is not');
select is(pg_temp.audited('leave.requested'), 2, 'each request is audit-logged');
select is(
  pg_temp.audit_meta('leave.requested', pg_temp.id('trip')) ->> 'note_length',
  '11', 'with the note''s length, not its words');

-- Reading: who sees what.
select is((select count(*)::int from public.leave_requests_list()), 2, 'Erin lists her own requests');
select ok((select bool_and(can_cancel and not can_decide) from public.leave_requests_list()),
  'which she may cancel and not decide');
select pg_temp.act_as(:lucas);
select is((select count(*)::int from public.leave_requests_list()), 0, 'Lucas sees none of hers');
select is((select count(*)::int from public.leave_requests), 0, 'nor through the table');
select pg_temp.act_as(:max);
select ok((select bool_and(can_decide and not can_cancel) from public.leave_requests_list(p_user_id => :erin)),
  'her manager may decide them');
select is((select employee_name from public.leave_requests_list() limit 1), 'Erin Employee',
  'with her name and the type''s');
select pg_temp.act_as(:ada);
select is((select count(*)::int from public.leave_requests_list(p_user_id => :erin)), 2, 'the owner reads them');
select ok((select not bool_or(can_decide) from public.leave_requests_list(p_user_id => :erin)),
  'but, not being her manager, may not decide');

-- Deciding.
select pg_temp.act_as(:erin);
select throws_ok(format($$ select public.decide_leave(%L, true) $$, pg_temp.id('trip')),
  '42501', 'not_allowed', 'she can''t approve her own');
select pg_temp.act_as(:ada);
select throws_ok(format($$ select public.decide_leave(%L, true) $$, pg_temp.id('trip')),
  '42501', 'not_allowed', 'an owner who isn''t her manager can''t either (TS-12)');
select pg_temp.act_as(:lucas);
select throws_ok(format($$ select public.decide_leave(%L, true) $$, pg_temp.id('trip')),
  '42501', 'leave_not_found', 'another employee doesn''t even see it');

select pg_temp.act_as_postgres();
create temp table cv as select pg_temp.config_version(:erin) as v;
grant select on cv to authenticated;
select pg_temp.act_as(:max);
select lives_ok(format($$ select public.decide_leave(%L, true, 'Enjoy') $$, pg_temp.id('trip')),
  'her manager approves');
select results_eq(
  $$ select status, decided_by_name, decision_note from pg_temp.req('trip') $$,
  $$ values ('approved'::text, 'Max Manager'::text, 'Enjoy'::text) $$, 'approved by him, with his note');
select is(pg_temp.told(:erin, 'leave.approved'), 1, 'Erin is told');
select is(pg_temp.audited('leave.approved'), 1, 'the approval is audit-logged');
select cmp_ok(pg_temp.config_version(:erin), '>', (select v from cv), 'her agent will refetch its config');
select throws_ok(format($$ select public.decide_leave(%L, false) $$, pg_temp.id('trip')),
  '55000', 'not_pending', 'a decided request can''t be decided again');

-- An active delegate decides too: Max hands approval to Ada for today.
select pg_temp.act_as_postgres();
insert into public.delegations (org_id, manager_id, delegate_id, starts_on, ends_on)
values (:org, :max, :ada, current_date - 1, current_date + 1);
select pg_temp.act_as(:ada);
select lives_ok(format($$ select public.decide_leave(%L, false, 'Busy week') $$, pg_temp.id('dentist')),
  'his active delegate rejects');
select is((pg_temp.req('dentist')).status, 'rejected', 'rejected');
select is(pg_temp.told(:erin, 'leave.rejected'), 1, 'Erin is told of the rejection');
select pg_temp.act_as_postgres();
delete from public.delegations where manager_id = :max and delegate_id = :ada;

-- Cancelling.
select pg_temp.act_as(:erin);
insert into pg_temp.ids values
  ('later', public.request_leave(pg_temp.type_id('Sick'), pg_temp.today() + 25));
select pg_temp.act_as(:max);
select throws_ok(format($$ select public.cancel_leave(%L) $$, pg_temp.id('later')),
  '42501', 'not_allowed', 'only the employee cancels');
select pg_temp.act_as(:erin);
select lives_ok(format($$ select public.cancel_leave(%L) $$, pg_temp.id('later')), 'she cancels a pending one');
select lives_ok(format($$ select public.cancel_leave(%L) $$, pg_temp.id('trip')),
  'and an approved one that hasn''t started');
select is((pg_temp.req('trip')).status, 'cancelled', 'cancelled');
select is(pg_temp.told(:max, 'leave.cancelled'), 2, 'her manager is told of both');
select is(pg_temp.audited('leave.cancelled'), 2, 'both are audit-logged');
select throws_ok(format($$ select public.cancel_leave(%L) $$, pg_temp.id('dentist')),
  '55000', 'cannot_cancel', 'a rejected one can''t be cancelled');
select lives_ok(format($$ select public.request_leave(%L, %L) $$, pg_temp.type_id('Sick'), pg_temp.today() + 12),
  'a cancelled request no longer blocks the days');

-- The owner at the top has no one to ask.
select pg_temp.act_as(:ada);
insert into pg_temp.ids values ('ada_off', public.request_leave(pg_temp.type_id('Vacation'), current_date + 40));
select results_eq($$ select status, decided_by_name from pg_temp.req('ada_off') $$,
  $$ values ('approved'::text, 'Ada Admin'::text) $$, 'the owner''s own request is approved when asked');

-- On leave (LV-04) ---------------------------------------------------------------------------

-- Leave already taken: Erin was off on Monday of the past week (asked now, approved).
select pg_temp.act_as(:erin);
insert into pg_temp.ids values ('monday', public.request_leave(pg_temp.type_id('Sick'), pg_temp.mon()));
select pg_temp.act_as(:max);
select public.decide_leave(pg_temp.id('monday'), true);
select pg_temp.act_as_postgres();
select ok(internal.on_leave_at(:erin, pg_temp.la(pg_temp.mon(), '09:00')), 'Erin is on leave that Monday');
select ok(not internal.on_leave_at(:erin, pg_temp.la(pg_temp.mon() + 1, '09:00')), 'and not on Tuesday');

-- She clocked in late that Monday and on Tuesday anyway: only Tuesday is a late clock-in.
insert into public.devices (id, org_id, user_id, platform, os_version, agent_version, hardware_hash)
values (:dev, :org, :erin, 'macos', '26.0', '0.1.0', 'hash-time-off');
insert into public.clock_sessions (org_id, user_id, device_id, start_at, end_at, start_event_id) values
  (:org, :erin, :dev, pg_temp.la(pg_temp.mon(), '10:30'), pg_temp.la(pg_temp.mon(), '17:00'), gen_random_uuid()),
  (:org, :erin, :dev, pg_temp.la(pg_temp.mon() + 1, '10:30'), pg_temp.la(pg_temp.mon() + 1, '17:00'), gen_random_uuid());
select is((select count(*)::int from public.late_clock_ins where user_id = :erin and day = pg_temp.mon()), 0,
  'no late clock-in is recorded on a leave day (clocking in still works)');
select is((select count(*)::int from public.late_clock_ins where user_id = :erin and day = pg_temp.mon() + 1), 1,
  'the next day is late as usual');
-- Then she asks for that Tuesday after all, and it is approved: the late row goes.
select pg_temp.act_as(:erin);
insert into pg_temp.ids values ('tuesday', public.request_leave(pg_temp.type_id('Personal'), pg_temp.mon() + 1));
select pg_temp.act_as(:max);
select public.decide_leave(pg_temp.id('tuesday'), true);
select is((select count(*)::int from public.late_clock_ins where user_id = :erin and day = pg_temp.mon() + 1), 0,
  'approving leave removes the late clock-in it now covers');

-- Alerts: no late clock-in alert for a shift that starts on leave or a holiday. Thursday
-- of the past week has neither; Wednesday is the California holiday.
select pg_temp.act_as_postgres();
select internal.alert_eval(pg_temp.la(pg_temp.mon() + 1, '10:00'));
select internal.alert_eval(pg_temp.la(pg_temp.mon() + 2, '10:00'));
select internal.alert_eval(pg_temp.la(pg_temp.mon() + 3, '10:00'));
select is((select count(*)::int from public.alerts where user_id = :erin and kind = 'late_clock_in'
   and episode = (extract(epoch from pg_temp.la(pg_temp.mon() + 3, '09:00')) * 1000000)::bigint::text), 1,
  'a working day raises the late clock-in alert');
select is((select count(*)::int from public.alerts where user_id = :erin and kind = 'late_clock_in'
   and episode in ((extract(epoch from pg_temp.la(pg_temp.mon() + 1, '09:00')) * 1000000)::bigint::text,
                   (extract(epoch from pg_temp.la(pg_temp.mon() + 2, '09:00')) * 1000000)::bigint::text)), 0,
  'an approved leave day and a holiday don''t');

-- Offline: Erin clocked in and Offline since a moment on leave raises nothing; Lucas, not on
-- leave, does.
insert into public.devices (id, org_id, user_id, platform, os_version, agent_version, hardware_hash)
values ('00000000-0000-4000-8000-00000000d305', :org, :lucas, 'macos', '26.0', '0.1.0', 'hash-time-off-2');
insert into public.clock_sessions (org_id, user_id, device_id, start_at, start_event_id) values
  (:org, :erin, :dev, pg_temp.la(pg_temp.mon(), '09:00'), gen_random_uuid()),
  (:org, :lucas, '00000000-0000-4000-8000-00000000d305', pg_temp.la(pg_temp.mon(), '09:00'), gen_random_uuid());
update public.presence set status = 'offline', since = pg_temp.la(pg_temp.mon(), '11:00')
where user_id in (:erin, :lucas);
select internal.alert_eval(pg_temp.la(pg_temp.mon(), '12:00'));
select is((select count(*)::int from public.alerts where user_id = :erin and kind = 'offline'), 0,
  'no offline alert for an Offline period that began on leave');
select is((select count(*)::int from public.alerts where user_id = :lucas and kind = 'offline'), 1,
  'someone not on leave gets it as usual');
delete from public.clock_sessions where end_at is null and user_id in (:erin, :lucas);
update public.presence set status = 'off_shift', since = now() where user_id in (:erin, :lucas);

-- Status: a holiday today in California makes Erin On leave at once, not Lucas.
select pg_temp.act_as(:ada);
insert into pg_temp.ids values ('today_ca', public.save_holiday(null, pg_temp.today(), 'Today', 'US', 'CA'));
select is(pg_temp.status_of(:erin), 'on_leave', 'Erin, not clocked in, is On leave on a holiday');
select is(pg_temp.status_of(:lucas), 'off_shift', 'Lucas, elsewhere, is Off shift');
select is(
  (select count(*)::int from public.status_periods where user_id = :erin and status = 'on_leave' and end_at is null),
  1, 'the On leave period is on her timeline');
select lives_ok(format($$ select public.save_holiday(%L, %L, 'Today, renamed', 'US', 'CA') $$,
    pg_temp.id('today_ca'), pg_temp.today()), 'a holiday is changed');
select is(pg_temp.audited('holiday.changed'), 1, 'and that is audit-logged');
select lives_ok(format($$ select public.delete_holiday(%L) $$, pg_temp.id('today_ca')), 'and removed');
select is(pg_temp.audited('holiday.removed'), 1, 'removing is audit-logged');
select is(pg_temp.status_of(:erin), 'off_shift', 'Erin is back to Off shift');

-- Clocked in on a leave day: tracked as normal.
select pg_temp.act_as_postgres();
select is(internal.status_input(:erin, pg_temp.la(pg_temp.mon(), '12:00')) ->> 'on_leave', 'true',
  'the status inputs carry leave (clocked in, the usual rules apply: see the status vectors)');

-- The sweep: a holiday written without the functions (a midnight passing is the same) is
-- picked up within a minute.
insert into public.holidays (org_id, day, name) values (:org, pg_temp.today(), 'Everyone off');
select cmp_ok(internal.leave_sweep(), '>=', 2, 'the sweep refreshes whoever''s leave began');
select is(pg_temp.status_of(:lucas), 'on_leave', 'Lucas is On leave too');
delete from public.holidays where org_id = :org and day = pg_temp.today();
select cmp_ok(internal.leave_sweep(), '>=', 2, 'and again when it ends');
select is(pg_temp.status_of(:lucas), 'off_shift', 'Lucas is Off shift again');
select is(internal.leave_sweep(), 0, 'with nothing changed, it does nothing');

-- The agent: no auto clock-in inside leave (SHF-03).
select pg_temp.act_as(:erin);
insert into pg_temp.ids values ('ahead', public.request_leave(pg_temp.type_id('Vacation'), pg_temp.today() + 30));
select pg_temp.act_as(:max);
select public.decide_leave(pg_temp.id('ahead'), true);
select pg_temp.act_as_postgres();
select ok(
  internal.leave_spans(:erin, now()) @> jsonb_build_array(jsonb_build_object(
    'start', pg_temp.la(pg_temp.today() + 30, '00:00'), 'end', pg_temp.la(pg_temp.today() + 31, '00:00'))),
  'approved leave ahead is in the agent''s leave spans');
select ok(
  not (internal.leave_spans(:erin, now()) @> jsonb_build_array(jsonb_build_object(
    'start', pg_temp.la(pg_temp.mon(), '00:00'), 'end', pg_temp.la(pg_temp.mon() + 1, '00:00')))),
  'leave that is over is not');
insert into public.holidays (org_id, day, name, country, state) values (:org, pg_temp.today() + 3, 'Ahead', 'US', 'CA');
select ok(
  internal.leave_spans(:erin, now()) @> jsonb_build_array(jsonb_build_object(
    'start', pg_temp.la(pg_temp.today() + 3, '00:00'), 'end', pg_temp.la(pg_temp.today() + 4, '00:00'))),
  'a holiday ahead that applies is her whole local day');
select is(jsonb_array_length(internal.leave_spans(:lucas, now())), 0, 'a holiday elsewhere is not in Lucas''s');
select ok(
  (select prosrc like '%leave_spans%' from pg_proc where oid = 'public.agent_config(uuid)'::regprocedure),
  'agent_config sends the spans');

-- Retention and deletion (LV-07) ---------------------------------------------------------------

insert into public.leave_requests (org_id, user_id, leave_type_id, paid, kind, first_day, last_day,
  start_at, end_at, timezone, status)
values (:org, :lucas, pg_temp.type_id('Sick'), true, 'days', current_date - 4000, current_date - 4000,
  now() - interval '4000 days', now() - interval '3999 days', 'UTC', 'approved');
select is((select (public.retention_purge_rows() ->> 'leave_requests')::int), 1,
  'a request older than the timesheet window is purged');
select is((select count(*)::int from public.leave_requests where user_id = :lucas), 0, 'and gone');
select is((select count(*)::int from public.leave_requests where user_id = :erin and status = 'approved'), 3,
  'recent ones stay');

select * from finish();
rollback;
