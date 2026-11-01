// A manual-time request from a form (#42, TS-07, TS-24): the day and times the employee
// typed, in their zone, checked as far as the browser can before the database checks every
// rule again. Shared by the request dialog and the week grid's quick add (#264), so both
// ask in the same way. Pure, so it's unit-tested.
import { ManualEntryRequest } from "@ai-proctor/contracts";
import { DateTime } from "luxon";

export interface ManualRequestForm {
  /** "YYYY-MM-DD", the employee's local day. */
  day: string;
  /** "HH:mm", local. */
  start: string;
  end: string;
  /** "" is Unassigned. */
  projectId: string;
  /** "" is no task. */
  taskId: string;
  reason: string;
  note: string;
}

/** The request, or the problem to show. Times are read in `zone`. */
export function manualRequest(
  form: ManualRequestForm,
  zone: string,
  now: DateTime,
): { request: ManualEntryRequest } | { problem: string } {
  const at = (time: string) => DateTime.fromISO(`${form.day}T${time}`, { zone });
  const start = at(form.start);
  const end = at(form.end);
  if (!form.start || !form.end || !start.isValid || !end.isValid) {
    return { problem: "Choose a day, a start and an end." };
  }
  if (end > now) return { problem: "The entry can't end in the future." };
  const parsed = ManualEntryRequest.safeParse({
    start_at: start.toISO(),
    end_at: end.toISO(),
    project_id: form.projectId || null,
    task_id: (form.projectId && form.taskId) || null,
    reason: form.reason,
    note: form.note,
  });
  if (!parsed.success) return { problem: parsed.error.issues[0]?.message ?? "Check the fields." };
  return { request: parsed.data };
}
