-- #319: import holidays (LV-02), the same way as the other data imports (#256, #282).
--
-- The dashboard checks a holidays file row by row (apps/web/src/lib/import/holidays.ts) and
-- sends ImportHoliday items (packages/contracts/src/imports.ts) to import_apply with kind
-- 'holidays'. A holiday is matched on date and place (country, state; no country is
-- everyone) like the unique index on public.holidays: one that isn't there is added, one
-- with another name is renamed. Imports never delete holidays.
--
-- Each item goes through public.save_holiday as the importing admin, so the same checks
-- (invalid_holiday, holiday_exists), holiday.added / holiday.changed audit events and
-- leave_changed for the people it affects (their status, config_version and agent) apply
-- as when the holiday is entered by hand. A failing item re-raises with the file's row
-- numbers as DETAIL, like every other kind.
--
-- Redefined here, copied from its latest definition:
--   import_apply (20261101020000_import_time_entries): + kind 'holidays'.

-- One imported holiday (see the header): changes the holiday already on that date for
-- that place, or adds it.
create function internal.import_holiday(p_me public.users, p_item jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_day date := (p_item ->> 'day')::date;
  v_country text := nullif(upper(btrim(coalesce(p_item ->> 'country', ''))), '');
  v_state text := nullif(upper(btrim(coalesce(p_item ->> 'state', ''))), '');
  v_id uuid;
begin
  select h.id into v_id from public.holidays h
  where h.org_id = p_me.org_id and h.day = v_day
    and coalesce(h.country, '') = coalesce(v_country, '')
    and coalesce(h.state, '') = coalesce(v_state, '');
  perform public.save_holiday(v_id, v_day, p_item ->> 'name', v_country, v_state);
end;
$$;

revoke all on function internal.import_holiday(public.users, jsonb) from public, anon, authenticated;

-- import_apply (copy of #282's) with the holidays kind ------------------------------------------

create or replace function public.import_apply(p_payload jsonb, p_new_users jsonb default '{}'::jsonb)
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
  v_unchanged int := 0;
  v_applied boolean;
  v_rowcount int := 0;
  v_late jsonb := '[]'::jsonb;
  v_pass int;
  v_err_message text;
  v_err_state text;
  v_err_detail text;
  v_counts jsonb;
begin
  perform internal.require_org_admin(v_me.org_id);
  if v_kind is null
    or v_kind not in ('people', 'teams', 'clients', 'projects', 'shifts', 'time_entries',
      'holidays')
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
      v_applied := true;
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
          when 'time_entries' then v_applied := internal.import_time_entry(v_me, v_item);
          when 'holidays' then perform internal.import_holiday(v_me, v_item);
        end case;
      exception when others then
        get stacked diagnostics v_err_message = message_text, v_err_state = returned_sqlstate,
          v_err_detail = pg_exception_detail;
        raise exception '%', v_err_message using errcode = v_err_state,
          detail = 'rows: ' || v_rows, hint = coalesce(v_err_detail, '');
      end;
      if not v_applied then v_unchanged := v_unchanged + 1;
      elsif v_item ->> 'action' = 'create' then v_created := v_created + 1;
      else v_updated := v_updated + 1;
      end if;
    end loop;
  end loop;

  v_counts := jsonb_build_object('kind', v_kind, 'created', v_created, 'updated', v_updated)
    || case when v_kind = 'time_entries' then jsonb_build_object('unchanged', v_unchanged)
       else '{}'::jsonb end;
  perform internal.audit(v_me.org_id, v_me.id, 'import.applied', null,
    v_counts || jsonb_build_object('rows', v_rowcount));
  return v_counts;
end;
$$;
