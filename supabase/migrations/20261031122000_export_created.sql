-- Exports from the dashboard's list pages (#255, TS-20 extended, AUD-01): People, Teams,
-- Projects, Clients, Alerts, Reports, Device enrollment and Delegations each offer a CSV
-- or XLSX of what the page shows. The rows come from the page's own queries, so
-- row-level security and the page's filters already decide what is in the file; this
-- records the export in the audit log (`export.created`, with the page, the format,
-- the filters and the row count). The dashboard records the export before it saves the
-- file, and saves nothing when this refuses.
--
-- The timesheet export (`timesheet.exported`), the audit log export, the notice report
-- export and the data subject exports keep their own server-side functions and rows.

create function public.record_export(
  p_page text,
  p_format text,
  p_filters jsonb default '{}'::jsonb,
  p_row_count int default 0
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  -- Signed in, provisioned and active; anyone else is refused here.
  v_me public.users := internal.current_app_user();
  v_filters jsonb := coalesce(p_filters, '{}'::jsonb);
begin
  -- A member of the org in the token, like every other dashboard call.
  if v_me.org_id is distinct from internal.jwt_org_id() then
    raise exception 'not_a_member' using errcode = '42501';
  end if;
  -- The page is a short name ("people", "alerts"), not free text.
  if p_page is null or p_page !~ '^[a-z][a-z0-9_-]{0,47}$' then
    raise exception 'invalid_page' using errcode = '22023';
  end if;
  if p_format is null or p_format not in ('csv', 'xlsx') then
    raise exception 'invalid_format' using errcode = '22023';
  end if;
  -- The page's filters, as the page names them; kept small.
  if jsonb_typeof(v_filters) <> 'object' or octet_length(v_filters::text) > 4000 then
    raise exception 'invalid_filters' using errcode = '22023';
  end if;
  if p_row_count is null or p_row_count < 0 then
    raise exception 'invalid_row_count' using errcode = '22023';
  end if;

  perform internal.audit(v_me.org_id, v_me.id, 'export.created', null,
    jsonb_build_object(
      'page', p_page,
      'format', p_format,
      'filters', v_filters,
      'row_count', p_row_count));
end;
$$;

revoke all on function public.record_export(text, text, jsonb, int) from public, anon;
grant execute on function public.record_export(text, text, jsonb, int) to authenticated;
