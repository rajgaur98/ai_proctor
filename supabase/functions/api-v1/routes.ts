// The public API v1's operations (#306, API-01..05): one table that both the router
// (index.ts) and the OpenAPI document (openapi.ts) are built from, so the two can't drift.
// The database decides what each operation returns and checks every parameter
// (internal.api_dispatch in 20261105200000_public_api.sql); this table only routes and
// documents.

export type ParamType = "string" | "uuid" | "date" | "datetime" | "boolean" | "integer";

export interface Param {
  name: string;
  type: ParamType;
  description: string;
  required?: boolean;
  enum?: string[];
}

export interface Operation {
  /** The database's name for it, e.g. `people.list`. */
  id: string;
  method: "GET" | "POST";
  /** With `{id}` for a path parameter. */
  path: string;
  scope: string;
  tag: string;
  summary: string;
  description?: string;
  query?: Param[];
  /** POST body fields (JSON). */
  body?: Param[];
  /** The component schema of one item. */
  schema: string;
  /** A paged list (`data` is an array plus `next_cursor`), a report or one object. */
  shape: "list" | "report" | "object";
}

const paging: Param[] = [
  {
    name: "limit",
    type: "integer",
    description: "Items per page, 1 to 500 (default 100).",
  },
  {
    name: "cursor",
    type: "string",
    description: "The `next_cursor` of the previous page. Keep the other parameters the same.",
  },
  {
    name: "updated_since",
    type: "datetime",
    description:
      "Only items changed at or after this time (ISO 8601 with a zone). For syncing: pass the newest `updated_at` you have, minus a few minutes.",
  },
];

const userId: Param = { name: "user_id", type: "uuid", description: "One person." };
const days = (what: string): Param[] => [
  { name: "from", type: "date", description: `First day (YYYY-MM-DD) ${what}.` },
  { name: "to", type: "date", description: `Last day (YYYY-MM-DD) ${what}, inclusive.` },
];
const archived: Param = {
  name: "archived",
  type: "boolean",
  description: "true for archived only, false for active only; both when left out.",
};
const reportParams: Param[] = [
  { name: "from", type: "date", required: true, description: "First day (YYYY-MM-DD)." },
  {
    name: "to",
    type: "date",
    required: true,
    description: "Last day (YYYY-MM-DD), inclusive; at most 366 days after `from`.",
  },
  { name: "team_id", type: "uuid", description: "Only this team's members." },
  { name: "manager_id", type: "uuid", description: "Only this manager's direct reports." },
  userId,
];

