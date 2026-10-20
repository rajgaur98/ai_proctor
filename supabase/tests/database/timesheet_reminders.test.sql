begin;
create extension if not exists pgtap with schema extensions;

select plan(106);

\set ada '''00000000-0000-4000-8000-0000000000a1'''
\set max '''00000000-0000-4000-8000-0000000000b1'''
\set erin '''00000000-0000-4000-8000-0000000000c1'''
\set lucas '''00000000-0000-4000-8000-0000000000c2'''
\set priya '''00000000-0000-4000-8000-0000000000e1'''
\set dev '''00000000-0000-4000-8000-0000000000d2'''
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

-- Clean slate between scenarios: no reminders, mail, timesheets or delegations, the
-- default policy, everyone active with approval required. Time data stays.
create function pg_temp.reset() returns void
language sql as $$
  delete from public.reminders_sent;
  delete from public.email_outbox;
  delete from public.notifications;
  delete from public.timesheets;
  delete from public.delegations;
  update public.orgs set policy = '{}' where id = '00000000-0000-4000-8000-000000000001';
  update public.users set active = true, approval_required = true;
$$;

-- Reminders of a kind to one recipient (about one employee when given).
create function pg_temp.sent(k text, who uuid, emp uuid default null) returns int
language sql as $$
  select count(*)::int from public.reminders_sent
  where kind = k and recipient_id = who and (emp is null or user_id = emp)
$$;

create function pg_temp.mails(addr text, tpl text) returns int
language sql as $$
  select count(*)::int from public.email_outbox where to_email = addr and template = tpl
$$;

-- A timesheet for Erin's week of Monday 16 March 2026.
create function pg_temp.sheet(p_status text, p_submitted timestamptz default null) returns uuid
language sql as $$
  insert into public.timesheets (org_id, user_id, period_start, status, submitted_at)
  values ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000c1',
          '2026-03-16', p_status, p_submitted)
  returning id
$$;

-- Time to remind about: Erin and Ada (no manager, the owner) worked on the Tuesday of
-- the week of Monday 16 March 2026. Lucas worked nothing. Zones: Erin Los Angeles
-- (-07 that week), Max and Lucas Chicago (-05), Ada New York (-04).
insert into public.time_segments (org_id, user_id, day, start_at, end_at, type, counted, flagged)
values
  (:org, :erin, '2026-03-17', '2026-03-17 09:00:00-07', '2026-03-17 12:00:00-07', 'verified', true, false),
  (:org, :ada, '2026-03-17', '2026-03-17 09:00:00-04', '2026-03-17 12:00:00-04', 'verified', true, false);

-- The seed gives Erin and Lucas shifts; the scenarios below are for people without them (the
-- fallback: the last day of the week). The shift scenarios have their own section.
delete from public.shifts;

-- Priya is a second admin, in India (+05:30).
insert into auth.users (id, email) values (:priya, 'priya@acme.test');
insert into public.users (id, org_id, full_name, email, role, manager_id, timezone)
values (:priya, :org, 'Priya Admin', 'priya@acme.test', 'admin', :ada, 'Asia/Kolkata');

insert into public.devices (id, org_id, user_id, platform, os_version, agent_version, hardware_hash)
values (:dev, :org, :lucas, 'macos', '26.0', '0.1.0', 'hash-lucas-reminders');

-- Job and send time ------------------------------------------------------------------------

select ok(exists (select 1 from cron.job where jobname = 'reminders' and schedule = '*/15 * * * *'),
  'cron: the reminders job runs every 15 minutes');
select is(internal.reminder_send_at('2026-03-19 14:00:00+00', 'America/Chicago'), '2026-03-19 14:00:00+00'::timestamptz,
  'send time: 09:00 local goes out at once');
select is(internal.reminder_send_at('2026-03-19 22:59:00+00', 'America/Chicago'), '2026-03-19 22:59:00+00'::timestamptz,
  'send time: 17:59 local goes out at once');
select is(internal.reminder_send_at('2026-03-19 23:00:00+00', 'America/Chicago'), '2026-03-20 14:00:00+00'::timestamptz,
  'send time: 18:00 local waits for 09:00 the next morning');
select is(internal.reminder_send_at('2026-03-19 12:00:00+00', 'America/Chicago'), '2026-03-19 14:00:00+00'::timestamptz,
  'send time: 07:00 local waits for 09:00 the same morning');
