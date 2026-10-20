-- #198: saving a project or a client moves the config version of the people whose agent
-- config changes, so their tray project list (names, archived projects) refreshes. The
-- agent_config 'projects' list is exactly the non-archived projects a person is a member
-- of (PRJ-01, PRJ-02), so the people to bump are the members of the project, or of every
-- project under the client. Nobody else refetches.

create or replace function public.save_client(p_id uuid, p_name text, p_archived boolean default false)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me public.users := internal.require_project_manager();
  v_id uuid;
  v_old_name text;
begin
  if p_id is null then
    insert into public.clients (org_id, name, archived)
    values (v_me.org_id, trim(p_name), coalesce(p_archived, false))
    returning id into v_id;
  else
    select c.name into v_old_name from public.clients c where c.id = p_id and c.org_id = v_me.org_id;
    update public.clients set name = trim(p_name), archived = coalesce(p_archived, false)
    where id = p_id and org_id = v_me.org_id
    returning id into v_id;
    if v_id is null then
      raise exception 'client_not_found' using errcode = '42501';
    end if;
    -- The client's name shows next to its projects in the tray. (Archiving a client
    -- does not change what agent_config returns.)
    if v_old_name is distinct from trim(p_name) then
      update public.users u set config_version = u.config_version + 1
      where u.id in (
        select m.user_id
        from public.project_members m
        join public.projects p on p.id = m.project_id
        where p.client_id = v_id
      );
    end if;
  end if;
  return v_id;
exception
  when unique_violation then raise exception 'name_taken' using errcode = '23505';
  when check_violation then raise exception 'invalid_name' using errcode = '22023';
end;
$$;

create or replace function public.save_project(
  p_id uuid,
  p_name text,
  p_client_id uuid default null,
  p_billable boolean default true,
  p_archived boolean default false
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me public.users := internal.require_project_manager();
  v_id uuid;
  v_old public.projects;
begin
  if p_client_id is not null
    and not exists (select 1 from public.clients where id = p_client_id and org_id = v_me.org_id)
  then
    raise exception 'client_not_found' using errcode = '42501';
  end if;
  if p_id is null then
    -- A new project has no members yet; set_project_members bumps the people it adds.
    insert into public.projects (org_id, client_id, name, billable, archived)
    values (v_me.org_id, p_client_id, trim(p_name), coalesce(p_billable, true), coalesce(p_archived, false))
    returning id into v_id;
  else
    select * into v_old from public.projects p where p.id = p_id and p.org_id = v_me.org_id;
    update public.projects
    set client_id = p_client_id, name = trim(p_name), billable = coalesce(p_billable, true),
        archived = coalesce(p_archived, false)
    where id = p_id and org_id = v_me.org_id
    returning id into v_id;
    if v_id is null then
      raise exception 'project_not_found' using errcode = '42501';
    end if;
    -- Only the project's members see it in their tray; bump them when a field changed.
    if v_old.name is distinct from trim(p_name)
      or v_old.client_id is distinct from p_client_id
      or v_old.billable is distinct from coalesce(p_billable, true)
      or v_old.archived is distinct from coalesce(p_archived, false)
    then
      update public.users u set config_version = u.config_version + 1
      where u.id in (select m.user_id from public.project_members m where m.project_id = v_id);
    end if;
  end if;
  return v_id;
exception
  when unique_violation then raise exception 'name_taken' using errcode = '23505';
  when check_violation then raise exception 'invalid_name' using errcode = '22023';
end;
$$;
