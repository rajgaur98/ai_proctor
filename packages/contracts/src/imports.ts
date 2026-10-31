// Data imports (#256): what the dashboard sends to apply an import once its preview has
// no errors. Phase B's RPC takes exactly this JSON and applies it all or nothing; it
// resolves every reference again (by email or name, never by id) and checks the same
// rules the one-at-a-time RPCs check, so a stale preview fails instead of writing.
//
// Shape: { kind, items } with at most IMPORT_MAX_ROWS items, in apply order.
//   people   items: ImportPerson, `action` create (invite: the normal invite email goes
//            out) or update (update_member's rules). Managers come before the people
//            who report to them. Values are final, not a diff: empty cells were filled
//            from the person's current values (update) or the import defaults (create).
//   teams    items: ImportTeam. Creates the team when it doesn't exist; `members` are
//            added (moved from any other team), nobody is removed.
//   clients  items: ImportClient, created or updated by name (case-insensitive).
//   projects items: ImportProject, matched by client + name (case-insensitive) like the
//            unique index; `members` are added, nobody is removed.
//   shifts   items: ImportShifts, one per person: their shifts become exactly `shifts`
//            (set_shifts' rules: at most 7).
// Every item carries `rows`, the file's row numbers it came from, so an error the RPC
// raises can point at a row. Rows the preview found unchanged are not sent.
import { z } from "zod";

export const IMPORT_MAX_ROWS = 5_000;

export const ImportKind = z.enum(["people", "teams", "clients", "projects", "shifts"]);
export const ImportAction = z.enum(["create", "update"]);

const Rows = z.array(z.int().min(2)).min(1);
/** An email address as imports store it (lower case). */
export const ImportEmail = z.email("isn't an email address").max(254);
const Email = ImportEmail;
const CountryCode = z.string().regex(/^[A-Z]{2}$/, "must be a two-letter country code");
const HhMm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "must be a time like 09:00");

export const ImportPerson = z
  .object({
    rows: Rows,
    action: ImportAction,
    email: Email,
    full_name: z.string().trim().min(1).max(120),
    // An owner can only be updated (never created or made by import).
    role: z.enum(["owner", "admin", "manager", "employee"]),
    // Null only for the owner.
    manager_email: Email.nullable(),
    // A team that already exists, or null for none.
    team: z.string().trim().min(1).max(80).nullable(),
    work_country: CountryCode,
    work_state: z
      .string()
      .regex(/^[A-Z]{2}$/, "must be a two-letter state code")
      .nullable(),
    timezone: z.string().min(1).max(64),
  })
  .refine((p) => (p.work_country === "US") === (p.work_state !== null), {
    message: "The US needs a state; other countries have none",
    path: ["work_state"],
  })
  .refine((p) => (p.role === "owner") === (p.manager_email === null), {
    message: "Everyone but the owner needs a manager",
    path: ["manager_email"],
  })
  .refine((p) => !(p.action === "create" && p.role === "owner"), {
    message: "An owner can't be invited",
    path: ["role"],
  });

export const ImportTeam = z.object({
  rows: Rows,
  action: ImportAction,
  name: z.string().trim().min(1).max(80),
  members: z.array(Email),
});

export const ImportClient = z.object({
  rows: Rows,
  action: ImportAction,
  name: z.string().trim().min(1).max(120),
  archived: z.boolean(),
});

export const ImportProject = z.object({
  rows: Rows,
  action: ImportAction,
  name: z.string().trim().min(1).max(120),
  // An existing client's name, or null for none.
  client: z.string().trim().min(1).max(120).nullable(),
  billable: z.boolean(),
  archived: z.boolean(),
  members: z.array(Email),
});

export const ImportShift = z.object({
  /** ISO weekdays, 1 = Monday … 7 = Sunday, sorted, no repeats. */
  days: z.array(z.int().min(1).max(7)).min(1).max(7),
  start: HhMm,
  end: HhMm,
  timezone: z.string().min(1).max(64),
});

export const ImportShifts = z.object({
  rows: Rows,
  action: ImportAction,
  email: Email,
  shifts: z.array(ImportShift).min(1).max(7),
});

const items = <T extends z.ZodType>(item: T) => z.array(item).min(1).max(IMPORT_MAX_ROWS);

export const ImportPayload = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("people"), items: items(ImportPerson) }),
  z.object({ kind: z.literal("teams"), items: items(ImportTeam) }),
  z.object({ kind: z.literal("clients"), items: items(ImportClient) }),
  z.object({ kind: z.literal("projects"), items: items(ImportProject) }),
  z.object({ kind: z.literal("shifts"), items: items(ImportShifts) }),
]);

export type ImportKind = z.infer<typeof ImportKind>;
export type ImportAction = z.infer<typeof ImportAction>;
export type ImportPerson = z.infer<typeof ImportPerson>;
export type ImportTeam = z.infer<typeof ImportTeam>;
export type ImportClient = z.infer<typeof ImportClient>;
export type ImportProject = z.infer<typeof ImportProject>;
export type ImportShift = z.infer<typeof ImportShift>;
export type ImportShifts = z.infer<typeof ImportShifts>;
export type ImportPayload = z.infer<typeof ImportPayload>;
