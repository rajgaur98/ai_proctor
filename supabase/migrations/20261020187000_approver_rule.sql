-- Approvals (#148; TS-12, TS-14): one rule for who decides on a person's work. The
-- employee's direct manager, of any role, or that manager's active delegate; never the
-- person themselves. An owner or admin who is neither gets no decide right: they view
-- (can_view_user), they do not approve. can_approve_for used to leave out owners and
-- admins even as direct manager, while internal.is_entry_decider (timesheets, manual
-- entries, can_decide_timesheet) let them in. It now calls is_entry_decider, so there is
-- a single implementation. Callers: set_shifts (admins pass its own role check anyway).

create or replace function public.can_approve_for(target uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.users viewer
    where viewer.id = auth.uid()
      and viewer.org_id = internal.jwt_org_id()
      and internal.is_entry_decider(viewer, target)
  );
$$;
