// export-timesheet (#45, #65; TS-20 CSV and XLSX, TS-19, TS-21..23, AUD-01): a timesheet
// export as a download. Request: { view: "daily" | "project" | "segments", format?: "csv" |
// "xlsx" (default csv), filters: { from, to, user_ids?, manager_id?, team_id?, client_ids?,
// project_ids?, statuses? } } with `from` and `to` the employee-local days to include.
// Reply: text/csv or the XLSX type, with a Content-Disposition filename.
//
// The rows, the access check (can_view_user) and the audit row all come from
// timesheet_export_rows, called with the caller's own token: it logs the export before it
// returns a row, so no path through here skips the log. This function only shapes the rows
// into the view (packages/core exportRows.ts, copied to ../_shared/core by `pnpm core:fn`)
// and writes the file. The XLSX highlights overtime with the org's thresholds, which the
// same call returns (exportXlsx). Errors: 400 invalid_request, 401 not_signed_in,
// 403 forbidden, 413 too_large (more rows than a spreadsheet holds; the CSV has no limit).
//
// The UTF-8 byte order mark at the start of the file is for Excel, which otherwise reads
// names with accents as Windows-1252.
import { createClient } from "npm:@supabase/supabase-js@2.118.0";
import {
  type DbExportRow,
  EXPORT_FORMATS,
  EXPORT_VIEWS,
  type ExportFormat,
  type ExportView,
  exportCsv,
  exportFilename,
  exportXlsx,
  fromDbRow,
} from "../_shared/core/exportRows.ts";
import { overtimeFromPolicy } from "../_shared/core/overtime.ts";
import { XLSX_MAX_ROWS, XLSX_MIME } from "../_shared/core/xlsx.ts";

const MAX_IDS = 500;
const STATUSES = ["draft", "submitted", "approved", "returned"];
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Expose-Headers": "Content-Disposition",
};

function reply(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function isDay(v: unknown): v is string {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(v);
}

const isUuid = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f-]{36}$/i.test(v);

/** An optional list of uuids (absent is none); null when it isn't one. */
function uuids(v: unknown): string[] | null {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > MAX_IDS || !v.every(isUuid)) return null;
  return v;
}

interface Filters {
  from: string;
  to: string;
  user_ids: string[];
  manager_id: string | null;
  team_id: string | null;
  client_ids: string[];
  project_ids: string[];
  statuses: string[];
}

function parseFilters(v: unknown): Filters | null {
  if (typeof v !== "object" || v === null) return null;
  const f = v as Record<string, unknown>;
  const user_ids = uuids(f.user_ids);
  const client_ids = uuids(f.client_ids);
  const project_ids = uuids(f.project_ids);
  const statuses = f.statuses ?? [];
  if (!isDay(f.from) || !isDay(f.to) || f.to < f.from) return null;
  if (!user_ids || !client_ids || !project_ids) return null;
  if (f.manager_id !== undefined && f.manager_id !== null && !isUuid(f.manager_id)) return null;
  if (f.team_id !== undefined && f.team_id !== null && !isUuid(f.team_id)) return null;
  if (!Array.isArray(statuses) || !statuses.every((s) => STATUSES.includes(s))) return null;
  return {
    from: f.from,
    to: f.to,
    user_ids,
    manager_id: (f.manager_id as string | null | undefined) ?? null,
    team_id: (f.team_id as string | null | undefined) ?? null,
    client_ids,
    project_ids,
    statuses,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return reply({ error: "method_not_allowed" }, 405);

  const caller = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_ANON_KEY") ?? "",
    {
      global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
      auth: { persistSession: false },
    },
  );
  const { data: auth } = await caller.auth.getUser();
  if (!auth.user) return reply({ error: "not_signed_in" }, 401);

  const body = await req.json().catch(() => null);
  const view = body?.view as ExportView;
  const format = (body?.format ?? "csv") as ExportFormat;
  const filters = parseFilters(body?.filters);
  if (!EXPORT_VIEWS.includes(view) || !EXPORT_FORMATS.includes(format) || !filters) {
    return reply({ error: "invalid_request" }, 400);
  }

  const { data, error } = await caller.rpc("timesheet_export_rows", {
    p_from: filters.from,
    p_to: filters.to,
    p_view: view,
    p_user_ids: filters.user_ids,
    p_manager_id: filters.manager_id,
    p_team_id: filters.team_id,
    p_client_ids: filters.client_ids,
    p_project_ids: filters.project_ids,
    p_statuses: filters.statuses,
    p_format: format,
  });
  if (error) {
    if (error.code === "42501") return reply({ error: "forbidden" }, 403);
    if (error.code === "22023")
      return reply({ error: "invalid_request", detail: error.message }, 400);
    return reply({ error: "export_failed" }, 500);
  }

  const result = data as {
    rows: DbExportRow[];
    overtime?: { daily_hours: unknown; weekly_hours: unknown };
    week_start?: string | null;
  };
  const rows = result.rows.map(fromDbRow);
  const disposition = `attachment; filename="${exportFilename(view, filters.from, filters.to, format)}"`;
  if (format === "csv") {
    return new Response(`\uFEFF${exportCsv(view, rows)}`, {
      headers: {
        ...cors,
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": disposition,
        "Cache-Control": "no-store",
      },
    });
  }

  let file: Uint8Array;
  try {
    file = exportXlsx(view, rows, {
      overtime: overtimeFromPolicy({
        overtime_daily_hours: result.overtime?.daily_hours,
        overtime_weekly_hours: result.overtime?.weekly_hours,
      }),
      weekStart: result.week_start ?? null,
    });
  } catch (e) {
    // More rows than a spreadsheet holds (XLSX_MAX_ROWS); the CSV has no such limit.
    if (e instanceof Error && /too many rows/.test(e.message)) {
      return reply({ error: "too_large", max_rows: XLSX_MAX_ROWS }, 413);
    }
    throw e;
  }
  return new Response(file, {
    headers: {
      ...cors,
      "Content-Type": XLSX_MIME,
      "Content-Disposition": disposition,
      "Cache-Control": "no-store",
    },
  });
});
