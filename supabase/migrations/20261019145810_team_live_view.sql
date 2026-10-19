-- Live grid read model (#32; DSH-01). One row per employee the viewer may see.
-- security_invoker: the caller's row-level security on users, presence, shifts
-- and checkin_events decides which rows and counts appear.

create view public.team_live
with (security_invoker = on)
as
select
  u.id as user_id,
  u.org_id,
  u.full_name,
  u.role,
  u.manager_id,
  u.timezone,
  p.status,
  p.since,
  p.last_checkin_at,
  p.last_checkin_outcome,
  p.project_id,
  -- Today, in the employee's own time zone.
  coalesce(today.shown, 0) as checkins_shown_today,
  coalesce(today.passed, 0) as checkins_passed_today,
  exists (
    select 1 from public.shifts s
    where s.user_id = u.id
      and extract(isodow from now() at time zone s.timezone)::int = any (s.days)
  ) as scheduled_today
from public.users u
join public.presence p on p.user_id = u.id
left join lateral (
  select
    count(*)::int as shown,
    count(*) filter (where c.outcome = 'pass')::int as passed
  from public.checkin_events c
  where c.user_id = u.id
    and c.scheduled_at >= (date_trunc('day', now() at time zone u.timezone) at time zone u.timezone)
) today on true
where u.active;

comment on view public.team_live is
  'Live grid rows (DSH-01). security_invoker: RLS on the base tables applies to the caller.';