select is(internal.reminder_send_at('2026-03-22 15:00:00+00', 'Asia/Kolkata'), '2026-03-23 03:30:00+00'::timestamptz,
  'send time: 20:30 in India waits for 09:00 India time');

-- Employee: submit reminder -----------------------------------------------------------------
-- Erin's week ends Sunday 22 March; 16:00 PDT is 23:00 UTC.

select pg_temp.reset();
select internal.reminders_eval('2026-03-22 22:59:00+00');
select is(pg_temp.sent('submit', :erin), 0, 'submit: nothing before 16:00 on the last day, in the employee''s own zone');
select is(pg_temp.sent('submit', :ada), 1, 'submit: New York is already past 16:00 at the same moment (time zone)');

select is(internal.reminders_eval('2026-03-22 23:00:00+00'), 1, 'submit: at 16:00 local one reminder is queued (Erin)');
select is(pg_temp.sent('submit', :erin), 1, 'submit: Erin is reminded');
select is(pg_temp.mails('erin@acme.test', 'reminder_submit'), 1, 'submit: by email');
select is(
  (select payload ->> 'period_start' || '..' || (payload ->> 'period_end') from public.email_outbox where to_email = 'erin@acme.test'),
  '2026-03-16..2026-03-22', 'submit: the mail names the week');
select is(
  (select (send_after = created_at and sent_at is null)::text from public.email_outbox where to_email = 'erin@acme.test'),
  'true', 'submit: it is due at once for the send_emails job');
select is(
  (select count(*)::int from public.notifications where user_id = :erin and kind = 'timesheet.submit_reminder'
     and payload ->> 'period_start' = '2026-03-16'),
  1, 'submit: and in the app');
select is(internal.reminders_eval('2026-03-22 23:15:00+00'), 0, 'submit: the next run queues nothing');
select internal.reminders_eval('2026-03-23 05:00:00+00');
select is(pg_temp.mails('erin@acme.test', 'reminder_submit'), 1, 'submit: once per person per week');
select is(pg_temp.sent('submit', :lucas), 0, 'submit: Lucas had no time that week, no reminder');
select is(pg_temp.sent('submit', :max), 0, 'submit: nor Max, who also had none');

-- The window is 24 hours after 16:00, and a late run finds the week through local Monday.
select pg_temp.reset();
select internal.reminders_eval('2026-03-23 22:59:00+00');
select is(pg_temp.sent('submit', :erin), 1, 'submit: a run up to 24 hours late still sends it (the week before the local date)');
select pg_temp.reset();
select internal.reminders_eval('2026-03-23 23:00:00+00');
select is(pg_temp.sent('submit', :erin), 0, 'submit: after those 24 hours it is not sent');

-- Timesheet states.
select pg_temp.reset();
select pg_temp.sheet('submitted', '2026-03-20 16:00:00+00');
select internal.reminders_eval('2026-03-22 23:00:00+00');
select is(pg_temp.sent('submit', :erin), 0, 'submit: a submitted week needs no reminder');

select pg_temp.reset();
select pg_temp.sheet('approved', '2026-03-20 16:00:00+00');
select internal.reminders_eval('2026-03-22 23:00:00+00');
select is(pg_temp.sent('submit', :erin), 0, 'submit: nor an approved week');

select pg_temp.reset();
select pg_temp.sheet('draft');
select internal.reminders_eval('2026-03-22 23:00:00+00');
select is(pg_temp.sent('submit', :erin), 1, 'submit: a draft is reminded');
select is((select timesheet_id is not null from public.reminders_sent where recipient_id = :erin), true,
  'submit: with the timesheet noted');

select pg_temp.reset();
select pg_temp.sheet('returned', '2026-03-19 16:00:00+00');
select internal.reminders_eval('2026-03-22 23:00:00+00');
select is(pg_temp.sent('submit', :erin), 1, 'submit: a returned week is reminded');

select pg_temp.reset();
select internal.reminders_eval('2026-03-22 23:00:00+00');
select is((select timesheet_id is null from public.reminders_sent where recipient_id = :erin), true,
  'submit: a week without a timesheet row is reminded too');

