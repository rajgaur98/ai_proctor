// Types shared by the import kinds (#256). The dashboard loads what already exists (the
// "context") and passes it in; nothing here reads the database.
import type { ImportKind, ImportPayload } from "@ai-proctor/contracts";

export type UserRole = "owner" | "admin" | "manager" | "employee";

/** A person already in the org, as the People page lists them. Emails in lower case. */
export interface ExistingPerson {
  email: string;
  full_name: string;
  role: UserRole;
  manager_email: string | null;
  /** Their team's name, or null. */
  team: string | null;
  work_country: string;
  work_state: string | null;
  timezone: string;
  active: boolean;
}

export interface ExistingTeam {
  name: string;
}

export interface ExistingClient {
  name: string;
  archived: boolean;
}

export interface ExistingProject {
  name: string;
  /** The client's name, or null. */
  client: string | null;
  billable: boolean;
  archived: boolean;
  /** Members' emails, lower case. */
  members: string[];
}

export interface ExistingShift {
  /** The person's email, lower case. */
  email: string;
  days: number[];
  /** "HH:MM". */
  start: string;
  end: string;
  timezone: string;
}

export interface ExistingTask {
  /** Its project's name and client (null: none). */
  project: string;
  client: string | null;
  name: string;
  archived: boolean;
}

/** A manual time entry already there, for a time-entry import (#282). */
export interface ExistingTimeEntry {
  /** The person's email, lower case. */
  email: string;
  /** ISO instants. */
  start_at: string;
  end_at: string;
  status: "pending" | "approved" | "rejected";
  project: string | null;
  client: string | null;
  task: string | null;
  note: string | null;
  reason: string;
}

/**
 * What a time-entry import is checked against, for the people and dates in the file:
 * their manual entries (any status), clocked time and approved (locked) weeks.
 */
export interface TimeContext {
  entries: ExistingTimeEntry[];
  /** Clock sessions; an open one has end_at null and runs to now. */
  clocked: { email: string; start_at: string; end_at: string | null }[];
  /** Approved weeks: the week starting `period_start` ("YYYY-MM-DD") is locked. */
  locked: { email: string; period_start: string }[];
  /** Milliseconds; "now" for the in-the-future check (tests fix it). Default: Date.now(). */
  now?: number;
}

/** What a new person gets when their row leaves a cell empty (the invite dialog's values). */
export interface PeopleDefaults {
  role: "admin" | "manager" | "employee";
  manager_email: string | null;
  work_country: string;
  work_state: string | null;
  timezone: string;
}

export interface ImportContext {
  /** The admin importing (they can't change their own role). */
  me: { email: string };
  people: ExistingPerson[];
  teams: ExistingTeam[];
  clients: ExistingClient[];
  projects: ExistingProject[];
  shifts: ExistingShift[];
  /** Tasks of projects (time-entry imports). */
  tasks?: ExistingTask[];
  /** Time-entry imports: what's already there for the file's people and dates. */
  time?: TimeContext;
  /** People imports only. Without it, new people need every column filled. */
  defaults?: PeopleDefaults;
}

export interface FieldError {
  /** The column (its template name), or null for the whole row. */
  field: string | null;
  message: string;
}

export type RowStatus = "create" | "update" | "unchanged" | "error";

export interface PreviewRow {
  /** The row number a spreadsheet shows (the header is row 1). */
  row: number;
  /** What the row is matched on: an email, a name, client / project, or email and times. */
  key: string;
  status: RowStatus;
  errors: FieldError[];
  /** For an update, what changes, in plain words. */
  changes: string[];
}

export interface ImportPreview {
  kind: ImportKind;
  /** Problems with the file as a whole (nothing else is checked when there are any). */
  fileErrors: string[];
  /** Header cells that matched no column; their values are not read. */
  ignoredColumns: string[];
  rows: PreviewRow[];
  counts: Record<RowStatus, number>;
  /** What to apply: null when any row has an error or nothing would change. */
  payload: ImportPayload | null;
}
