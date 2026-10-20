-- #145: per-person acknowledgement report for admins (AGT-04, ADM-06, AUD-01).
--
-- The notice history shows only how many people acknowledged each version. For
-- compliance an admin needs to see who did, which version and when, and who has not
-- yet (someone who never acknowledged anything cannot clock in). The report is one
-- row per active member of the caller's org. Exporting it is audit-logged in the
-- same call that returns the rows, so there is no export without the log; the
-- dashboard builds the CSV from what the export returns.

-- The rows. `p_status` filters: 'all', 'acknowledged_current' (acknowledged the
-- latest version) or 'not_yet' (has not). `p_version`, when given, adds whether the
-- person acknowledged that version; null otherwise.
create function internal.notice_ack_rows(p_org_id uuid, p_version int, p_status text)
returns table (
  user_id uuid,
  full_name text,
  email text,
  role public.user_role,
  manager_name text,
  acknowledged_version int,
  acknowledged_at timestamptz,
  acknowledged_current boolean,
  acknowledged_selected boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  with current_notice as (
    select max(n.version) as version from public.notices n where n.org_id = p_org_id
  ),
  rows as (
    select u.id as user_id, u.full_name, u.email, u.role, m.full_name as manager_name,
      la.version as acknowledged_version, la.acknowledged_at,
      coalesce(la.version = (select version from current_notice), false) as acknowledged_current,
      case when p_version is null then null else exists (
        select 1 from public.notice_acks a
        join public.notices n on n.id = a.notice_id
        where a.user_id = u.id and n.org_id = p_org_id and n.version = p_version
      ) end as acknowledged_selected
    from public.users u
    left join public.users m on m.id = u.manager_id
    left join lateral (
      select n.version, a.acknowledged_at
      from public.notice_acks a
      join public.notices n on n.id = a.notice_id
      where a.user_id = u.id and n.org_id = p_org_id
      order by n.version desc
      limit 1
    ) la on true
    where u.org_id = p_org_id and u.active
  )
  select r.user_id, r.full_name, r.email, r.role, r.manager_name, r.acknowledged_version,
    r.acknowledged_at, r.acknowledged_current, r.acknowledged_selected
  from rows r
  where case p_status
    when 'acknowledged_current' then r.acknowledged_current
    when 'not_yet' then not r.acknowledged_current
    else true
  end
  order by r.full_name, r.user_id;
$$;

-- Admin or owner of the caller's org, with MFA when the org requires it (as for
-- everything org-wide). Returns the caller; raises otherwise.
create function internal.require_notice_report_admin()
returns public.users
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_me public.users := internal.current_app_user();
  v_mfa boolean;
begin
  if v_me.role not in ('owner', 'admin') then
    raise exception 'admin_only' using errcode = '42501';
  end if;
  select coalesce((o.policy ->> 'require_admin_mfa')::boolean, false) into v_mfa
  from public.orgs o where o.id = v_me.org_id;
  if v_mfa and coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' then
    raise exception 'mfa_required' using errcode = '42501';
  end if;
  return v_me;
end;
$$;

-- Checks shared by the report and the export: the version exists and the filter is known.
create function internal.check_notice_report_args(p_org_id uuid, p_version int, p_status text)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_status not in ('all', 'acknowledged_current', 'not_yet') then
    raise exception 'invalid_filter' using errcode = '22023';
  end if;
  if p_version is not null and not exists (
    select 1 from public.notices n where n.org_id = p_org_id and n.version = p_version
  ) then
    raise exception 'notice_not_found' using errcode = '22023';
  end if;
end;
$$;

-- ADM-06: who has acknowledged. One row per active member, by name.
create function public.notice_ack_report(p_version int default null)
returns table (
  user_id uuid,
  full_name text,
  email text,
  role public.user_role,
  manager_name text,
  acknowledged_version int,
  acknowledged_at timestamptz,
  acknowledged_current boolean,
  acknowledged_selected boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_me public.users := internal.require_notice_report_admin();
begin
  perform internal.check_notice_report_args(v_me.org_id, p_version, 'all');
  return query select r.* from internal.notice_ack_rows(v_me.org_id, p_version, 'all') r;
end;
$$;

-- AUD-01: the same rows for a CSV export (optionally filtered), with the export
-- written to the audit log in the same transaction: filters and row count.
create function public.export_notice_ack_report(
  p_version int default null,
  p_status text default 'all'
)
returns table (
  user_id uuid,
  full_name text,
  email text,
  role public.user_role,
  manager_name text,
  acknowledged_version int,
  acknowledged_at timestamptz,
  acknowledged_current boolean,
  acknowledged_selected boolean
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_me public.users := internal.require_notice_report_admin();
  v_count int;
begin
  perform internal.check_notice_report_args(v_me.org_id, p_version, p_status);
  select count(*)::int into v_count from internal.notice_ack_rows(v_me.org_id, p_version, p_status);
  perform internal.audit(v_me.org_id, v_me.id, 'notice.ack_report_exported', null,
    jsonb_build_object('version', p_version, 'status', p_status, 'row_count', v_count));
  return query select r.* from internal.notice_ack_rows(v_me.org_id, p_version, p_status) r;
end;
$$;

revoke all on function internal.notice_ack_rows(uuid, int, text) from public, anon, authenticated;
revoke all on function internal.require_notice_report_admin() from public, anon, authenticated;
revoke all on function internal.check_notice_report_args(uuid, int, text) from public, anon, authenticated;
revoke all on function public.notice_ack_report(int) from public, anon;
revoke all on function public.export_notice_ack_report(int, text) from public, anon;
grant execute on function public.notice_ack_report(int) to authenticated;
grant execute on function public.export_notice_ack_report(int, text) to authenticated;