-- Who is reminded.
select pg_temp.reset();
update public.users set approval_required = false where id = :erin;
select internal.reminders_eval('2026-03-22 23:00:00+00');
select is(pg_temp.sent('submit', :erin), 1, 'submit: a person who does not need approval still submits, so is reminded');

select pg_temp.reset();
update public.users set manager_id = null where id = :erin;
select internal.reminders_eval('2026-03-22 23:00:00+00');
select is(pg_temp.sent('submit', :erin), 0, 'submit: nobody without a manager who needs approval, they cannot submit');
update public.users set manager_id = :max where id = :erin;

select pg_temp.reset();
select internal.reminders_eval('2026-03-22 20:00:00+00');
select is(pg_temp.sent('submit', :ada), 1, 'submit: the owner, with no manager, is reminded (owners submit and are auto-approved)');

select pg_temp.reset();
update public.users set active = false where id = :erin;
select internal.reminders_eval('2026-03-22 23:00:00+00');
select is(pg_temp.sent('submit', :erin), 0, 'submit: a deactivated person is not reminded');

-- Time that counts: clocked time or counted time, not excluded time.
select pg_temp.reset();
insert into public.time_segments (org_id, user_id, day, start_at, end_at, type, counted, flagged, excluded)
values (:org, :lucas, '2026-03-18', '2026-03-18 09:00:00-05', '2026-03-18 10:00:00-05', 'idle', true, true, true);
select internal.reminders_eval('2026-03-22 21:00:00+00');
select is(pg_temp.sent('submit', :lucas), 0, 'submit: excluded time alone is not time worked');
insert into public.clock_sessions (org_id, user_id, device_id, start_at, end_at, start_event_id)
values (:org, :lucas, :dev, '2026-03-18 09:00:00-05', '2026-03-18 10:00:00-05', gen_random_uuid());
select internal.reminders_eval('2026-03-22 21:00:00+00');
select is(pg_temp.sent('submit', :lucas), 1, 'submit: a clock session counts, before its segments are rebuilt');
delete from public.clock_sessions where user_id = :lucas;
delete from public.time_segments where user_id = :lucas;

-- Week start policy: a Sunday week is Sun 15 to Sat 21 March, ending Saturday 16:00 PDT.
select pg_temp.reset();
update public.orgs set policy = '{"week_start": "sunday"}' where id = :org;
select internal.reminders_eval('2026-03-21 22:59:00+00');
select is(pg_temp.sent('submit', :erin), 0, 'week start: Saturday 15:59 is too early for a Sunday week');
select internal.reminders_eval('2026-03-21 23:00:00+00');
select is(
  (select period_start::text from public.reminders_sent where kind = 'submit' and recipient_id = :erin),
  '2026-03-15', 'week start: a Sunday week ends on Saturday, 16:00 local');

-- Manager: 2 days after submission ----------------------------------------------------------
-- Submitted 17 March 15:00 UTC (10:00 in Chicago); due 19 March 15:00 UTC.

select pg_temp.reset();
select pg_temp.sheet('submitted', '2026-03-17 15:00:00+00');
select internal.reminders_eval('2026-03-19 14:59:00+00');
select is(pg_temp.sent('approval', :max), 0, 'approval: not before 2 days');
select is(internal.reminders_eval('2026-03-19 15:00:00+00'), 1, 'approval: 2 days after submission one reminder is queued');
select is(pg_temp.sent('approval', :max, :erin), 1, 'approval: it goes to the direct manager');
select is(pg_temp.mails('manager@acme.test', 'reminder_approval'), 1, 'approval: by email');
select is(
  (select payload ->> 'employee_name' || '|' || (payload ->> 'recipient_timezone') || '|' || (payload ->> 'period_start')
   from public.email_outbox where template = 'reminder_approval'),
  'Erin Employee|America/Chicago|2026-03-16', 'approval: with the employee, the week and the manager''s zone');
select is(
  (select count(*)::int from public.notifications where user_id = :max and kind = 'timesheet.approval_reminder'),
  1, 'approval: and in the app');
select internal.reminders_eval('2026-03-19 15:15:00+00');
select internal.reminders_eval('2026-03-21 15:15:00+00');
select is(pg_temp.sent('approval', :max), 1, 'approval: once per timesheet');
select is(pg_temp.sent('approval', :ada), 0, 'approval: the owner gets no approval reminder, only the manager');
select is(pg_temp.sent('approval', :erin), 0, 'approval: the employee gets none');

