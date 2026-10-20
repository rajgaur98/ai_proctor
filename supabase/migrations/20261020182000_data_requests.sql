-- #54: Data subject requests (ADM-05, AUD-01, AUD-03): an admin exports or permanently
-- deletes everything held about one person.
--
-- Two Edge Functions do the work (export-user-data, delete-user-data); the rules are
-- here, in SQL, and run with the admin's own token, so the role, the org and the MFA
-- rule (NFR-SEC-05) are checked by the database and not by the function:
--   begin_user_data_request   checks the request and the typed email; for a deletion
--                             it also stops the person (deactivated, devices revoked,
--                             sessions ended) so no new capture lands mid-deletion
--   record_user_data_export   service role: the export's audit row, with counts
--   delete_user_data          re-checks everything and deletes; the function has
--                             already removed the person's capture files from Storage
--
-- Audit log (AUD-01, AUD-03). The log is append-only and kept for at least 3 years, but
-- its user foreign keys were ON DELETE SET NULL, which is an UPDATE, so a user could
-- not be deleted. The uuids stay (they are the record) and the foreign keys go; a name
-- snapshot is stored in the row when it is written, so a row still reads "Ada did X
-- to Erin" after Erin's user row is gone. The foreign keys that other append-only tables
-- have to a user (timesheet_edits.editor_id, notices.published_by) stay, with their ON
-- DELETE SET NULL; what changes is that their triggers let that one null-out through.
--
-- What a deletion leaves: audit rows that mention the person (with the names they were
-- written with) and one `user_data.deleted` row: who, by whom, when, the role and the
-- number of rows removed per table. No email address, no content.

-- Audit log: no user foreign keys, name snapshots ---------------------------------------

alter table public.audit_log
  drop constraint audit_log_actor_id_fkey,
  drop constraint audit_log_target_user_id_fkey,
  add column actor_name text,
  add column target_name text;

-- Org deletion has no UI, and deleting an org must not take its audit log with it
-- (AUD-03): the foreign key now refuses, instead of cascading. Removing an org for good
-- would need its own, deliberate procedure for the log.
alter table public.audit_log
  drop constraint audit_log_org_id_fkey,
  add constraint audit_log_org_id_fkey
    foreign key (org_id) references public.orgs (id) on delete restrict;

-- Backfill the snapshots of rows that already exist. The append-only trigger refuses
-- every UPDATE, so it is switched off for this one statement pair, inside this
-- migration (it runs as the table owner) and switched straight back on. Nothing else
-- changes: only the two new columns are set, from the names as they are now.
alter table public.audit_log disable trigger audit_log_no_update;
update public.audit_log l set actor_name = u.full_name
from public.users u where u.id = l.actor_id;
update public.audit_log l set target_name = u.full_name
from public.users u where u.id = l.target_user_id;
alter table public.audit_log enable trigger audit_log_no_update;

-- Same signature as before; now it writes the names of the two people as they are at
-- the time of the action.
create or replace function internal.audit(
  p_org_id uuid,
  p_actor_id uuid,
  p_action text,
  p_target_user_id uuid,
  p_metadata jsonb default '{}'::jsonb
)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.audit_log (org_id, actor_id, action, target_user_id, metadata,
                                actor_name, target_name)
  values (
    p_org_id, p_actor_id, p_action, p_target_user_id, coalesce(p_metadata, '{}'::jsonb),
    (select u.full_name from public.users u where u.id = p_actor_id),
    (select u.full_name from public.users u where u.id = p_target_user_id)
  );
$$;

-- Other append-only tables with a user foreign key that nulls on delete ------------------

-- Who made a timesheet edit, and who published a notice, outlive the person: the edit
-- and the notice are other people's record. Their foreign keys null the column when the
-- person is deleted, which is an UPDATE, and the append-only triggers refused every
-- UPDATE. They now let through exactly that change (the column going from a person to
-- null, everything else equal) and still refuse any other.
create function internal.timesheet_edits_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.editor_id is not null and new.editor_id is null
    and to_jsonb(new) - 'editor_id' = to_jsonb(old) - 'editor_id'
  then
    return new;
  end if;
  raise exception 'timesheet_edits_are_append_only' using errcode = '42501';
