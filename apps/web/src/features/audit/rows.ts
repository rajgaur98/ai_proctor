// A row of the audit log as the page shows it, and its CSV form (#53).
import type { Json } from "@ai-proctor/contracts";
import { DateTime } from "luxon";
import { toCsv } from "../../lib/csv";

export interface AuditRow {
  id: number;
  /** Exactly as the database returned it: it is also the paging cursor. */
  at: string;
  action: string;
  actorId: string | null;
  actorName: string | null;
  targetId: string | null;
  targetName: string | null;
  metadata: Json;
}

export const csvHeader = [
  "time",
  "timezone",
  "actor",
  "actor_id",
  "action",
  "target",
  "target_user_id",
  "details",
];

/** Rows as CSV: ISO 8601 times with their offset, in the zone the filters were read in. */
export function auditCsv(rows: AuditRow[], zone: string): string {
  return toCsv([
    csvHeader,
    ...rows.map((r) => [
      DateTime.fromISO(r.at, { zone }).toISO({ suppressMilliseconds: true }) ?? r.at,
      zone,
      r.actorName ?? "",
      r.actorId ?? "",
      r.action,
      r.targetName ?? "",
      r.targetId ?? "",
      JSON.stringify(r.metadata),
    ]),
  ]);
}
