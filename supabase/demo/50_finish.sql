-- Demo seed (#351), step 5: the jobs that would have run by now (the cron jobs' own
-- functions, at the times they ran): insights' daily cache, the managers' daily digests,
-- this week's insights email, timesheet reminders. Webhook deliveries follow in
-- scripts/demo-seed.sh; 90_finish.sql drops the scratch schema.

do $$
declare
  n int;
  i int := 0;
  v_monday timestamptz;
begin
  -- insights_daily_fill (cron every 5 min) until every day is cached.
  loop
    n := internal.insights_daily_fill();
    i := i + 1;
    exit when n = 0 or i >= 20;
  end loop;
  -- The managers' daily digest (cron digest, at their morning send time) of the last
  -- two days, and the "submit your week" reminders (cron reminders) of the last week:
  -- run at the times those jobs ran, in the morning and evening US time.
  perform internal.digest_eval(t)
  from generate_series(date_trunc('day', now()) - interval '2 days' + interval '15 hours 30 minutes', now(),
    interval '1 day') t;
  perform internal.reminders_eval(t)
  from generate_series(date_trunc('day', now()) - interval '9 days' + interval '11 hours 30 minutes', now(),
    interval '12 hours') t;
  -- This week's insights email went out Monday (cron weekly_insights, at its send time).
  v_monday := ((date_trunc('week', now() at time zone 'America/New_York') + interval '12 hours')
    at time zone 'America/New_York');
  if v_monday > now() then
    v_monday := v_monday - interval '7 days';
  end if;
  perform internal.weekly_insights_eval(v_monday);
end;
$$;