export const operations: Operation[] = [
  {
    id: "people.list",
    method: "GET",
    path: "/v1/people",
    scope: "people:read",
    tag: "People",
    summary: "List people",
    query: [
      ...paging,
      {
        name: "active",
        type: "boolean",
        description: "true for active people, false for deactivated.",
      },
      { name: "team_id", type: "uuid", description: "Only this team's members." },
      { name: "manager_id", type: "uuid", description: "Only this manager's direct reports." },
      {
        name: "role",
        type: "string",
        enum: ["owner", "admin", "manager", "employee"],
        description: "Only this role.",
      },
    ],
    schema: "Person",
    shape: "list",
  },
  {
    id: "teams.list",
    method: "GET",
    path: "/v1/teams",
    scope: "teams:read",
    tag: "People",
    summary: "List teams",
    query: paging,
    schema: "Team",
    shape: "list",
  },
  {
    id: "clients.list",
    method: "GET",
    path: "/v1/clients",
    scope: "projects:read",
    tag: "Projects",
    summary: "List clients",
    query: [...paging, archived],
    schema: "Client",
    shape: "list",
  },
  {
    id: "clients.create",
    method: "POST",
    path: "/v1/clients",
    scope: "projects:write",
    tag: "Projects",
    summary: "Create a client",
    description: "409 `name_taken` when the org already has a client with that name.",
    body: [{ name: "name", type: "string", required: true, description: "1 to 120 characters." }],
    schema: "Client",
    shape: "object",
  },
  {
    id: "clients.archive",
    method: "POST",
    path: "/v1/clients/{id}/archive",
    scope: "projects:write",
    tag: "Projects",
    summary: "Archive a client",
    description: "Archiving an archived client changes nothing.",
    schema: "Client",
    shape: "object",
  },
  {
    id: "projects.list",
    method: "GET",
    path: "/v1/projects",
    scope: "projects:read",
    tag: "Projects",
    summary: "List projects",
    query: [
      ...paging,
      archived,
      { name: "client_id", type: "uuid", description: "One client's projects." },
    ],
    schema: "Project",
    shape: "list",
  },
  {
    id: "projects.create",
    method: "POST",
    path: "/v1/projects",
    scope: "projects:write",
    tag: "Projects",
    summary: "Create a project",
    description:
      "A new project has no members yet; add them on the dashboard's Projects page. 409 `name_taken` when the name is taken.",
    body: [
      { name: "name", type: "string", required: true, description: "1 to 120 characters." },
      {
        name: "client_id",
        type: "uuid",
        description: "The client it is for (none when left out).",
      },
      { name: "billable", type: "boolean", description: "Default true." },
    ],
    schema: "Project",
    shape: "object",
  },
  {
    id: "projects.archive",
    method: "POST",
    path: "/v1/projects/{id}/archive",
    scope: "projects:write",
    tag: "Projects",
    summary: "Archive a project",
    description: "Archiving an archived project changes nothing.",
    schema: "Project",
    shape: "object",
  },
  {
    id: "tasks.list",
    method: "GET",
    path: "/v1/tasks",
    scope: "projects:read",
    tag: "Projects",
    summary: "List tasks",
    query: [
      ...paging,
      archived,
      { name: "project_id", type: "uuid", description: "One project's tasks." },
    ],
    schema: "Task",
    shape: "list",
  },
  {
    id: "tasks.create",
    method: "POST",
    path: "/v1/tasks",
    scope: "projects:write",
    tag: "Projects",
    summary: "Create a task",
    body: [
      {
        name: "project_id",
        type: "uuid",
        required: true,
        description: "The project it belongs to.",
      },
      { name: "name", type: "string", required: true, description: "1 to 120 characters." },
      { name: "billable", type: "boolean", description: "Default: the project's." },
    ],
    schema: "Task",
    shape: "object",
  },
  {
    id: "tasks.archive",
    method: "POST",
    path: "/v1/tasks/{id}/archive",
    scope: "projects:write",
    tag: "Projects",
    summary: "Archive a task",
    description: "Archiving an archived task changes nothing.",
    schema: "Task",
    shape: "object",
  },
  {
    id: "shifts.list",
    method: "GET",
    path: "/v1/shifts",
    scope: "shifts:read",
    tag: "People",
    summary: "List shifts",
    description:
      "When a person's shifts change, all of them are replaced with new ones: when syncing, replace that person's shifts with the ones returned for them.",
    query: [...paging, userId],
    schema: "Shift",
    shape: "list",
  },
  {
    id: "timesheets.list",
    method: "GET",
    path: "/v1/timesheets",
    scope: "timesheets:read",
    tag: "Timesheets",
    summary: "List weekly timesheets",
    query: [
      ...paging,
      userId,
      {
        name: "status",
        type: "string",
        enum: ["draft", "submitted", "approved", "returned"],
        description: "Only this status.",
      },
      ...days("of the weeks' first days"),
    ],
    schema: "Timesheet",
    shape: "list",
  },
  {
    id: "segments.list",
    method: "GET",
    path: "/v1/segments",
    scope: "time:read",
    tag: "Timesheets",
    summary: "List per-day time segments",
    description:
      "A day's automatic segments are rebuilt (as new segments) when its facts change. When syncing, replace each person-day you receive with the segments returned for it.",
    query: [...paging, userId, ...days("(the person's own days)")],
    schema: "Segment",
    shape: "list",
  },
  {
    id: "manual_entries.list",
    method: "GET",
    path: "/v1/manual-entries",
    scope: "time:read",
    tag: "Timesheets",
    summary: "List manual entries",
    query: [
      ...paging,
      userId,
      {
        name: "status",
        type: "string",
        enum: ["pending", "approved", "rejected"],
        description: "Only this status.",
      },
      ...days("of the entries' start, in each person's time zone"),
    ],
    schema: "ManualEntry",
    shape: "list",
  },
  {
    id: "manual_entries.create",
    method: "POST",
    path: "/v1/manual-entries",
    scope: "time:write",
    tag: "Timesheets",
    summary: "Request a manual entry for a person",
    description:
      "Follows the same rules as the person's own request: pending until their manager decides (approved at once when they need no approval), at most 24 hours, not in the future, a project they are a member of and a task of it, no overlap with their clocked time or other entries (409), nothing in an approved week (409 `day_locked`). The key's creator is the actor in the audit log.",
    body: [
      { name: "user_id", type: "uuid", required: true, description: "The person (active)." },
      { name: "start_at", type: "datetime", required: true, description: "ISO 8601 with a zone." },
      { name: "end_at", type: "datetime", required: true, description: "ISO 8601 with a zone." },
      { name: "reason", type: "string", required: true, description: "1 to 500 characters." },
      { name: "project_id", type: "uuid", description: "A project the person is a member of." },
      { name: "task_id", type: "uuid", description: "A task of that project." },
      { name: "note", type: "string", description: "What was done, up to 2,000 characters." },
    ],
    schema: "ManualEntry",
    shape: "object",
  },
  {
    id: "checkins.list",
    method: "GET",
    path: "/v1/checkins",
    scope: "checkins:read",
    tag: "Check-ins",
    summary: "List check-ins (metadata only)",
    description:
      "The outcome, when it was shown and answered, and the response time. Never captures or links to them, apps, window titles, or when a check-in was scheduled.",
    query: [
      ...paging,
      userId,
      {
        name: "outcome",
        type: "string",
        enum: ["pass", "miss", "failed", "deferred"],
        description: "Only this outcome.",
      },
      ...days("it was shown, in each person's time zone"),
    ],
    schema: "Checkin",
    shape: "list",
  },
  {
    id: "alerts.list",
    method: "GET",
    path: "/v1/alerts",
    scope: "alerts:read",
    tag: "Alerts",
    summary: "List manager alerts",
    description: "One alert per recipient (the person's manager and any active delegate).",
    query: [
      ...paging,
      userId,
      {
        name: "kind",
        type: "string",
        enum: ["consecutive_misses", "offline", "tamper", "late_clock_in", "pause_over_cap"],
        description: "Only this kind.",
      },
      ...days("it was raised, in the person's time zone"),
    ],
    schema: "Alert",
    shape: "list",
  },
  {
    id: "reports.people",
    method: "GET",
    path: "/v1/reports/people",
    scope: "reports:read",
    tag: "Reports",
    summary: "Totals per person for a date range",
    description:
      "The Reports page's numbers: worked, flagged, excluded, break, pause and manual seconds, check-ins, response rate and time, late clock-ins and anomaly flags. Not paged; at most 1,000 people (400 `too_many_people`: narrow it to a team).",
    query: reportParams,
    schema: "PersonReport",
    shape: "report",
  },
  {
    id: "reports.tasks",
    method: "GET",
    path: "/v1/reports/tasks",
    scope: "reports:read",
    tag: "Reports",
    summary: "Seconds per person, project and task for a date range",
    query: reportParams,
    schema: "TaskReport",
    shape: "report",
  },
];

export interface Match {
  operation: Operation;
  id?: string;
}

function pattern(path: string): RegExp {
  return new RegExp(`^${path.replace("{id}", "([^/]+)")}$`);
}

const compiled = operations.map((op) => ({ op, re: pattern(op.path) }));

/** The operation for a method and path, `"method"` when only the method is wrong, or null. */
export function matchRoute(method: string, path: string): Match | "method" | null {
  let pathMatched = false;
  for (const { op, re } of compiled) {
    const m = re.exec(path);
    if (!m) continue;
    pathMatched = true;
    if (op.method === method)
      return { operation: op, id: m[1] ? decodeURIComponent(m[1]) : undefined };
  }
  return pathMatched ? "method" : null;
}

/** The methods a path takes, for a 405's Allow header. */
export function allowedMethods(path: string): string[] {
  return compiled.filter(({ re }) => re.test(path)).map(({ op }) => op.method);
}