-- Not at night: due 22:00 Chicago, goes out at 09:00 next morning.
select pg_temp.reset();
select pg_temp.sheet('submitted', '2026-03-17 03:00:00+00');
select internal.reminders_eval('2026-03-19 13:59:00+00');
select is(pg_temp.sent('approval', :max), 0, 'approval: due in the evening it waits until the next morning');
select internal.reminders_eval('2026-03-19 14:00:00+00');
select is(pg_temp.sent('approval', :max), 1, 'approval: and goes out at 09:00 in the manager''s zone');

-- A delegate gets it as well.
select pg_temp.reset();
select pg_temp.sheet('submitted', '2026-03-17 15:00:00+00');
insert into public.delegations (org_id, manager_id, delegate_id, starts_on, ends_on)
values (:org, :max, :lucas, '2026-03-16', '2026-03-31');
select is(internal.reminders_eval('2026-03-19 15:00:00+00'), 2, 'approval: the manager and the active delegate');
select is(pg_temp.sent('approval', :lucas, :erin), 1, 'approval: the delegate is reminded for Erin');
update public.delegations set starts_on = '2026-04-01', ends_on = '2026-04-10';
delete from public.reminders_sent;
select internal.reminders_eval('2026-03-19 15:15:00+00');
select is(pg_temp.sent('approval', :lucas), 0, 'approval: a delegation that is not active gets none');

-- A deactivated manager is skipped.
select pg_temp.reset();
select pg_temp.sheet('submitted', '2026-03-17 15:00:00+00');
update public.users set active = false where id = :max;
select internal.reminders_eval('2026-03-19 15:00:00+00');
select is(pg_temp.sent('approval', :max), 0, 'approval: a deactivated manager is not reminded');

-- States: only a submitted week is waiting.
select pg_temp.reset();
select pg_temp.sheet('approved', '2026-03-17 15:00:00+00');
select internal.reminders_eval('2026-03-19 15:00:00+00');
select internal.reminders_eval('2026-03-23 15:00:00+00');
select is((select count(*)::int from public.reminders_sent where kind in ('approval', 'escalation')), 0,
  'approval: an approved week gets no approval or escalation reminder');
select pg_temp.reset();
select pg_temp.sheet('returned', '2026-03-17 15:00:00+00');
select internal.reminders_eval('2026-03-23 15:00:00+00');
select is((select count(*)::int from public.reminders_sent where kind in ('approval', 'escalation')), 0,
  'approval: nor a returned week');
select pg_temp.reset();
select pg_temp.sheet('draft');
select internal.reminders_eval('2026-03-23 15:00:00+00');
select is((select count(*)::int from public.reminders_sent where kind in ('approval', 'escalation')), 0,
  'approval: nor a draft');

-- Submitted again after a return: its own reminders.
select pg_temp.reset();
select pg_temp.sheet('submitted', '2026-03-17 15:00:00+00');
select internal.reminders_eval('2026-03-19 15:00:00+00');
update public.timesheets set status = 'returned';
update public.timesheets set status = 'submitted', submitted_at = '2026-03-20 15:00:00+00';
select internal.reminders_eval('2026-03-21 14:59:00+00');
select is(pg_temp.sent('approval', :max), 1, 'resubmit: the new submission is not yet 2 days old');
select internal.reminders_eval('2026-03-22 15:00:00+00');
select is(pg_temp.sent('approval', :max), 2, 'resubmit: it gets its own reminder after 2 days');

-- Reopened: the clock starts at the reopening, not at the old submission.
select pg_temp.reset();
select pg_temp.sheet('submitted', '2026-03-01 15:00:00+00');
insert into public.audit_log (org_id, actor_id, action, target_user_id, metadata, at)
select :org, :max, 'timesheet.reopened', :erin, jsonb_build_object('timesheet_id', t.id), '2026-03-19 15:00:00+00'
from public.timesheets t;
select internal.reminders_eval('2026-03-21 14:59:00+00');
select is((select count(*)::int from public.reminders_sent), 0, 'reopen: a reopened week is not reminded or escalated at once');
select internal.reminders_eval('2026-03-21 15:00:00+00');
select is(pg_temp.sent('approval', :max), 1, 'reopen: the manager is reminded 2 days after the reopening');

