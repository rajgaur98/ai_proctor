// What a notification says in the list and where it leads (TS-13, TS-18). Kinds and
// payloads are the ones the migrations write: timesheet.returned / reopened / edited
// (weekly_timesheets, delegation), timesheet.reassigned, delegation.assigned / ended (also
// when a manager or delegate is deactivated or demoted, #147), the reminders
// (timesheet.submit_reminder / approval_reminder / escalation) and
// timesheet.late_data (late_events), and timesheet.commented (#265, timesheet_comments): to the
// employee when a reviewer comments, to the reviewers when the employee does.
import type { Json } from "@ai-proctor/contracts";
import { DateTime } from "luxon";

function field(payload: Json, key: string): Json | undefined {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return undefined;
  return payload[key];
}

function str(payload: Json, key: string): string | null {
  const v = field(payload, key);
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

function num(payload: Json, key: string): number {
  const v = field(payload, key);
  return typeof v === "number" ? v : 0;
}

/** "19 Oct" from an ISO date, or null when it isn't one. */
function dateLabel(payload: Json, key: string): string | null {
  const v = str(payload, key);
  const d = v === null ? null : DateTime.fromISO(v, { zone: "utc" });
  return d?.isValid ? d.toFormat("d LLL") : null;
}

/** "your week of 19 Oct", or "your week" when the payload has no date. */
function weekOf(payload: Json, who = "your"): string {
  const d = dateLabel(payload, "period_start");
  return d === null ? `${who} week` : `${who} week of ${d}`;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function sentence(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function range(payload: Json): string {
  const from = dateLabel(payload, "starts_on");
  const to = dateLabel(payload, "ends_on");
  return from !== null && to !== null ? `, ${from} to ${to}` : "";
}

/** A delegation that ended because the person was deactivated or made an employee (#147). */
function endedByChange(payload: Json, reason: string): string {
  const name = str(payload, "name") ?? "Someone";
  const why = reason === "demoted" ? `${name} was made an employee` : `${name} was deactivated`;
  return str(payload, "for") === "manager"
    ? `${why}, so your delegation to them ended${range(payload)}`
    : `${why}, so their delegation to you ended${range(payload)}`;
}

const EDITS: Record<string, string> = {
  exclude: "excluded time from",
  include: "put time back into",
  project: "changed the project on time in",
  adjust: "adjusted time in",
  // #254 (TS-24/25): a work note or an entry's task, changed on the employee's behalf.
  note: "changed a work note in",
};

/** One short line for the notification. */
export function notificationText(kind: string, payload: Json): string {
  switch (kind) {
    case "timesheet.returned":
      return sentence(`${weekOf(payload)} was returned to you`);
    case "timesheet.reopened":
      return sentence(`${weekOf(payload)} was reopened`);
    case "timesheet.edited":
      return `Your manager ${EDITS[str(payload, "kind") ?? ""] ?? "edited"} ${weekOf(payload)}`;
    case "timesheet.reassigned": {
      const sheets = num(payload, "timesheets");
      const entries = num(payload, "manual_entries");
      const parts = [
        sheets > 0 ? plural(sheets, "timesheet", "timesheets") : null,
        entries > 0 ? plural(entries, "manual entry", "manual entries") : null,
      ].filter((p) => p !== null);
      return parts.length === 0
        ? "After a reassignment, you have work to decide on"
        : `After a reassignment, you decide on ${parts.join(" and ")}`;
    }
    case "delegation.assigned":
      return `You are a delegate approver${range(payload)}`;
    case "delegation.ended": {
      const reason = str(payload, "reason");
      return reason === "deactivated" || reason === "demoted"
        ? sentence(endedByChange(payload, reason))
        : `Your delegation ended${range(payload)}`;
    }
    case "timesheet.submit_reminder":
      return `Submit ${weekOf(payload)}`;
    case "timesheet.approval_reminder":
      return `${weekOf(payload, `${str(payload, "employee_name") ?? "Someone"}'s`)} has waited 2 days for approval`;
    case "timesheet.escalation":
      return `${weekOf(payload, `${str(payload, "employee_name") ?? "Someone"}'s`)} has waited 5 days for approval`;
    case "timesheet.late_data":
      return `${weekOf(payload, `${str(payload, "employee_name") ?? "Someone"}'s`)} has new data after approval`;
    case "timesheet.commented":
      return str(payload, "to") === "reviewer"
        ? `${str(payload, "by_name") ?? "Someone"} commented on ${weekOf(payload, "their")}`
        : `${str(payload, "by_name") ?? "Your manager"} commented on ${weekOf(payload)}`;
    default:
      return "New notification";
  }
}

/** The comment, reason or context under the line, when there is one. */
export function notificationNote(kind: string, payload: Json): string | null {
  switch (kind) {
    case "timesheet.returned": {
      const comment = str(payload, "comment");
      return comment === null ? null : `Comment: ${comment}`;
    }
    case "timesheet.reopened":
    case "timesheet.edited": {
      const reason = str(payload, "reason");
      return reason === null ? null : `Reason: ${reason}`;
    }
    case "timesheet.escalation": {
      const manager = str(payload, "manager_name");
      return manager === null ? null : `Manager: ${manager}`;
    }
    case "timesheet.commented": {
      const excerpt = str(payload, "excerpt");
      return excerpt === null ? null : `Comment: ${excerpt}`;
    }
    default:
      return null;
  }
}

export type NotificationTarget =
  | { page: "week"; userId: string; week: string }
  | { page: "timesheets" };

/**
 * Where the notification leads: the person's week, or the Timesheets tab. Reminders name the
 * employee; the rest are about the viewer's own week.
 */
export function notificationTarget(
  kind: string,
  payload: Json,
  viewerId: string,
): NotificationTarget | null {
  switch (kind) {
    case "timesheet.returned":
    case "timesheet.reopened":
    case "timesheet.edited":
    case "timesheet.submit_reminder":
    case "timesheet.approval_reminder":
    case "timesheet.escalation":
    case "timesheet.late_data":
    case "timesheet.commented": {
      const week = str(payload, "period_start");
      return week !== null && DateTime.fromISO(week).isValid
        ? { page: "week", userId: str(payload, "employee_id") ?? viewerId, week }
        : { page: "timesheets" };
    }
    case "timesheet.reassigned":
    case "delegation.assigned":
    case "delegation.ended":
      return { page: "timesheets" };
    default:
      return null;
  }
}
