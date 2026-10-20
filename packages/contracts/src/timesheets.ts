// Text a manager gives on a weekly timesheet (#43, TS-11/13/18), as the dashboard
// validates it before calling the RPCs. The database checks it again.
import { z } from "zod";

export const TIMESHEET_MAX_TEXT = 500;

/** Why an edit was made or a week reopened (shown to the employee, audit-logged). */
export const TimesheetReason = z.string().trim().min(1, "Give a reason").max(TIMESHEET_MAX_TEXT);

/** The comment that goes with a returned week. */
export const ReturnComment = z.string().trim().min(1, "Add a comment").max(TIMESHEET_MAX_TEXT);