-- Admins: 5 days after submission, notify only ------------------------------------------------
-- Due 22 March 15:00 UTC: 11:00 in New York, 20:30 in India (so 03:30 UTC next day).

select pg_temp.reset();
select pg_temp.sheet('submitted', '2026-03-17 15:00:00+00');
select internal.reminders_eval('2026-03-22 14:59:00+00');
select is(pg_temp.sent('escalation', :ada), 0, 'escalation: not before 5 days');
select internal.reminders_eval('2026-03-22 15:00:00+00');
select is(pg_temp.sent('escalation', :ada, :erin), 1, 'escalation: the owner is told after 5 days');
select is(pg_temp.sent('escalation', :priya), 0, 'escalation: an admin in India waits for 09:00 their time');
select internal.reminders_eval('2026-03-23 03:29:00+00');
select is(pg_temp.sent('escalation', :priya), 0, 'escalation: still 03:29 UTC');
select internal.reminders_eval('2026-03-23 03:30:00+00');
select is(pg_temp.sent('escalation', :priya, :erin), 1, 'escalation: every admin is told, each in their own zone');
select is(pg_temp.mails('admin@acme.test', 'reminder_escalation') + pg_temp.mails('priya@acme.test', 'reminder_escalation'),
  2, 'escalation: by email');
select is(
  (select payload ->> 'manager_name' || '|' || (payload ->> 'employee_name') from public.email_outbox
   where template = 'reminder_escalation' and to_email = 'admin@acme.test'),
  'Max Manager|Erin Employee', 'escalation: it names the employee and the manager who has not decided');
select is(
  (select count(*)::int from public.notifications where kind = 'timesheet.escalation' and user_id in (:ada, :priya)),
  2, 'escalation: and in the app');
select internal.reminders_eval('2026-03-30 03:30:00+00');
select is((select count(*)::int from public.reminders_sent where kind = 'escalation'), 2, 'escalation: once per admin per timesheet');
select is(pg_temp.sent('escalation', :max), 0, 'escalation: the manager gets none (it is the approval reminder)');
select is(pg_temp.sent('escalation', :erin), 0, 'escalation: nor the employee');
select is((select status from public.timesheets), 'submitted', 'escalation: notify only, the timesheet is untouched');
select is(pg_temp.sent('approval', :max), 1, 'escalation: the manager reminder went out first, on its own');

-- An admin who is the employee is not told about their own week.
select pg_temp.reset();
insert into public.timesheets (org_id, user_id, period_start, status, submitted_at)
values (:org, :priya, '2026-03-16', 'submitted', '2026-03-17 15:00:00+00');
select internal.reminders_eval('2026-03-23 03:30:00+00');
select is(pg_temp.sent('escalation', :priya), 0, 'escalation: not to the employee themselves');
select is(pg_temp.sent('escalation', :ada, :priya), 1, 'escalation: but the other admins are');
select is(pg_temp.sent('approval', :ada, :priya), 1, 'approval: Priya''s manager is Ada, who is reminded');

-- Shifts: the submit reminder on the last shift day -----------------------------------------------
-- Week of Monday 16 March 2026. Erin: Los Angeles (PDT, -07). Lucas: Chicago (CDT, -05).

-- Weekday 9-to-5: the last shift day is Friday 20th, one hour before the end, 16:00 PDT = 23:00 UTC.
select pg_temp.reset();
insert into public.shifts (org_id, user_id, days, start_time, end_time, timezone)
values (:org, :erin, '{1,2,3,4,5}', '09:00', '17:00', 'America/Los_Angeles');
select is(internal.submit_reminder_due(:erin, '2026-03-16', 'America/Los_Angeles'), '2026-03-20 23:00:00+00'::timestamptz,
  'shifts: due one hour before the end of the last shift, on the last shift day');
