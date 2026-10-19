-- Org sign-up and admin MFA (#27; ORG-01, ORG-02, NFR-SEC-05).

-- ORG-01/02: a freshly signed-up user (no users row yet) creates their
-- organisation and becomes its owner. During pilots only the US data region exists.
create function public.create_org(
  org_name text,
  region_preset public.region_preset default 'us',
  full_name text default null,
  timezone text default 'UTC'
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_email text;
  v_org uuid;
begin
  if v_uid is null then
    raise exception 'not_signed_in' using errcode = '42501';
  end if;
  if exists (select 1 from public.users where id = v_uid) then
    raise exception 'already_in_an_org' using errcode = '42501';
  end if;
  if length(trim(coalesce(org_name, ''))) not between 1 and 120 then
    raise exception 'invalid_org_name' using errcode = '22023';
  end if;
  if not exists (select 1 from pg_timezone_names where name = create_org.timezone) then
    raise exception 'invalid_timezone' using errcode = '22023';
  end if;

  select u.email into v_email from auth.users u where u.id = v_uid;
  insert into public.orgs (name, data_region, region_preset)
  values (trim(org_name), 'us', create_org.region_preset)
  returning id into v_org;
  insert into public.users (id, org_id, full_name, email, role, timezone)
  values (v_uid, v_org, coalesce(nullif(trim(full_name), ''), split_part(v_email, '@', 1)),
          v_email, 'owner', create_org.timezone);
  insert into public.presence (user_id, org_id) values (v_uid, v_org);
  return v_org;
end;
$$;

revoke all on function public.create_org(text, public.region_preset, text, text) from public, anon;
grant execute on function public.create_org(text, public.region_preset, text, text) to authenticated;

-- NFR-SEC-05: when the org's policy sets require_admin_mfa, owners and admins only
-- get their org-wide view with an MFA-verified session (aal2). Their own data
-- stays visible either way, so they can still reach the MFA screen.
create or replace function public.can_view_user(target uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.users viewer
    join public.users employee on employee.id = target
    join public.orgs o on o.id = viewer.org_id
    where viewer.id = auth.uid()
      and viewer.active
      and viewer.org_id = employee.org_id
      and viewer.org_id = internal.jwt_org_id()
      and (
        viewer.id = employee.id
        or (viewer.role in ('owner', 'admin')
            and (not coalesce((o.policy ->> 'require_admin_mfa')::boolean, false)
                 or auth.jwt() ->> 'aal' = 'aal2'))
        or employee.manager_id = viewer.id
        or exists (
          select 1 from public.delegations d
          where d.manager_id = employee.manager_id
            and d.delegate_id = viewer.id
            and current_date between d.starts_on and d.ends_on
        )
      )
  );
$$;
