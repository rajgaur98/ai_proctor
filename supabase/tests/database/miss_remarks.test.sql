-- #252: remarks on past misses, the approval lock, "other" needs a remark, the audit row.
begin;
create extension if not exists pgtap with schema extensions;

select plan(15);

\set org '''00000000-0000-4000-8000-000000000001'''
\set erin '''00000000-0000-4000-8000-0000000000c1'''
\set lucas '''00000000-0000-4000-8000-0000000000c2'''

create function pg_temp.act_as(uid uuid) returns void
language sql as $$
  select set_config('role', 'postgres', true);
  select set_config('request.jwt.claims',
    (internal.custom_access_token_hook(jsonb_build_object(
      'user_id', uid, 'claims', jsonb_build_object('sub', uid, 'role', 'authenticated')
    )) -> 'claims')::text, true);
  select set_config('role', 'authenticated', true);
$$;

create function pg_temp.ts(ago interval) returns text
language sql as $$ select to_char((now() - ago) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') $$;

-- The miss-reason audit rows about one check-in (read as the table owner).
create function pg_temp.audits(p_checkin uuid) returns setof public.audit_log
language sql as $$
  select * from public.audit_log
  where action = 'checkin.miss_reason_set' and metadata ->> 'checkin_id' = p_checkin::text
  order by id
$$;

-- Erin missed a check-in three days ago (a past day, in a week nobody has approved).
select pg_temp.act_as(:erin);
create temp table dev as select device_id from public.register_device('macos', '26.0', '0.1.0', 'hash-erin-remarks');
create temp table ids (miss uuid);
insert into ids values (gen_random_uuid());
grant select on dev, ids to authenticated;
select public.agent_events((select device_id from dev), jsonb_build_array(
  jsonb_build_object('id', gen_random_uuid(), 'seq', 1, 'type', 'clock_in', 'at', pg_temp.ts('3 days 1 hour'),
    'mono_ms', 1, 'payload', '{"reason": "manual"}'::jsonb),
  jsonb_build_object('id', (select miss from ids), 'seq', 2, 'type', 'checkin', 'at', pg_temp.ts('3 days'),
    'mono_ms', 2, 'payload', jsonb_build_object('scheduled_at', pg_temp.ts('3 days'), 'shown_at', pg_temp.ts('3 days'),
      'outcome', 'miss', 'wrong_clicks', 0, 'object_keys', '[]'::jsonb, 'flags', '[]'::jsonb)),
  jsonb_build_object('id', gen_random_uuid(), 'seq', 3, 'type', 'clock_out', 'at', pg_temp.ts('2 days 23 hours'),
    'mono_ms', 3, 'payload', '{"reason": "manual"}'::jsonb)
));

select lives_ok($$ select public.set_miss_reason((select miss from ids), 'meeting', ' Standup ran long ') $$,
  'a past miss takes a reason and a remark');
select results_eq($$ select missed_reason_kind, missed_reason from public.checkin_events where id = (select miss from ids) $$,
  $$ values ('meeting', 'Standup ran long') $$, 'stored, remark trimmed');

select throws_ok($$ select public.set_miss_reason((select miss from ids), 'other') $$,
  '22023', 'remark_required', '"other" needs a remark');
select throws_ok($$ select public.set_miss_reason((select miss from ids), 'other', '   ') $$,
  '22023', 'remark_required', 'a blank remark is no remark');
select lives_ok($$ select public.set_miss_reason((select miss from ids), 'other', 'Fire drill') $$,
  '"other" with a remark is fine');
select lives_ok($$ select public.set_miss_reason((select miss from ids), 'other', 'Fire drill') $$,
  'saving the same reason again is harmless');

-- A peer can't touch it.
select pg_temp.act_as(:lucas);
select throws_ok($$ select public.set_miss_reason((select miss from ids), 'away') $$,
  '42501', 'checkin_not_found', 'someone else''s miss is refused');

-- Each change is audit-logged with the quick pick and the remark's length, not its words.
select set_config('role', 'postgres', true);
select is((select count(*)::int from pg_temp.audits((select miss from ids))), 2,
  'two changes, two audit rows (the repeat wrote none)');
select results_eq(
  $$ select actor_id, target_user_id, metadata ->> 'from_kind', metadata ->> 'to_kind',
            (metadata ->> 'from_note_length')::int, (metadata ->> 'to_note_length')::int
     from pg_temp.audits((select miss from ids)) $$,
  $$ values ('00000000-0000-4000-8000-0000000000c1'::uuid, '00000000-0000-4000-8000-0000000000c1'::uuid,
             null::text, 'meeting'::text, 0, 16),
            ('00000000-0000-4000-8000-0000000000c1'::uuid, '00000000-0000-4000-8000-0000000000c1'::uuid,
             'meeting'::text, 'other'::text, 16, 10) $$,
  'who, and from -> to');
select ok(not exists (
  select 1 from pg_temp.audits((select miss from ids))
  where metadata::text ilike '%fire drill%' or metadata::text ilike '%standup%'
), 'the remark text stays out of the audit log');

-- The manager approves the week the miss falls in: the reason is locked.
create temp table wk as
  select internal.week_start(u.org_id, ((now() - interval '3 days') at time zone u.timezone)::date) as period_start
  from public.users u where u.id = :erin;
insert into public.timesheets (org_id, user_id, period_start, status, submitted_at, approved_at)
select :org, :erin, period_start, 'approved', now(), now() from wk
on conflict (user_id, period_start) do update set status = 'approved', approved_at = now();
grant select on wk to authenticated;

select pg_temp.act_as(:erin);
select throws_ok($$ select public.set_miss_reason((select miss from ids), 'break') $$,
  '55000', 'timesheet_locked', 'an approved week refuses changes');
select is((select missed_reason_kind from public.checkin_events where id = (select miss from ids)),
  'other', 'and keeps the reason it had');

-- Reopened (back to submitted, under review): open to changes again.
select set_config('role', 'postgres', true);
update public.timesheets set status = 'submitted', approved_at = null
where user_id = :erin and period_start = (select period_start from wk);
select pg_temp.act_as(:erin);
select lives_ok($$ select public.set_miss_reason((select miss from ids), 'break', 'Fire drill') $$,
  'a submitted week still takes a reason');

-- The manager reads the remark next to the miss.
select pg_temp.act_as('00000000-0000-4000-8000-0000000000b1');
select results_eq($$ select missed_reason_kind, missed_reason from public.checkin_events where id = (select miss from ids) $$,
  $$ values ('break', 'Fire drill') $$, 'her manager sees the quick pick and the remark');

select set_config('role', 'postgres', true);
select is((select count(*)::int from pg_temp.audits((select miss from ids))), 3, 'the refused change wrote no audit row');

select * from finish();
rollback;