select internal.reminders_eval('2026-03-20 22:59:00+00');
select is(pg_temp.sent('submit', :erin), 0, 'shifts: nothing before that on Friday');
select internal.reminders_eval('2026-03-20 23:00:00+00');
select is(pg_temp.sent('submit', :erin), 1, 'shifts: Erin is reminded on Friday, not on Sunday');
select is(pg_temp.mails('erin@acme.test', 'reminder_submit'), 1, 'shifts: by email');
select internal.reminders_eval('2026-03-22 23:00:00+00');
select is(pg_temp.sent('submit', :erin), 1, 'shifts: and not again on the last calendar day');
select pg_temp.reset();
select internal.reminders_eval('2026-03-22 23:00:00+00');
select is(pg_temp.sent('submit', :erin), 0, 'shifts: 24 hours after the due time the Sunday run finds nothing to send');

-- Only the shifts of the person count, and only their days: Monday and Tuesday.
update public.shifts set days = '{1,2}';
select is(internal.submit_reminder_due(:erin, '2026-03-16', 'America/Los_Angeles'), '2026-03-17 23:00:00+00'::timestamptz,
  'shifts: Monday and Tuesday shifts are due on Tuesday');
select pg_temp.reset();
select internal.reminders_eval('2026-03-17 23:00:00+00');
select is(pg_temp.sent('submit', :erin), 1, 'shifts: so the reminder goes out on the Tuesday');
select is(internal.submit_reminder_due(:lucas, '2026-03-16', 'America/Chicago'), '2026-03-22 21:00:00+00'::timestamptz,
  'shifts: a person with no shifts is due on the last day of the week at 16:00 local (Chicago)');

-- A weekend day is the last day when the shift runs on it (Saturday).
update public.shifts set days = '{1,6}';
select is(internal.submit_reminder_due(:erin, '2026-03-16', 'America/Los_Angeles'), '2026-03-21 23:00:00+00'::timestamptz,
  'shifts: a Saturday shift makes Saturday the last shift day');

-- The latest-ending shift of the last day decides.
delete from public.shifts;
insert into public.shifts (org_id, user_id, days, start_time, end_time, timezone)
values (:org, :erin, '{1,2,3,4,5}', '09:00', '13:00', 'America/Los_Angeles'),
       (:org, :erin, '{5}', '14:00', '18:00', 'America/Los_Angeles');
select is(internal.submit_reminder_due(:erin, '2026-03-16', 'America/Los_Angeles'), '2026-03-21 00:00:00+00'::timestamptz,
  'shifts: with two shifts on the last day, one hour before the later one ends (17:00 PDT)');
select pg_temp.reset();
select internal.reminders_eval('2026-03-20 23:59:00+00');
select is(pg_temp.sent('submit', :erin), 0, 'shifts: not at the end of the first shift');
select internal.reminders_eval('2026-03-21 00:00:00+00');
select is(pg_temp.sent('submit', :erin), 1, 'shifts: an hour before the second one ends');

-- An early shift: due 11:00 local, inside the day window.
delete from public.shifts;
insert into public.shifts (org_id, user_id, days, start_time, end_time, timezone)
values (:org, :erin, '{1,2,3,4,5}', '08:00', '12:00', 'America/Los_Angeles');
select is(internal.submit_reminder_due(:erin, '2026-03-16', 'America/Los_Angeles'), '2026-03-20 18:00:00+00'::timestamptz,
  'shifts: a morning shift ending 12:00 is due at 11:00 local');

-- A late shift would be due at night: it waits for 09:00 the next morning, as approval reminders do.
delete from public.shifts;
insert into public.shifts (org_id, user_id, days, start_time, end_time, timezone)
values (:org, :erin, '{1,2,3,4,5}', '12:00', '20:00', 'America/Los_Angeles');
select is(internal.submit_reminder_due(:erin, '2026-03-16', 'America/Los_Angeles'), '2026-03-21 16:00:00+00'::timestamptz,
  'shifts: due 19:00 local, so it waits for 09:00 on Saturday');
select pg_temp.reset();
select internal.reminders_eval('2026-03-21 15:59:00+00');
select is(pg_temp.sent('submit', :erin), 0, 'shifts: nothing in the evening');
select internal.reminders_eval('2026-03-21 16:00:00+00');
select is(pg_temp.sent('submit', :erin), 1, 'shifts: sent at 09:00 the next morning, found through the previous week');

