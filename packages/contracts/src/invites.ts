// Request to the invite-users Edge Function (#28). The function re-checks the
// shape and the database checks the rules (add_invited_member); this is what the
// dashboard validates before sending, including CSV rows.
import { z } from "zod";

export const InviteRole = z.enum(["admin", "manager", "employee"]);

export const Invite = z
  .object({
    email: z.email().max(254),
    full_name: z.string().trim().min(1).max(120),
    role: InviteRole,
    manager_id: z.uuid(),
    work_country: z.string().regex(/^[A-Z]{2}$/, "two-letter country code"),
    work_state: z
      .string()
      .regex(/^[A-Z]{2}$/, "two-letter state code")
      .nullable(),
    timezone: z.string().min(1).max(64),
  })
  .refine((i) => (i.work_country === "US") === (i.work_state !== null), {
    message: "US needs a state; other countries have none",
    path: ["work_state"],
  });

export const InviteRequest = z.object({ invites: z.array(Invite).min(1).max(200) });

export const InviteResult = z.object({
  email: z.string(),
  ok: z.boolean(),
  error: z.string().optional(),
});

export const InviteReply = z.object({ results: z.array(InviteResult) });

export type InviteRole = z.infer<typeof InviteRole>;
export type Invite = z.infer<typeof Invite>;
export type InviteResult = z.infer<typeof InviteResult>;
