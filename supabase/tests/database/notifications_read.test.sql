begin;
create extension if not exists pgtap with schema extensions;

select plan(12);

\set ada '''00000000-0000-4000-8000-0000000000a1'''
\set max '''00000000-0000-4000-8000-0000000000b1'''
\set erin '''00000000-0000-4000-8000-0000000000c1'''
\set lucas '''00000000-0000-4000-8000-0000000000c2'''
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

-- Ids of notifications, kept in a table so the checks can name them.
create temp table ids (name text primary key, id uuid);
grant all on ids to authenticated;

select pg_temp.act_as_postgres();
delete from public.notifications;
select internal.notify(:org, :erin, 'timesheet.returned', '{"comment": "one"}'::jsonb);
select internal.notify(:org, :erin, 'timesheet.reopened', '{"reason": "two"}'::jsonb);
select internal.notify(:org, :erin, 'timesheet.edited', '{"reason": "three"}'::jsonb);
select internal.notify(:org, :lucas, 'timesheet.returned', '{"comment": "lucas"}'::jsonb);
insert into ids (name, id)
select coalesce(p.payload ->> 'comment', p.payload ->> 'reason'), p.id from public.notifications p;

-- Marking some ------------------------------------------------------------------------------------

select pg_temp.act_as(:erin);
select is((select count(*)::int from public.notifications where read_at is null), 3, 'erin has three unread');
select is(public.mark_notifications_read(array[(select id from ids where name = 'one')]), 1,
  'one id: that one is marked read');
select is((select count(*)::int from public.notifications where read_at is null), 2, 'the others stay unread');
select is(public.mark_notifications_read(array[(select id from ids where name = 'one')]), 0,
  'an already read one counts nothing');

-- Someone else's id is ignored ------------------------------------------------------------------------

select is(public.mark_notifications_read(array[(select id from ids where name = 'lucas')]), 0,
  'a peer''s notification id marks nothing');
select pg_temp.act_as(:lucas);
select is((select count(*)::int from public.notifications where read_at is null), 1,
  'and it stays unread for them');

-- No ids marks every unread one -------------------------------------------------------------------------

select pg_temp.act_as(:erin);
select is(public.mark_notifications_read(), 2, 'no ids: all remaining unread are marked');
select is((select count(*)::int from public.notifications where read_at is null), 0, 'nothing left unread');
select is(public.mark_notifications_read(), 0, 'and a repeat counts nothing');
select pg_temp.act_as(:lucas);
select is((select count(*)::int from public.notifications where read_at is null), 1,
  'a peer''s unread are untouched by it');

-- Grants ------------------------------------------------------------------------------------------------

select pg_temp.act_as_postgres();
select ok(has_function_privilege('authenticated', 'public.mark_notifications_read(uuid[])', 'execute'),
  'signed-in users can mark read');
select ok(not has_function_privilege('anon', 'public.mark_notifications_read(uuid[])', 'execute'),
  'anonymous callers cannot');

select * from finish();
rollback;
