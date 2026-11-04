-- #322 (DSH-01, DSH-11 at scale): the live team read without per-row access checks.
--
-- team_live was a security_invoker view, so the row-level security on users, presence,
-- checkin_events and shifts ran can_view_user() for every row of every table it touched:
-- two to four calls per person, each a lookup of its own. With 5,000 people that is about
-- 0.6–3.7 s per 1,000-row page, and the dashboard reads a page per thousand people.
--
-- Now the view resolves who the caller may see once, as a set (internal.viewable_user_ids,
-- the same rule as can_view_user, which pgTAP checks person by person), and reads the base
-- tables as its owner, filtered to that set and to the person's own org. The rows and
-- columns are exactly what the caller saw before. security_barrier keeps a caller's own
-- filters from running before the visibility filter.
--
-- The teams read on the same page had the same cost (can_view_user per member of every
-- team); its policy now asks the same set.
--
-- Redefined here: team_live view (latest: 20261022100000_teams), same columns in the same
-- order; only its security options and the WHERE/join conditions change. The teams select
-- policy (20261022100000_teams), same rule. New: internal.viewable_user_ids(),
-- internal.viewable_team_ids(). No existing function is redefined.

-- Who the caller may see, all at once -----------------------------------------------------

-- can_view_user(target) for every target in one query: same org as the JWT, active viewer,
-- then self → owner/admin (with an MFA-verified session when the org requires it) → direct
-- manager → active delegate of the person's manager. Keep it in step with can_view_user;
-- supabase/tests/database/team_live_visible_set.test.sql compares the two for every person.
create function internal.viewable_user_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select employee.id
  from public.users viewer
  join public.orgs o on o.id = viewer.org_id
  join public.users employee on employee.org_id = viewer.org_id
  where viewer.id = auth.uid()
    and viewer.active
    and viewer.org_id = internal.jwt_org_id()
    and (
      employee.id = viewer.id
      or (viewer.role in ('owner', 'admin')
          and (not coalesce((o.policy ->> 'require_admin_mfa')::boolean, false)
               or auth.jwt() ->> 'aal' = 'aal2'))
      or employee.manager_id = viewer.id
      or employee.manager_id in (
        select d.manager_id
        from public.delegations d
        where d.delegate_id = viewer.id
          and internal.is_active_delegate(d.manager_id, viewer.id)
      )
    );
$$;

revoke all on function internal.viewable_user_ids() from public, anon, authenticated;
-- The view calls it on the caller's behalf, so the caller needs to be able to run it. It
-- only ever answers for the caller (auth.uid()), and internal isn't exposed by the API.
grant execute on function internal.viewable_user_ids() to authenticated;

-- Live grid (DSH-01/02): copied from 20261022100000_teams ---------------------------------

create or replace view public.team_live
with (security_invoker = off, security_barrier = true)
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
      and s.org_id = u.org_id
      and extract(isodow from now() at time zone s.timezone)::int = any (s.days)
  ) as scheduled_today,
  p.tamper_reason,
  u.team_id
from public.users u
join public.presence p on p.user_id = u.id and p.org_id = u.org_id
left join lateral (
  select
    count(*) filter (where c.outcome <> 'deferred')::int as shown,
    count(*) filter (where c.outcome = 'pass')::int as passed
  from public.checkin_events c
  where c.user_id = u.id
    and c.org_id = u.org_id
    and c.scheduled_at >= (date_trunc('day', now() at time zone u.timezone) at time zone u.timezone)
) today on true
where u.active
  and u.id in (select internal.viewable_user_ids());

comment on view public.team_live is
  'Live grid rows (DSH-01). Reads as its owner, filtered once to internal.viewable_user_ids() '
  '(the can_view_user rule as a set, #322) and to each person''s own org.';

-- Read-only, and only for signed-in callers (anon resolves to no one anyway).
revoke all on public.team_live from anon, authenticated;
grant select on public.team_live to authenticated;

-- Teams (the Live team page's other big read) ----------------------------------------------

-- The teams of the people the caller may see. The teams policy asked can_view_user for
-- every member of every team, through users' own row-level security as well: about 0.6 s
-- for a manager of 5,000 people, longer than the live rows themselves.
create function internal.viewable_team_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select distinct u.team_id
  from public.users u
  where u.team_id is not null
    and u.id in (select internal.viewable_user_ids());
$$;

revoke all on function internal.viewable_team_ids() from public, anon, authenticated;
grant execute on function internal.viewable_team_ids() to authenticated;

-- Same rule as before (20261022100000_teams): owners and admins read all of the org's
-- teams; anyone else the teams of the people they can see.
drop policy "Teams visible to admins and to who can see a member" on public.teams;
create policy "Teams visible to admins and to who can see a member"
on public.teams for select to authenticated
using (
  org_id = (select internal.jwt_org_id())
  and (
    exists (
      select 1 from public.users me
      where me.id = (select auth.uid()) and me.active and me.role in ('owner', 'admin'))
    or id in (select internal.viewable_team_ids())
  )
);
