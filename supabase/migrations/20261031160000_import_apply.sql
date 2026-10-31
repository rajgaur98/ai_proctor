-- #256: data imports (ORG-03..06, ORG-08, PRJ-01, SHF-01). The dashboard checks a CSV row
-- by row (apps/web/src/lib/import) and sends the result here as one JSON payload
-- (packages/contracts/src/imports.ts, ImportPayload); import_apply applies all of it or
-- none of it.
--
-- It redefines nothing. Every item goes through the RPC the dashboard uses for that one
-- change, called as the importing admin, so the same rules, per-entity audit events and
-- config_version bumps apply:
--   people   add_invited_member (new people), update_member, and a team move audited like
--            set_team_members (member.team_changed)
--   teams    save_team (new teams), set_team_members (current members + the listed ones)
--   clients  save_client
--   projects save_project, set_project_members (current members + the listed ones)
--   shifts   set_shifts
-- and one import.applied event with the counts.
--
-- References are by email or name (case-insensitive), resolved here again, so a stale
-- preview fails rather than writing. A failing item re-raises its error with the file's
-- row numbers as DETAIL ("rows: 4" or "rows: 4,5"), so the page can point at the row.
--
-- New people need an Auth user before their users row exists. The import-people Edge
-- Function creates them (without an email), passes p_new_users { email: auth user id },
-- and sends the normal invite emails only after this commits. Each id must be an Auth user
-- with that email that has never signed in or confirmed and is in no org, so the map
-- can't attach someone else's account. A new person without one is refused
-- (invite_required).

