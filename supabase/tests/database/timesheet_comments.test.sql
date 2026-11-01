-- #265 (#254 part 6): comments on a week's rows and manual entries (TS-33, AUD-01), and the
-- approver's name for the lock banner.
begin;
create extension if not exists pgtap with schema extensions;

select plan(58);

\set ada '''00000000-0000-4000-8000-0000000000a1'''
\set max '''00000000-0000-4000-8000-0000000000b1'''
\set erin '''00000000-0000-4000-8000-0000000000c1'''
\set lucas '''00000000-0000-4000-8000-0000000000c2'''
\set revamp '''00000000-0000-4000-8000-0000000000f1'''
\set internal '''00000000-0000-4000-8000-0000000000f2'''
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

-- Ids by name, so the tests read in words.
create table pg_temp.ids (name text primary key, id uuid);
grant select, insert on pg_temp.ids to authenticated;
create function pg_temp.id(p_name text) returns uuid
language sql as $$ select id from pg_temp.ids where name = p_name $$;

-- Read as the database owner: the audit log and other people's notifications are closed.
create function pg_temp.audited(act text, target uuid) returns int
language sql security definer as $$
  select count(*)::int from public.audit_log where action = act and target_user_id = target
$$;
create function pg_temp.audit_meta(act text, target uuid) returns jsonb
language sql security definer as $$
  select metadata from public.audit_log where action = act and target_user_id = target
  order by id desc limit 1
$$;
create function pg_temp.audit_actor(p_comment uuid) returns text
language sql security definer as $$
  select actor_id::text from public.audit_log
  where action = 'timesheet.commented' and metadata ->> 'comment_id' = p_comment::text
$$;
create function pg_temp.told(uid uuid) returns int
language sql security definer as $$
  select count(*)::int from public.notifications where user_id = uid and kind = 'timesheet.commented'
$$;
-- What `uid` was told about one comment (null when nothing).
create function pg_temp.told_of(uid uuid, p_comment text) returns jsonb
language sql security definer as $$
  select payload from public.notifications
  where user_id = uid and kind = 'timesheet.commented'
    and payload ->> 'comment_id' = (select id from pg_temp.ids where name = p_comment)::text
$$;
create function pg_temp.comment(p_name text) returns public.timesheet_comments
language sql security definer as $$
  select * from public.timesheet_comments where id = (select id from pg_temp.ids where name = p_name)
$$;

-- Erin is in America/Los_Angeles: her weeks are her local days, so the week is found from
-- her today, not current_date (UTC), which is a day ahead every evening.
create function pg_temp.erin_week(p_back int) returns date
language sql security definer as $$
  select internal.week_start('00000000-0000-4000-8000-000000000001',
    (now() at time zone 'America/Los_Angeles')::date - 7 * p_back)
$$;
create function pg_temp.erin_at(p_day date, p_time text) returns timestamptz
language sql as $$ select (p_day::text || ' ' || p_time)::timestamp at time zone 'America/Los_Angeles' $$;

select has_table('public', 'timesheet_comments', 'timesheet_comments exists');

-- Two weeks back: a week that is over. Erin asks for an hour on its first day and another
-- on its second; Max adds a task to Website revamp.
select pg_temp.act_as(:erin);
insert into pg_temp.ids values
  ('sheet', public.ensure_timesheet(:erin, pg_temp.erin_week(2))),
  ('this_week', public.ensure_timesheet(:erin, pg_temp.erin_week(0))),
  ('entry', public.request_manual_entry(pg_temp.erin_at(pg_temp.erin_week(2), '10:00'),
    pg_temp.erin_at(pg_temp.erin_week(2), '11:00'), :revamp, 'Client workshop')),
  ('entry2', public.request_manual_entry(pg_temp.erin_at(pg_temp.erin_week(2) + 1, '10:00'),
    pg_temp.erin_at(pg_temp.erin_week(2) + 1, '11:00'), null, 'Offline'));
select pg_temp.act_as(:max);
insert into pg_temp.ids values ('design', public.save_task(null, :revamp, 'Design'));
select pg_temp.act_as(:ada);
insert into pg_temp.ids values ('hiring', public.save_task(null, :internal, 'Hiring'));

-- Writing: who ----------------------------------------------------------------------------------

