// Who has acknowledged the notice (#145, ADM-06): row shape, the filter and the CSV.
import { type CsvCell, toCsv } from "@ai-proctor/core";

export interface AckRow {
  userId: string;
  fullName: string;
  email: string;
  role: string;
  managerName: string | null;
  /** The latest version this person acknowledged; null when they never have. */
  acknowledgedVersion: number | null;
  acknowledgedAt: string | null;
  /** Acknowledged the org's current version. */
  acknowledgedCurrent: boolean;
}

/** All, acknowledged the current version, or not yet. Same names as the database filter. */
export type AckFilter = "all" | "acknowledged_current" | "not_yet";

export const ackFilters: { value: AckFilter; label: string }[] = [
  { value: "all", label: "Everyone" },
  { value: "acknowledged_current", label: "Acknowledged current version" },
  { value: "not_yet", label: "Not yet" },
];

export function filterAcks(rows: AckRow[], filter: AckFilter): AckRow[] {
  if (filter === "all") return rows;
  return rows.filter((r) => r.acknowledgedCurrent === (filter === "acknowledged_current"));
}

/** Never acknowledged any version: the server refuses their clock-in (AGT-04). */
export function isBlocked(row: AckRow): boolean {
  return row.acknowledgedVersion === null;
}

export function ackCounts(rows: AckRow[]) {
  return {
    total: rows.length,
    current: rows.filter((r) => r.acknowledgedCurrent).length,
    blocked: rows.filter(isBlocked).length,
  };
}

const roleNames: Record<string, string> = {
  owner: "Owner",
  admin: "Admin",
  manager: "Manager",
  employee: "Employee",
};

export function roleName(role: string): string {
  return roleNames[role] ?? role;
}

const header = [
  "Name",
  "Email",
  "Role",
  "Manager",
  "Acknowledged version",
  "Acknowledged at (UTC)",
  "Acknowledged current version",
  "Blocked from clocking in",
];

/** Times are ISO 8601 in UTC so the file reads the same wherever it is opened. */
export function ackReportCsv(rows: AckRow[]): string {
  const yesNo = (b: boolean) => (b ? "Yes" : "No");
  const body: CsvCell[][] = rows.map((r) => [
    r.fullName,
    r.email,
    roleName(r.role),
    r.managerName,
    r.acknowledgedVersion,
    r.acknowledgedAt ? new Date(r.acknowledgedAt).toISOString() : null,
    yesNo(r.acknowledgedCurrent),
    yesNo(isBlocked(r)),
  ]);
  return toCsv([header, ...body]);
}