-- A night shift belongs to the day it starts on: Thursday 22:00 to Friday 06:00 Chicago time.
-- Due Friday 05:00 CDT, so it goes out at 09:00 CDT = 14:00 UTC. Lucas needs time that week.
delete from public.shifts;
insert into public.shifts (org_id, user_id, days, start_time, end_time, timezone)
values (:org, :lucas, '{1,2,3,4}', '22:00', '06:00', 'America/Chicago');
select is(internal.submit_reminder_due(:lucas, '2026-03-16', 'America/Chicago'), '2026-03-20 14:00:00+00'::timestamptz,
  'shifts: a night shift ending Friday 06:00 is due on Friday morning');
insert into public.time_segments (org_id, user_id, day, start_at, end_at, type, counted, flagged)
values (:org, :lucas, '2026-03-18', '2026-03-18 09:00:00-05', '2026-03-18 10:00:00-05', 'verified', true, false);
select pg_temp.reset();
select internal.reminders_eval('2026-03-20 13:59:00+00');
select is(pg_temp.sent('submit', :lucas), 0, 'shifts: not before 09:00 on Friday');
select internal.reminders_eval('2026-03-20 14:00:00+00');
select is(pg_temp.sent('submit', :lucas), 1, 'shifts: the night shift worker is reminded on Friday morning');
delete from public.time_segments where user_id = :lucas;

-- The shift's own zone gives the instant: a Friday 09:00-17:00 shift in New York ends 21:00 UTC.
delete from public.shifts;
insert into public.shifts (org_id, user_id, days, start_time, end_time, timezone)
values (:org, :erin, '{5}', '09:00', '17:00', 'America/New_York');
select is(internal.submit_reminder_due(:erin, '2026-03-16', 'America/Los_Angeles'), '2026-03-20 20:00:00+00'::timestamptz,
  'shifts: the shift''s time zone decides when it ends (13:00 PDT for 16:00 New York)');
delete from public.shifts;

-- The reminders switch ------------------------------------------------------------------------------
-- reminders_enabled false: nothing is queued, of any kind. Erin's week is submitted (approval and
-- escalation due) and Ada, with no shifts and time, is due her submit reminder on Sunday.

select pg_temp.reset();
select pg_temp.sheet('submitted', '2026-03-17 15:00:00+00');
update public.orgs set policy = '{"reminders_enabled": false}' where id = :org;
select is(internal.reminders_eval('2026-03-22 20:00:00+00'), 0, 'switch: off, no submit reminder');
select is(internal.reminders_eval('2026-03-19 15:00:00+00'), 0, 'switch: off, no approval reminder');
select is(internal.reminders_eval('2026-03-23 03:30:00+00'), 0, 'switch: off, no escalation');
select is((select count(*)::int from public.reminders_sent) + (select count(*)::int from public.email_outbox)
          + (select count(*)::int from public.notifications), 0, 'switch: off, no reminder row, mail or notification');
select is(internal.reminders_enabled(:org), false, 'switch: reminders_enabled reads the org policy');

update public.orgs set policy = '{"reminders_enabled": true}' where id = :org;
select internal.reminders_eval('2026-03-23 03:30:00+00');
select is(pg_temp.sent('submit', :ada), 1, 'switch: on again, the submit reminder goes out (the window is 24 hours)');
select is(pg_temp.sent('approval', :max), 1, 'switch: on again, so does the approval reminder');
select is(pg_temp.sent('escalation', :ada), 1, 'switch: and the escalation');
update public.orgs set policy = '{}' where id = :org;
select is(internal.reminders_enabled(:org), true, 'switch: an org that has not stored the key sends reminders');

-- Only the org that switched them off is silent.
select pg_temp.reset();
insert into public.orgs (id, name, policy)
values ('00000000-0000-4000-8000-000000000099', 'Other Co', '{"reminders_enabled": false}');
select is(internal.reminders_enabled('00000000-0000-4000-8000-000000000099'), false, 'switch: it is per org');
select is(internal.reminders_enabled(:org), true, 'switch: another org is not affected');

-- Closed to the API roles ------------------------------------------------------------------------

select pg_temp.act_as(:erin);
select throws_ok($$ select * from public.reminders_sent $$, '42501', 'permission denied for table reminders_sent',
  'reminders_sent is not readable through the API');
select throws_ok($$ select internal.reminders_eval() $$, '42501', null,
  'reminders_eval is not callable through the API');
select pg_temp.act_as_postgres();

select * from finish();
rollback;