select pg_temp.act_as(:erin);
select throws_ok(format($$ insert into public.timesheet_comments (org_id, timesheet_id, user_id, target, body)
    values (%L, %L, %L, 'row', 'Sneaky') $$, :org, pg_temp.id('sheet'), :erin),
  '42501', null, 'timesheet_comments: no direct writes');

insert into pg_temp.ids values ('erin_unassigned',
  public.add_timesheet_comment(pg_temp.id('sheet'), '  Was offline at the client  '));
select is(
  (select c.target || '|' || coalesce(c.project_id::text, '-') || '|' || coalesce(c.task_id::text, '-')
     || '|' || c.author_name || '|' || c.body
   from pg_temp.comment('erin_unassigned') c),
  'row|-|-|Erin Employee|Was offline at the client',
  'the employee comments on the Unassigned row: stored trimmed, with her name');
select is(pg_temp.told(:max), 1, 'her manager is told');
select is(pg_temp.told_of(:max, 'erin_unassigned') ->> 'to', 'reviewer', 'as the reviewer');
select is(pg_temp.told(:erin), 0, 'she is not told about her own comment');

select pg_temp.act_as(:max);
insert into pg_temp.ids values ('max_design',
  public.add_timesheet_comment(pg_temp.id('sheet'), 'Was this the checkout work?', :revamp,
    pg_temp.id('design')));
select is(
  (select c.target || '|' || c.project_id::text || '|' || c.task_id::text || '|' || c.author_name
   from pg_temp.comment('max_design') c),
  'row|' || :revamp || '|' || pg_temp.id('design')::text || '|Max Manager',
  'the manager comments on a project and task row');
select is(pg_temp.told(:erin), 1, 'the employee is told');
select is(
  (select p ->> 'to' || '|' || (p ->> 'by_name') || '|' || (p ->> 'employee_id') || '|'
     || (p ->> 'period_start') || '|' || (p ->> 'excerpt')
   from pg_temp.told_of(:erin, 'max_design') p),
  'employee|Max Manager|' || :erin || '|' || pg_temp.erin_week(2)::text || '|Was this the checkout work?',
  'with who wrote, whose week, which week and the start of the comment');
select is(pg_temp.told(:max), 1, 'the manager is not told about his own comment');

select lives_ok(format($$ select public.add_timesheet_comment(%L, 'Revamp time without a task', %L) $$,
    pg_temp.id('sheet'), :revamp),
  'a project row without a task');

select pg_temp.act_as(:ada);
select throws_ok(format($$ select public.add_timesheet_comment(%L, 'Looks fine') $$, pg_temp.id('sheet')),
  '42501', 'not_allowed', 'an owner who is not the manager only reads');
select pg_temp.act_as(:lucas);
select throws_ok(format($$ select public.add_timesheet_comment(%L, 'Hi') $$, pg_temp.id('sheet')),
  '42501', 'timesheet_not_found', 'another employee cannot comment on her week');
select throws_ok(format($$ select public.add_timesheet_comment(null, 'Hi', null, null, %L) $$, pg_temp.id('entry')),
  '42501', 'entry_not_found', 'nor on her entry');

-- Writing: what ---------------------------------------------------------------------------------

select pg_temp.act_as(:max);
select throws_ok(format($$ select public.add_timesheet_comment(%L, '   ') $$, pg_temp.id('sheet')),
  '22023', 'invalid_comment', 'a comment is required');
select throws_ok(format($$ select public.add_timesheet_comment(%L, %L) $$, pg_temp.id('sheet'), repeat('x', 2001)),
  '22023', 'invalid_comment', 'at most 2,000 characters');
select lives_ok(format($$ select public.add_timesheet_comment(%L, %L) $$, pg_temp.id('sheet'),
    ' ' || repeat('x', 2000) || ' '),
  '2,000 characters is fine (spaces around it are trimmed)');
select throws_ok(format($$ select public.add_timesheet_comment(%L, 'Which?', null, %L) $$,
    pg_temp.id('sheet'), pg_temp.id('design')),
  '22023', 'invalid_target', 'no task without a project');
select throws_ok(format($$ select public.add_timesheet_comment(%L, 'Which?', %L, %L) $$,
    pg_temp.id('sheet'), :revamp, pg_temp.id('hiring')),
  '22023', 'invalid_target', 'not another project''s task');
select throws_ok(format($$ select public.add_timesheet_comment(%L, 'Which?', %L) $$,
    pg_temp.id('sheet'), gen_random_uuid()),
  '22023', 'invalid_target', 'not an unknown project');
