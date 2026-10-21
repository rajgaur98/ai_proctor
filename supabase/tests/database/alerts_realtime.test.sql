begin;
create extension if not exists pgtap with schema extensions;

select plan(12);

\set erin '''00000000-0000-4000-8000-0000000000c1'''
\set lucas '''00000000-0000-4000-8000-0000000000c2'''
\set max '''00000000-0000-4000-8000-0000000000b1'''
\set ada '''00000000-0000-4000-8000-0000000000a1'''

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

-- Unread alerts, as the postgres role (RLS aside), optionally of one kind.
create function pg_temp.unread(k public.alert_kind default null) returns int
language sql as $$
  select count(*)::int from public.alerts
  where read_at is null and (k is null or kind = k)
$$;

create function pg_temp.unread_all() returns void
language sql as $$ update public.alerts set read_at = null $$;

-- Max is Erin's and Lucas's manager: three alerts for him, an hour apart, oldest first.
delete from public.alerts;
delete from public.delegations;
select internal.raise_alert(:erin, 'offline', 'e1', '{}', now() - interval '3 hours');
select internal.raise_alert(:erin, 'tamper', 'e2', '{}', now() - interval '2 hours');
select internal.raise_alert(:lucas, 'offline', 'e3', '{}', now() - interval '1 hour');

select ok(
  exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'alerts'
  ),
  'alerts are published over Realtime');
select is(pg_temp.unread(), 3, 'three unread alerts for Max');

select pg_temp.act_as(:ada);
select is(public.mark_alerts_read_matching(), 0, 'an admin who is not the recipient marks nothing');
select pg_temp.act_as(:erin);
select is(public.mark_alerts_read_matching(), 0, 'nor does the employee the alerts are about');
select pg_temp.act_as_postgres();
select is(pg_temp.unread(), 3, 'all three are still unread');

select pg_temp.act_as(:max);
select is(public.mark_alerts_read_matching(p_kind => 'offline'), 2, 'a kind filter marks that kind');
select pg_temp.act_as_postgres();
select is(pg_temp.unread('tamper'), 1, 'and leaves the other kind unread');

select pg_temp.unread_all();
select pg_temp.act_as(:max);
select is(public.mark_alerts_read_matching(p_user_id => :lucas), 1, 'an employee filter marks that person only');

select pg_temp.act_as_postgres();
select pg_temp.unread_all();
select pg_temp.act_as(:max);
select is(
  public.mark_alerts_read_matching(p_from => now() - interval '150 minutes', p_to => now() - interval '90 minutes'),
  1, 'a date range marks the alerts inside it (end exclusive)');

select pg_temp.act_as_postgres();
select pg_temp.unread_all();
select pg_temp.act_as(:max);
select is(
  public.mark_alerts_read_matching(p_kind => 'offline', p_user_id => :erin, p_to => now()),
  1, 'filters combine');
select is(public.mark_alerts_read_matching(), 2, 'no filter marks everything left unread, and a repeat marks nothing');

select ok(
  has_function_privilege('authenticated', 'public.mark_alerts_read_matching(public.alert_kind, uuid, timestamptz, timestamptz)', 'execute')
  and not has_function_privilege('anon', 'public.mark_alerts_read_matching(public.alert_kind, uuid, timestamptz, timestamptz)', 'execute'),
  'mark_alerts_read_matching is for signed-in users');

select * from finish();
rollback;
