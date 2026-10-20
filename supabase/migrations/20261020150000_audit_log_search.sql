-- #53: audit log search and export (AUD-01, AUD-02).
--
-- The log was already append-only for signed-in users (no write policies, and an
-- UPDATE trigger). This makes it append-only for every API role, the service role
-- included: no write grants at all, and triggers that refuse UPDATE, DELETE and
-- TRUNCATE. Rows are only ever added by the security definer functions that call
-- internal.audit(). Owners and admins search it with search_audit_log and export
-- it with export_audit_log, which logs the export before it returns any rows.
-- (Only a superuser migration can still change the table.)

-- Append-only -----------------------------------------------------------------------------

-- Supabase's default privileges give anon, authenticated and service_role full
-- access to new public tables; the service role also skips RLS, so without this
-- it could edit the log. Owners and admins still read through the select policy.
revoke all on public.audit_log from anon, authenticated, service_role;
revoke all on sequence public.audit_log_id_seq from anon, authenticated, service_role;
grant select on public.audit_log to authenticated;

create trigger audit_log_no_delete
before delete on public.audit_log
for each row execute function internal.audit_log_is_append_only();

create trigger audit_log_no_truncate
before truncate on public.audit_log
for each statement execute function internal.audit_log_is_append_only();

-- Keyset pages over one org, newest first.
create index audit_log_org_at_id_idx on public.audit_log (org_id, at desc, id desc);

-- Access ----------------------------------------------------------------------------------

-- Same rule as the select policy: an active owner or admin of the org in the
-- token, with MFA when the org requires it for admins (NFR-SEC-05).
create function internal.require_audit_reader()
returns public.users
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  me public.users := internal.current_app_user();
begin
  if me.role not in ('owner', 'admin') or me.org_id is distinct from internal.jwt_org_id() then
    raise exception 'admin_only' using errcode = '42501';
  end if;
  if coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' and exists (
    select 1 from public.orgs o
    where o.id = me.org_id and coalesce((o.policy ->> 'require_admin_mfa')::boolean, false)
  ) then
    raise exception 'mfa_required' using errcode = '42501';
  end if;
  return me;
end;
$$;

-- Query ------------------------------------------------------------------------------------

-- One page of an org's log, newest first, for search and export. `p_from` and
-- `p_to` are whole days (both included) in `p_tz`. The cursor is the last row of
-- the previous page.
create function internal.audit_rows(
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
as $$
  select l.id, l.at, l.action, l.actor_id, a.full_name, l.target_user_id, t.full_name, l.metadata
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
$$;

revoke all on function internal.require_audit_reader() from public, anon, authenticated;
revoke all on function internal.audit_rows(uuid, text, uuid, uuid, text[], date, date, timestamptz, bigint, int)
  from public, anon, authenticated;

-- Search (AUD-02) -----------------------------------------------------------------------

-- Filters are all optional and combine with AND. Days are read in the caller's own
-- time zone (the org has none of its own). Page through with the `at` and `id` of
-- the last row returned as p_cursor_at / p_cursor_id; at most 500 rows a page.
create function public.search_audit_log(
  p_actor_id uuid default null,
  p_target_user_id uuid default null,
  p_actions text[] default null,
  p_from date default null,
  p_to date default null,
  p_limit int default 50,
  p_cursor_at timestamptz default null,
  p_cursor_id bigint default null
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
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_me public.users := internal.require_audit_reader();
begin
  if (p_cursor_at is null) <> (p_cursor_id is null) then
    raise exception 'invalid_cursor' using errcode = '22023';
  end if;
  return query
  select r.id, r.at, r.action, r.actor_id, r.actor_name, r.target_user_id, r.target_name, r.metadata
  from internal.audit_rows(v_me.org_id, v_me.timezone, p_actor_id, p_target_user_id, p_actions,
    p_from, p_to, p_cursor_at, p_cursor_id, least(greatest(coalesce(p_limit, 50), 1), 500)) r;
end;
$$;

-- Export (AUD-01, AUD-02) ---------------------------------------------------------------

-- Every row matching the filters (up to 50 000; more is refused so nothing is cut
-- off silently) as {timezone, row_count, rows}. The export is written to the log
-- first, with its filters and row count, in the same transaction that returns the
-- rows: there is no way to get the data without the entry. The rows returned are
-- the ones that existed before the entry, so it isn't part of its own export.
create function public.export_audit_log(
  p_actor_id uuid default null,
  p_target_user_id uuid default null,
  p_actions text[] default null,
  p_from date default null,
  p_to date default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_me public.users := internal.require_audit_reader();
  v_cap constant int := 50000;
  v_rows jsonb;
  v_count int;
begin
  select coalesce(jsonb_agg(to_jsonb(r) order by r.at desc, r.id desc), '[]'::jsonb) into v_rows
  from internal.audit_rows(v_me.org_id, v_me.timezone, p_actor_id, p_target_user_id, p_actions,
    p_from, p_to, null, null, v_cap + 1) r;
  v_count := jsonb_array_length(v_rows);
  if v_count > v_cap then
    raise exception 'too_many_rows' using errcode = '54000';
  end if;

  perform internal.audit(v_me.org_id, v_me.id, 'audit_log.exported', null,
    jsonb_build_object(
      'row_count', v_count,
      'filters', jsonb_strip_nulls(jsonb_build_object(
        'actor_id', p_actor_id,
        'target_user_id', p_target_user_id,
        'actions', case when cardinality(p_actions) > 0 then to_jsonb(p_actions) end,
        'from', p_from,
        'to', p_to,
        'timezone', v_me.timezone))));

  return jsonb_build_object('timezone', v_me.timezone, 'row_count', v_count, 'rows', v_rows);
end;
$$;

revoke all on function public.search_audit_log(uuid, uuid, text[], date, date, int, timestamptz, bigint)
  from public, anon;
grant execute on function public.search_audit_log(uuid, uuid, text[], date, date, int, timestamptz, bigint)
  to authenticated;
revoke all on function public.export_audit_log(uuid, uuid, text[], date, date) from public, anon;
grant execute on function public.export_audit_log(uuid, uuid, text[], date, date) to authenticated;
