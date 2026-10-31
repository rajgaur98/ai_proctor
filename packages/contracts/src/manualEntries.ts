// A manual time entry request (#42, TS-07), as the dashboard validates it before
// calling request_manual_entry. The database checks the rules again (overlap with
// clocked time, the future, who may use the project).
import { z } from "zod";

export const MANUAL_ENTRY_MAX_REASON = 500;
/** TS-24/25 (#254): a work note on an entry or a day. */
export const WORK_NOTE_MAX = 2000;

/** A "work done" note: trimmed, up to 2,000 characters; empty is no note (null). */
export const WorkNote = z
  .string()
  .trim()
  .max(WORK_NOTE_MAX, "A note can be at most 2,000 characters")
  .transform((s) => (s === "" ? null : s));
export const MANUAL_ENTRY_MAX_SECONDS = 24 * 60 * 60;

export const ManualEntryRequest = z
  .object({
    start_at: z.iso.datetime({ offset: true }),
    end_at: z.iso.datetime({ offset: true }),
    // Null is Unassigned.
    project_id: z.uuid().nullable(),
    // A task of the project (#254, PRJ-05); none without a project.
    task_id: z.uuid().nullable().optional(),
    reason: z.string().trim().min(1, "Give a reason").max(MANUAL_ENTRY_MAX_REASON),
    // What was done (TS-24).
    note: WorkNote.nullable().optional(),
  })
  .superRefine((e, ctx) => {
    if (e.task_id && !e.project_id) {
      ctx.addIssue({ code: "custom", message: "Choose a project for the task", path: ["task_id"] });
    }
    const seconds = (Date.parse(e.end_at) - Date.parse(e.start_at)) / 1000;
    if (seconds <= 0) {
      ctx.addIssue({
        code: "custom",
        message: "The end must be after the start",
        path: ["end_at"],
      });
    } else if (seconds > MANUAL_ENTRY_MAX_SECONDS) {
      ctx.addIssue({
        code: "custom",
        message: "An entry can be at most 24 hours",
        path: ["end_at"],
      });
    }
  });

export type ManualEntryRequest = z.infer<typeof ManualEntryRequest>;