end;
$$;

create function internal.notices_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.published_by is not null and new.published_by is null
    and to_jsonb(new) - 'published_by' = to_jsonb(old) - 'published_by'
  then
    return new;
  end if;
  raise exception 'notice_history_is_append_only' using errcode = '42501';
end;
$$;

revoke all on function internal.timesheet_edits_guard() from public, anon, authenticated;
revoke all on function internal.notices_guard() from public, anon, authenticated;

drop trigger timesheet_edits_no_update on public.timesheet_edits;
create trigger timesheet_edits_no_update
before update on public.timesheet_edits
for each row execute function internal.timesheet_edits_guard();

drop trigger notices_no_update on public.notices;
create trigger notices_no_update
before update on public.notices
for each row execute function internal.notices_guard();

-- Readers of the log: names from the snapshot when the user row is gone ------------------

-- Who viewed my captures (EMP-03): shared by the employee's own call and the admin
-- export, which is made by the service role for a given person.
create function internal.capture_views_of(p_user_id uuid, p_days int)
returns table (
  viewed_at timestamptz,
  viewer_id uuid,
  viewer_name text,
  viewer_role text,
  checkin_id uuid,
  checkin_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select a.at, a.actor_id, coalesce(u.full_name, a.actor_name), u.role::text,
         c.id, c.scheduled_at
  from public.users me
  join public.audit_log a
    on a.org_id = me.org_id and a.target_user_id = me.id and a.action = 'capture.viewed'
  left join public.users u on u.id = a.actor_id
  left join public.checkin_events c
    on c.id::text = a.metadata ->> 'checkin_id' and c.user_id = me.id
  where me.id = p_user_id
    and a.actor_id is distinct from me.id
    and a.at >= now() - make_interval(days => greatest(1, least(coalesce(p_days, 30), 3650)))
  order by a.at desc, a.id desc
  limit 500;
$$;

create or replace function public.my_capture_views(p_days int default 30)
returns table (
  viewed_at timestamptz,
  viewer_id uuid,
  viewer_name text,
  viewer_role text,
  checkin_id uuid,
  checkin_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_me public.users := internal.current_app_user();
begin
  return query select * from internal.capture_views_of(v_me.id, p_days);
end;
$$;

-- Service role only: the same list for the admin export of one person.
create function public.export_user_capture_views(p_user_id uuid, p_days int default 3650)
returns table (
  viewed_at timestamptz,
  viewer_id uuid,
  viewer_name text,
  viewer_role text,
  checkin_id uuid,
  checkin_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select * from internal.capture_views_of(p_user_id, p_days);
$$;

revoke all on function public.export_user_capture_views(uuid, int) from public, anon, authenticated;
grant execute on function public.export_user_capture_views(uuid, int) to service_role;

-- The audit search and export of #53 (when it is in the schema) join users for the
-- names; they read the snapshot when the user is gone. Done here, and only if the
-- function exists, because this migration has to work on either side of #53.
do $do$
begin
  if to_regprocedure(
    'internal.audit_rows(uuid, text, uuid, uuid, text[], date, date, timestamptz, bigint, int)'
  ) is not null then
    execute $f$
      create or replace function internal.audit_rows(
        p_org_id uuid,
        p_tz text,
        p_actor_id uuid,
        p_target_user_id uuid,
        p_actions text[],
        p_from date,
        p_to date,
        p_cursor_at timestamptz,
        p_cursor_id bigint,
        p_limit int
      )
      returns table (
        id bigint,
        at timestamptz,
        action text,
        actor_id uuid,
        actor_name text,
        target_user_id uuid,
        target_name text,
        metadata jsonb
      )
      language sql
      stable
      security definer
      set search_path = ''
      as $fn$
        select l.id, l.at, l.action, l.actor_id, coalesce(a.full_name, l.actor_name),
               l.target_user_id, coalesce(t.full_name, l.target_name), l.metadata
        from public.audit_log l
        left join public.users a on a.id = l.actor_id
        left join public.users t on t.id = l.target_user_id
        where l.org_id = p_org_id
          and (p_actor_id is null or l.actor_id = p_actor_id)
          and (p_target_user_id is null or l.target_user_id = p_target_user_id)
          and (p_actions is null or cardinality(p_actions) = 0 or l.action = any (p_actions))
          and (p_from is null or l.at >= p_from::timestamp at time zone p_tz)
          and (p_to is null or l.at < (p_to + 1)::timestamp at time zone p_tz)
          and (p_cursor_at is null or (l.at, l.id) < (p_cursor_at, p_cursor_id))
        order by l.at desc, l.id desc
        limit p_limit;
      $fn$
    $f$;
  end if;
end;
$do$;

-- The request rules ------------------------------------------------------------------------

-- An active owner or admin of the org in their token, with MFA when the org requires
-- it for admins (NFR-SEC-05), acting on a member of that org. Returns the target.
-- `p_email` is the address typed to confirm (null: not asked). For a deletion: not
-- yourself, not the last owner, and nobody may still report to the person (ORG-05:
-- everyone has a manager; reassign first).
create function internal.require_data_request(p_user_id uuid, p_email text, p_delete boolean)
returns public.users
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_me public.users := internal.current_app_user();
  v_target public.users;
  v_reports text;
begin
  if v_me.role not in ('owner', 'admin') or v_me.org_id is distinct from internal.jwt_org_id() then
    raise exception 'admin_only' using errcode = '42501';
  end if;
  if coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' and exists (
    select 1 from public.orgs o
    where o.id = v_me.org_id and coalesce((o.policy ->> 'require_admin_mfa')::boolean, false)
  ) then
    raise exception 'mfa_required' using errcode = '42501';
  end if;

  select * into v_target from public.users u where u.id = p_user_id and u.org_id = v_me.org_id;
  if not found then
    raise exception 'user_not_found' using errcode = '42501';
  end if;
  if v_target.role = 'owner' and v_me.role <> 'owner' then
    raise exception 'owner_only' using errcode = '42501';
  end if;
  if p_email is not null and lower(trim(p_email)) <> lower(v_target.email) then
    raise exception 'email_mismatch' using errcode = '22023';
  end if;

  if p_delete then
    if v_target.id = v_me.id then
      raise exception 'cannot_delete_self' using errcode = '22023';
    end if;
    -- Only an owner may act on an owner and not on themselves, so the caller is always
    -- another active owner; this is the rule stated on its own, in case that changes.
    if v_target.role = 'owner' and not exists (
      select 1 from public.users o
      where o.org_id = v_target.org_id and o.role = 'owner' and o.active and o.id <> v_target.id
    ) then
      raise exception 'last_owner' using errcode = '22023';
    end if;
    select string_agg(r.full_name, ', ' order by r.full_name) into v_reports
    from (
      select u.full_name from public.users u
      where u.manager_id = v_target.id and u.active
      order by u.full_name limit 10
    ) r;
    if v_reports is not null then
      raise exception 'has_reports' using errcode = '22023', detail = v_reports;
    end if;
  end if;
  return v_target;
end;
$$;

-- Step one of both requests, from the Edge Function with the admin's token: refuses
-- before anything is read or removed. For a deletion it also stops the person at
-- once: deactivated (the capture upload policy needs an active user), devices revoked,
-- sessions ended. That is audited as a deactivation with the reason, and is why a
-- deletion that fails part way (Storage down) leaves them deactivated, not still
-- collecting; running it again finishes it.
create function public.begin_user_data_request(p_user_id uuid, p_email text, p_action text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me public.users := internal.current_app_user();
  v_target public.users;
begin
  if p_action not in ('export', 'delete') then
    raise exception 'invalid_action' using errcode = '22023';
  end if;
  v_target := internal.require_data_request(p_user_id, coalesce(p_email, ''), p_action = 'delete');

  if p_action = 'delete' then
    update public.users set active = false where id = v_target.id;
    update public.devices set revoked_at = now() where user_id = v_target.id and revoked_at is null;
    perform internal.end_sessions(array(select s.id from auth.sessions s where s.user_id = v_target.id));
    delete from public.device_sessions where user_id = v_target.id;
    if v_target.active then
      perform internal.audit(v_target.org_id, v_me.id, 'member.deactivated', v_target.id,
        jsonb_build_object('reason', 'data_deletion'));
    end if;
  end if;
  return jsonb_build_object(
    'user_id', v_target.id, 'org_id', v_target.org_id, 'full_name', v_target.full_name);
end;
$$;

-- Export (ADM-05, AUD-01) -------------------------------------------------------------------

-- Service role only, called by export-user-data after begin_user_data_request passed
-- with the admin's token. Logged with what the export contained, before it is returned.
-- The admin is checked again: an active owner or admin of the person's org.
create function public.record_user_data_export(p_actor_id uuid, p_user_id uuid, p_counts jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor public.users;
  v_target public.users;
begin
  select * into v_actor from public.users u where u.id = p_actor_id;
  select * into v_target from public.users u where u.id = p_user_id;
  if v_actor.id is null or not v_actor.active or v_actor.role not in ('owner', 'admin')
    or v_target.id is null or v_target.org_id <> v_actor.org_id
  then
    raise exception 'admin_only' using errcode = '42501';
  end if;
  perform internal.audit(v_target.org_id, v_actor.id, 'user_data.exported', v_target.id,
    jsonb_build_object('counts', coalesce(p_counts, '{}'::jsonb)));
end;
$$;

revoke all on function public.record_user_data_export(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.record_user_data_export(uuid, uuid, jsonb) to service_role;

-- Deletion (ADM-05, AUD-01) -----------------------------------------------------------------

-- The capture files under the person's own folder, first `p_limit` by name; the
-- delete-user-data function removes them through the Storage API (which also removes
-- the file behind the row) until none are left.
create function public.list_user_capture_objects(p_user_id uuid, p_limit int default 1000)
returns table (name text)
language sql
stable
security definer
set search_path = ''
as $$
  select o.name
  from storage.objects o
  join public.users u on u.id = p_user_id
  where o.bucket_id = 'captures'
    and starts_with(o.name, u.org_id::text || '/' || u.id::text || '/')
  order by o.name
  limit greatest(1, least(coalesce(p_limit, 1000), 1000));
$$;

revoke all on function public.list_user_capture_objects(uuid, int) from public, anon, authenticated;
grant execute on function public.list_user_capture_objects(uuid, int) to service_role;

-- Removes every row about one person, then the person (the users row and the Auth
-- account, so they cannot sign in), and writes the tombstone. One transaction: it all
-- happens or none of it. Children before parents, partitions through their parent
-- table. The users row is deleted last, so any table added later with an
-- ON DELETE CASCADE foreign key to it is still emptied (the pgTAP test fails if one
-- is missed, so it can be added here and counted). Rows of other people that merely
-- point at this person (the approver of a timesheet, who decided a manual entry, who
-- excluded a segment, someone's manager when they are inactive) are set to null.
-- Refuses while capture files remain in Storage: the images go first, so a failure
-- never leaves files with no row to say whose they are.
-- Returns the number of rows removed per table.
create function internal.delete_user_data(p_actor_id uuid, p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user public.users;
  v_counts jsonb := '{}'::jsonb;
  v_n bigint;
begin
  select * into v_user from public.users u where u.id = p_user_id for update;
  if not found then
    raise exception 'user_not_found' using errcode = '42501';
  end if;
  if exists (
    select 1 from storage.objects o
    where o.bucket_id = 'captures'
      and starts_with(o.name, v_user.org_id::text || '/' || v_user.id::text || '/')
  ) then
    raise exception 'captures_remain' using errcode = '55000';
  end if;

  -- Raw agent data and what was computed from it.
  delete from public.agent_events_raw where user_id = p_user_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('agent_events', v_n);
  delete from public.activity_samples where user_id = p_user_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('activity_samples', v_n);
  delete from public.agent_event_rejections
  where device_id in (select d.id from public.devices d where d.user_id = p_user_id);
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('agent_event_rejections', v_n);
  delete from public.checkin_events where user_id = p_user_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('checkin_events', v_n);
  delete from public.status_periods where user_id = p_user_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('status_periods', v_n);
  delete from public.time_segments where user_id = p_user_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('time_segments', v_n);

  -- Clock sessions and what hangs off them.
  delete from public.pauses where user_id = p_user_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('pauses', v_n);
  delete from public.breaks where user_id = p_user_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('breaks', v_n);
  delete from public.clock_sessions where user_id = p_user_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('clock_sessions', v_n);

  -- Timesheets and the edits and entries on them.
  delete from public.timesheet_edits where user_id = p_user_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('timesheet_edits', v_n);
  delete from public.manual_entries where user_id = p_user_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('manual_entries', v_n);
  delete from public.timesheets where user_id = p_user_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('timesheets', v_n);

  -- Messages: about them or to them, and the emails behind the alerts and reminders.
  delete from public.alerts where user_id = p_user_id or recipient_id = p_user_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('alerts', v_n);
  delete from public.reminders_sent where user_id = p_user_id or recipient_id = p_user_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('reminders_sent', v_n);
  delete from public.notifications where user_id = p_user_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('notifications', v_n);
  delete from public.email_outbox
  where org_id = v_user.org_id
    and (lower(to_email) = lower(v_user.email) or payload ->> 'employee_id' = p_user_id::text);
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('email_outbox', v_n);

  -- Their own settings and acknowledgements, and delegations in either direction (a
  -- delegation to or from them ends with them).
  delete from public.notice_acks where user_id = p_user_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('notice_acks', v_n);
  delete from public.project_members where user_id = p_user_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('project_members', v_n);
  delete from public.shifts where user_id = p_user_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('shifts', v_n);
  delete from public.delegations where manager_id = p_user_id or delegate_id = p_user_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('delegations', v_n);
  delete from public.presence where user_id = p_user_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('presence', v_n);
  delete from public.last_seen where user_id = p_user_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('last_seen', v_n);

  -- Devices and sign-in sessions (ending the sessions revokes the refresh tokens).
  perform internal.end_sessions(array(select s.id from auth.sessions s where s.user_id = p_user_id));
  delete from public.device_sessions where user_id = p_user_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('device_sessions', v_n);
  delete from public.devices where user_id = p_user_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('devices', v_n);

  -- Last of the data: the dirty-day marks the deletes above may have left.
  delete from public.dirty_days where user_id = p_user_id;
  get diagnostics v_n = row_count; v_counts := v_counts || jsonb_build_object('dirty_days', v_n);

  -- The tombstone (AUD-01), written while the names can still be snapshotted. No email.
  perform internal.audit(v_user.org_id, p_actor_id, 'user_data.deleted', v_user.id,
    jsonb_build_object('role', v_user.role, 'counts', v_counts));

  -- The person: the users row (anything with a cascading key to it goes too), then the
  -- Auth account, which frees the email address and ends sign-in for good.
  delete from public.users where id = v_user.id;
  delete from auth.users where id = v_user.id;
  return v_counts;
end;
$$;

-- Step two of a deletion, from the Edge Function with the admin's token, after the
-- capture files are gone. Everything is checked again here, including the typed email.
create function public.delete_user_data(p_user_id uuid, p_email text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me public.users := internal.current_app_user();
  v_target public.users := internal.require_data_request(p_user_id, coalesce(p_email, ''), true);
begin
  return internal.delete_user_data(v_me.id, v_target.id);
end;
$$;

revoke all on function internal.require_data_request(uuid, text, boolean) from public, anon, authenticated;
revoke all on function internal.capture_views_of(uuid, int) from public, anon, authenticated;
revoke all on function internal.delete_user_data(uuid, uuid) from public, anon, authenticated;
revoke all on function public.begin_user_data_request(uuid, text, text) from public, anon;
revoke all on function public.delete_user_data(uuid, text) from public, anon;
grant execute on function public.begin_user_data_request(uuid, text, text) to authenticated;
grant execute on function public.delete_user_data(uuid, text) to authenticated;