select throws_ok($$ select public.add_timesheet_comment(null, 'Which week?') $$,
  '22023', 'invalid_target', 'a row comment needs its week');

-- Manual entries ------------------------------------------------------------------------------

insert into pg_temp.ids values ('max_entry',
  public.add_timesheet_comment(null, 'What did the workshop cover?', null, null, pg_temp.id('entry')));
select is(
  (select c.target || '|' || c.timesheet_id::text || '|' || c.manual_entry_id::text || '|'
     || c.project_id::text || '|' || coalesce(c.task_id::text, '-')
   from pg_temp.comment('max_entry') c),
  'entry|' || pg_temp.id('sheet')::text || '|' || pg_temp.id('entry')::text || '|' || :revamp || '|-',
  'an entry comment: on the week the entry starts in, with the entry''s project and task');
select is(pg_temp.told_of(:erin, 'max_entry') ->> 'manual_entry_id', pg_temp.id('entry')::text,
  'the employee is told which entry');
select lives_ok(format($$ select public.add_timesheet_comment(%L, 'Same week given', null, null, %L) $$,
    pg_temp.id('sheet'), pg_temp.id('entry')),
  'the entry''s week may be given');
select throws_ok(format($$ select public.add_timesheet_comment(%L, 'Wrong week', null, null, %L) $$,
    pg_temp.id('this_week'), pg_temp.id('entry')),
  '22023', 'invalid_target', 'but not another week');
select throws_ok(format($$ select public.add_timesheet_comment(null, 'Both', %L, null, %L) $$,
    :revamp, pg_temp.id('entry')),
  '22023', 'invalid_target', 'an entry comment takes its row from the entry');

select pg_temp.act_as(:erin);
insert into pg_temp.ids values ('erin_entry',
  public.add_timesheet_comment(null, 'Wireframes and the checkout', null, null, pg_temp.id('entry')));
select is(pg_temp.told_of(:max, 'erin_entry') ->> 'target', 'entry',
  'the employee replies on the entry and her manager is told');

-- An entry that goes away keeps its comments.
select pg_temp.act_as(:max);
insert into pg_temp.ids values ('max_entry2',
  public.add_timesheet_comment(null, 'Why offline?', null, null, pg_temp.id('entry2')));
select pg_temp.act_as(:erin);
select public.cancel_manual_entry(pg_temp.id('entry2'));
select is(
  (select c.target || '|' || coalesce(c.manual_entry_id::text, 'gone') || '|' || c.body
   from pg_temp.comment('max_entry2') c),
  'entry|gone|Why offline?', 'a cancelled entry''s comment stays, without the entry');

-- Audit (AUD-01) --------------------------------------------------------------------------------

select is(pg_temp.audited('timesheet.commented', :erin),
  (select count(*)::int from public.timesheet_comments where user_id = :erin),
  'every comment is audit-logged');
select is(
  (select m ->> 'comment_id' || '|' || (m ->> 'target') || '|' || (m ->> 'length') || '|'
     || (m ->> 'timesheet_id') || '|' || (m ? 'body')::text
   from pg_temp.audit_meta('timesheet.commented', :erin) m),
  pg_temp.id('max_entry2')::text || '|entry|12|' || pg_temp.id('sheet')::text || '|false',
  'with where it is and its length, not its words');
select is(pg_temp.audit_actor(pg_temp.id('erin_unassigned')), :erin, 'by the author');

-- Reading (RLS) -------------------------------------------------------------------------------

create temp table total as select count(*)::int as n from public.timesheet_comments where user_id = :erin;
grant select on total to authenticated;

select pg_temp.act_as(:erin);
select is((select count(*)::int from public.timesheet_comments), (select n from total),
  'the employee reads every comment on her weeks');
select throws_ok($$ update public.timesheet_comments set body = 'changed' $$,
  '42501', null, 'and cannot change one');
select throws_ok($$ delete from public.timesheet_comments $$,
  '42501', null, 'or delete one');
select pg_temp.act_as(:max);
select is((select count(*)::int from public.timesheet_comments where user_id = :erin),
  (select n from total), 'her manager reads them');
select pg_temp.act_as(:ada);
select is((select count(*)::int from public.timesheet_comments where user_id = :erin),
  (select n from total), 'an owner reads them');
select pg_temp.act_as(:lucas);
select is((select count(*)::int from public.timesheet_comments), 0, 'another employee reads none');

