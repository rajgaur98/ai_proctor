// Text a manager gives on a weekly timesheet (#43, TS-11/13/18), as the dashboard
// validates it before calling the RPCs. The database checks it again.
import { z } from "zod";

export const TIMESHEET_MAX_TEXT = 500;

/** Why an edit was made or a week reopened (shown to the employee, audit-logged). */
export const TimesheetReason = z.string().trim().min(1, "Give a reason").max(TIMESHEET_MAX_TEXT);

/** The comment that goes with a returned week. */
export const ReturnComment = z.string().trim().min(1, "Add a comment").max(TIMESHEET_MAX_TEXT);

/** TS-33 (#265): a comment on a row or a manual entry of a week, up to 2,000 characters. */
export const TIMESHEET_COMMENT_MAX = 2000;
export const TimesheetComment = z
  .string()
  .trim()
  .min(1, "Write a comment")
  .max(TIMESHEET_COMMENT_MAX, "A comment can be at most 2,000 characters");
