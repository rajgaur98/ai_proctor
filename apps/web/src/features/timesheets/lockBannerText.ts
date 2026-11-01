// What the lock banner on a week says (#265, TS-18, TS-33): who submitted or approved the
// week and when. Submitted weeks are locked for the employee while they're reviewed; approved
// ones for everyone until reopened.
import { DateTime } from "luxon";
import type { Timesheet } from "./timesheetData";

export interface LockFacts {
  sheet: Pick<Timesheet, "status" | "submittedAt" | "approvedAt">;
  /** The week's employee. */
  employeeId: string;
  employeeName: string;
  viewerId: string;
  /** Who approved: null while not approved and for a week approved on submit (TS-16). */
  approverId: string | null;
  /** Their name, when it can still be read. */
  approverName: string | null;
}

const when = (iso: string | null) =>
  iso ? ` on ${DateTime.fromISO(iso).toFormat("ccc d LLL, HH:mm")}` : "";

/** The banner's line for a submitted or approved week; null for any other. */
export function lockBannerText(f: LockFacts): string | null {
  const self = f.viewerId === f.employeeId;
  const first = f.employeeName.split(" ")[0] ?? f.employeeName;
  if (f.sheet.status === "submitted") {
    return self
      ? `Submitted by you${when(f.sheet.submittedAt)}. Locked while your manager reviews it.`
      : `Submitted by ${f.employeeName}${when(f.sheet.submittedAt)}. Locked for ${first} while it's reviewed.`;
  }
  if (f.sheet.status === "approved") {
    if (f.approverId === null) {
      return `Approved automatically${when(f.sheet.approvedAt)}, as no approval is needed. Locked until it's reopened.`;
    }
    const by =
      f.approverId === f.viewerId ? " by you" : f.approverName ? ` by ${f.approverName}` : "";
    return `Approved${by}${when(f.sheet.approvedAt)}. Locked until it's reopened.`;
  }
  return null;
}
