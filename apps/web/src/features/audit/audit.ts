// Audit log search and export (#53, AUD-01/02). Both go through RPCs that only
// owners and admins can call; exporting is logged by the database before it
// returns any rows.
import type { Json } from "@ai-proctor/contracts";
import { infiniteQueryOptions } from "@tanstack/react-query";
import { DateTime } from "luxon";
import { supabase } from "../../lib/supabase";
import { explain } from "../people/members";
import { type AuditRow, auditCsv } from "./rows";

export interface AuditFilters {
  /** Empty string = anyone / any day. */
  actorId: string;
  targetId: string;
  actions: string[];
  /** yyyy-mm-dd, read in the viewer's time zone by the database. */
  from: string;
  to: string;
}

export const noFilters: AuditFilters = { actorId: "", targetId: "", actions: [], from: "", to: "" };

interface RpcRow {
  id: number;
  at: string;
  action: string;
  actor_id: string | null;
  actor_name: string | null;
  target_user_id: string | null;
  target_name: string | null;
  metadata: Json;
}

const toRow = (r: RpcRow): AuditRow => ({
  id: r.id,
  at: r.at,
  action: r.action,
  actorId: r.actor_id,
  actorName: r.actor_name,
  targetId: r.target_user_id,
  targetName: r.target_name,
  metadata: r.metadata,
});

/** Generated argument types can't be null, so unset filters are left out. */
function filterArgs(f: AuditFilters) {
  return {
    ...(f.actorId ? { p_actor_id: f.actorId } : {}),
    ...(f.targetId ? { p_target_user_id: f.targetId } : {}),
    ...(f.actions.length ? { p_actions: f.actions } : {}),
    ...(f.from ? { p_from: f.from } : {}),
    ...(f.to ? { p_to: f.to } : {}),
  };
}

export const pageSize = 50;

interface Cursor {
  at: string;
  id: number;
}

export const auditQuery = (filters: AuditFilters) =>
  infiniteQueryOptions({
    queryKey: ["audit", filters],
    initialPageParam: null as Cursor | null,
    queryFn: async ({ pageParam }) => {
      // One extra row tells us whether there is another page.
      const { data, error } = await supabase.rpc("search_audit_log", {
        ...filterArgs(filters),
        p_limit: pageSize + 1,
        ...(pageParam ? { p_cursor_at: pageParam.at, p_cursor_id: pageParam.id } : {}),
      });
      if (error) throw new Error(auditError(error.message));
      const rows = data.map(toRow);
      return { rows: rows.slice(0, pageSize), more: rows.length > pageSize };
    },
    getNextPageParam: (last): Cursor | undefined => {
      const end = last.rows.at(-1);
      return last.more && end ? { at: end.at, id: end.id } : undefined;
    },
  });

const messages: Record<string, string> = {
  mfa_required: "Verify two-factor authentication to open the audit log.",
  too_many_rows: "More than 50,000 entries match. Narrow the date range or filters and try again.",
};

export function auditError(code: string): string {
  return messages[code] ?? explain(code);
}

/** Logs the export, then returns every matching row as a CSV file's text. */
export async function exportAuditLog(
  filters: AuditFilters,
): Promise<{ csv: string; rowCount: number; filename: string }> {
  const { data, error } = await supabase.rpc("export_audit_log", filterArgs(filters));
  if (error) throw new Error(auditError(error.message));
  const result = data as unknown as { timezone: string; row_count: number; rows: RpcRow[] };
  const stamp = DateTime.now().setZone(result.timezone).toFormat("yyyy-LL-dd-HHmm");
  return {
    csv: auditCsv(result.rows.map(toRow), result.timezone),
    rowCount: result.row_count,
    filename: `audit-log-${stamp}.csv`,
  };
}