-- A delegate (TS-14) ------------------------------------------------------------------------------

select pg_temp.act_as(:max);
select public.set_delegation(:ada, (now() at time zone 'America/Chicago')::date,
  (now() at time zone 'America/Chicago')::date + 3);
select pg_temp.act_as(:ada);
insert into pg_temp.ids values ('ada_row',
  public.add_timesheet_comment(pg_temp.id('sheet'), 'Covering for Max'));
select is((pg_temp.comment('ada_row')).author_name, 'Ada Admin', 'an active delegate comments');
select is(pg_temp.told_of(:erin, 'ada_row') ->> 'by_name', 'Ada Admin', 'and the employee is told');
select is(pg_temp.told(:ada), 0, 'the delegate is not told about her own comment');

select pg_temp.act_as(:erin);
select lives_ok(format($$ select public.add_timesheet_comment(%L, 'Thanks both', %L) $$,
    pg_temp.id('sheet'), :revamp),
  'the employee replies');
select is(pg_temp.told(:ada), 1, 'her manager''s active delegate is told');
select is(pg_temp.told(:max), 3, 'and her manager');
select is(pg_temp.told(:erin), 7, 'and she is not');

-- Approval: comments stay, and may still be written -------------------------------------------------

select pg_temp.act_as(:erin);
select public.submit_timesheet(pg_temp.id('sheet'));
select pg_temp.act_as(:max);
select public.decide_manual_entry(pg_temp.id('entry'), true);
select public.approve_timesheet(pg_temp.id('sheet'));
select is((select status from public.timesheets where id = pg_temp.id('sheet')), 'approved',
  'the week is approved');
select is((select count(*)::int from public.timesheet_comments where user_id = :erin),
  (select n from total) + 2, 'its comments stay');
select lives_ok(format($$ select public.add_timesheet_comment(%L, 'Approved, thanks') $$, pg_temp.id('sheet')),
  'the manager comments after approval');
select pg_temp.act_as(:erin);
select lives_ok(format($$ select public.add_timesheet_comment(null, 'Noted', null, null, %L) $$,
    pg_temp.id('entry')),
  'and the employee replies on an entry of the approved week');

-- The lock banner's approver -----------------------------------------------------------------

select is(public.timesheet_approver_name(pg_temp.id('sheet')), 'Max Manager',
  'the employee reads who approved her week');
select is(public.timesheet_approver_name(pg_temp.id('this_week')), null,
  'nobody, while a week isn''t approved');
select pg_temp.act_as(:ada);
select is(public.timesheet_approver_name(pg_temp.id('sheet')), 'Max Manager', 'an owner too');
select pg_temp.act_as(:lucas);
select is(public.timesheet_approver_name(pg_temp.id('sheet')), null,
  'not someone who can''t see the week');

-- Retention: comments go with their week ---------------------------------------------------------

select pg_temp.act_as_postgres();
insert into public.timesheets (id, org_id, user_id, period_start, status)
values ('00000000-0000-4000-8000-00000000d265', :org, :lucas,
  internal.week_start(:org, (now() - interval '4 years')::date), 'approved');
insert into public.timesheet_comments (org_id, timesheet_id, user_id, target, author_id, author_name, body)
values (:org, '00000000-0000-4000-8000-00000000d265', :lucas, 'row', :max, 'Max Manager', 'Old');
create temp table purge as select public.retention_purge_rows() as counts;
select is((select counts ->> 'timesheet_comments' from purge), '1',
  'retention removes the comments of a week past the timesheet window, and counts them');
select is((select count(*)::int from public.timesheet_comments where user_id = :lucas), 0,
  'that comment is gone');
select is((select count(*)::int from public.timesheet_comments where user_id = :erin),
  (select n from total) + 4, 'recent weeks keep theirs');

-- A notification kind the web app knows -------------------------------------------------------------

select ok(
  (select bool_and(kind ~ '^[a-z_]+\.[a-z_]+$') from public.notifications where kind = 'timesheet.commented'),
  'the notification kind passes the notifications check');
select is(
  (select count(distinct payload ->> 'timesheet_id')::int from public.notifications
   where kind = 'timesheet.commented'),
  1, 'every notification names the week');
select is(
  (select count(*)::int from public.notifications
   where kind = 'timesheet.commented' and payload ->> 'by' = user_id::text),
  0, 'nobody was ever told about their own comment');

select * from finish();
rollback;