create function public.import_apply(p_payload jsonb, p_new_users jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me public.users := internal.current_app_user();
  v_kind text := p_payload ->> 'kind';
  v_items jsonb := p_payload -> 'items';
  v_item jsonb;
  v_rows text;
  v_created int := 0;
  v_updated int := 0;
  v_rowcount int := 0;
  v_late jsonb := '[]'::jsonb;
  v_pass int;
  v_err_message text;
  v_err_state text;
  v_err_detail text;
begin
  perform internal.require_org_admin(v_me.org_id);
  if v_kind is null or v_kind not in ('people', 'teams', 'clients', 'projects', 'shifts')
    or jsonb_typeof(v_items) is distinct from 'array'
    or jsonb_array_length(v_items) not between 1 and 5000
    or jsonb_typeof(coalesce(p_new_users, '{}'::jsonb)) <> 'object'
  then
    raise exception 'invalid_import' using errcode = '22023';
  end if;
  -- One import at a time per org, so two admins can't interleave.
  perform pg_advisory_xact_lock(hashtextextended('import_apply:' || v_me.org_id::text, 0));

  -- People made employees go last, after the people who reported to them have moved
  -- (update_member refuses has_reports).
  for v_pass in 1..2 loop
    for v_item in
      select i from jsonb_array_elements(v_items) i
      where v_kind <> 'people'
        or (v_pass = 1) <> (i ->> 'action' = 'update' and i ->> 'role' = 'employee' and exists (
          select 1 from public.users u
          where u.org_id = v_me.org_id and lower(u.email) = lower(btrim(i ->> 'email'))
            and u.role <> 'employee'))
    loop
      continue when v_kind <> 'people' and v_pass = 2;
      v_rows := coalesce((select string_agg(r, ',') from jsonb_array_elements_text(v_item -> 'rows') r), '?');
      v_rowcount := v_rowcount + coalesce(jsonb_array_length(v_item -> 'rows'), 0);
      begin
        if v_item ->> 'action' not in ('create', 'update') then
          raise exception 'invalid_import' using errcode = '22023';
        end if;
        case v_kind
          when 'people' then perform internal.import_person(v_me, v_item, p_new_users);
          when 'teams' then perform internal.import_team(v_me, v_item);
          when 'clients' then perform internal.import_client(v_me, v_item);
          when 'projects' then perform internal.import_project(v_me, v_item);
          when 'shifts' then perform internal.import_shifts(v_me, v_item);
        end case;
      exception when others then
        get stacked diagnostics v_err_message = message_text, v_err_state = returned_sqlstate,
          v_err_detail = pg_exception_detail;
        raise exception '%', v_err_message using errcode = v_err_state,
          detail = 'rows: ' || v_rows, hint = coalesce(v_err_detail, '');
      end;
      if v_item ->> 'action' = 'create' then v_created := v_created + 1;
      else v_updated := v_updated + 1;
      end if;
    end loop;
  end loop;

  perform internal.audit(v_me.org_id, v_me.id, 'import.applied', null,
    jsonb_build_object('kind', v_kind, 'created', v_created, 'updated', v_updated,
      'rows', v_rowcount));
  return jsonb_build_object('kind', v_kind, 'created', v_created, 'updated', v_updated);
end;
$$;

revoke all on function public.import_apply(jsonb, jsonb) from public, anon;
grant execute on function public.import_apply(jsonb, jsonb) to authenticated;

-- A person in the caller's org by email (case-insensitive), or null.
create function internal.import_user(p_org_id uuid, p_email text)
returns public.users
language sql
stable
security definer
set search_path = ''
as $$
  select * from public.users u where u.org_id = p_org_id and lower(u.email) = lower(btrim(p_email));
$$;

-- Puts a person in a team (or none), audited as set_team_members does.
create function internal.import_move_team(p_me public.users, p_user public.users, p_team text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_to public.teams;
  v_from_name text;
begin
  if p_team is not null then
    select * into v_to from public.teams t
    where t.org_id = p_me.org_id and lower(btrim(t.name)) = lower(btrim(p_team));
    if not found then
      raise exception 'team_not_found' using errcode = '22023';
    end if;
  end if;
  if p_user.team_id is not distinct from v_to.id then
    return;
  end if;
  select t.name into v_from_name from public.teams t where t.id = p_user.team_id;
  update public.users set team_id = v_to.id where id = p_user.id;
  perform internal.audit(p_me.org_id, p_me.id, 'member.team_changed', p_user.id,
    jsonb_build_object('from', p_user.team_id, 'from_name', v_from_name,
      'to', v_to.id, 'to_name', v_to.name));
end;
$$;

create function internal.import_person(p_me public.users, p_item jsonb, p_new_users jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text := lower(btrim(p_item ->> 'email'));
  v_user public.users := internal.import_user(p_me.org_id, v_email);
  v_manager public.users;
  v_manager_id uuid;
  v_new_id uuid;
  v_role public.user_role := (p_item ->> 'role')::public.user_role;
begin
  if p_item ->> 'manager_email' is not null then
    v_manager := internal.import_user(p_me.org_id, p_item ->> 'manager_email');
    if v_manager.id is null then
      raise exception 'manager_not_found' using errcode = '22023';
    end if;
    v_manager_id := v_manager.id;
  end if;

  if p_item ->> 'action' = 'create' then
    if v_user.id is not null then
      raise exception 'already_a_member' using errcode = '23505';
    end if;
    v_new_id := nullif(p_new_users ->> v_email, '')::uuid;
    if v_new_id is null then
      raise exception 'invite_required' using errcode = '22023';
    end if;
    if not exists (
      select 1 from auth.users a
      where a.id = v_new_id and lower(a.email) = v_email
        and a.email_confirmed_at is null and a.last_sign_in_at is null
    ) or exists (select 1 from public.users u where u.id = v_new_id) then
      raise exception 'invalid_new_user' using errcode = '42501';
    end if;
    perform public.add_invited_member(p_me.id, v_new_id, v_email, p_item ->> 'full_name', v_role,
      v_manager_id, p_item ->> 'work_country', p_item ->> 'work_state', p_item ->> 'timezone');
  else
    if v_user.id is null then
      raise exception 'user_not_found' using errcode = '22023';
    end if;
    if not v_user.active then
      raise exception 'user_inactive' using errcode = '22023';
    end if;
    perform public.update_member(v_user.id, p_item ->> 'full_name', v_role, v_manager_id,
      p_item ->> 'work_country', p_item ->> 'work_state', p_item ->> 'timezone', null);
  end if;

  v_user := internal.import_user(p_me.org_id, v_email);
  perform internal.import_move_team(p_me, v_user, p_item ->> 'team');
end;
$$;

-- People by email for a membership list: in the org and active.
create function internal.import_member_ids(p_org_id uuid, p_emails jsonb)
returns uuid[]
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_email text;
  v_user public.users;
  v_ids uuid[] := '{}';
begin
  for v_email in select jsonb_array_elements_text(coalesce(p_emails, '[]'::jsonb)) loop
    v_user := internal.import_user(p_org_id, v_email);
    if v_user.id is null then
      raise exception 'user_not_found' using errcode = '22023', detail = v_email;
    end if;
    if not v_user.active then
      raise exception 'user_inactive' using errcode = '22023', detail = v_email;
    end if;
    v_ids := v_ids || v_user.id;
  end loop;
  return v_ids;
end;
$$;

create function internal.import_team(p_me public.users, p_item jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_team_id uuid;
  v_add uuid[] := internal.import_member_ids(p_me.org_id, p_item -> 'members');
begin
  select t.id into v_team_id from public.teams t
  where t.org_id = p_me.org_id and lower(btrim(t.name)) = lower(btrim(p_item ->> 'name'));
  if v_team_id is null then
    v_team_id := public.save_team(null, p_item ->> 'name');
  end if;
  -- Adds only: everyone already in the team stays.
  if cardinality(v_add) > 0 then
    perform public.set_team_members(v_team_id,
      array(select u.id from public.users u where u.team_id = v_team_id) || v_add);
  end if;
end;
$$;

create function internal.import_client(p_me public.users, p_item jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_client public.clients;
begin
  select * into v_client from public.clients c
  where c.org_id = p_me.org_id and lower(c.name) = lower(btrim(p_item ->> 'name'));
  perform public.save_client(v_client.id, coalesce(v_client.name, p_item ->> 'name'),
    (p_item ->> 'archived')::boolean);
end;
$$;

create function internal.import_project(p_me public.users, p_item jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_client_id uuid;
  v_project public.projects;
  v_id uuid;
  v_add uuid[] := internal.import_member_ids(p_me.org_id, p_item -> 'members');
begin
  if p_item ->> 'client' is not null then
    select c.id into v_client_id from public.clients c
    where c.org_id = p_me.org_id and lower(c.name) = lower(btrim(p_item ->> 'client'));
    if v_client_id is null then
      raise exception 'client_not_found' using errcode = '22023';
    end if;
  end if;
  select * into v_project from public.projects p
  where p.org_id = p_me.org_id and p.client_id is not distinct from v_client_id
    and lower(p.name) = lower(btrim(p_item ->> 'name'));
  v_id := public.save_project(v_project.id, coalesce(v_project.name, p_item ->> 'name'),
    v_client_id, (p_item ->> 'billable')::boolean, (p_item ->> 'archived')::boolean);
  -- Adds only: everyone already on the project stays.
  if cardinality(v_add) > 0 then
    perform public.set_project_members(v_id,
      array(select m.user_id from public.project_members m where m.project_id = v_id) || v_add);
  end if;
end;
$$;

create function internal.import_shifts(p_me public.users, p_item jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user public.users := internal.import_user(p_me.org_id, p_item ->> 'email');
begin
  if v_user.id is null then
    raise exception 'user_not_found' using errcode = '22023';
  end if;
  if not v_user.active then
    raise exception 'user_inactive' using errcode = '22023';
  end if;
  perform public.set_shifts(v_user.id, p_item -> 'shifts');
end;
$$;

revoke all on function internal.import_user(uuid, text) from public, anon, authenticated;
revoke all on function internal.import_move_team(public.users, public.users, text) from public, anon, authenticated;
revoke all on function internal.import_person(public.users, jsonb, jsonb) from public, anon, authenticated;
revoke all on function internal.import_member_ids(uuid, jsonb) from public, anon, authenticated;
revoke all on function internal.import_team(public.users, jsonb) from public, anon, authenticated;
revoke all on function internal.import_client(public.users, jsonb) from public, anon, authenticated;
revoke all on function internal.import_project(public.users, jsonb) from public, anon, authenticated;
revoke all on function internal.import_shifts(public.users, jsonb) from public, anon, authenticated;
