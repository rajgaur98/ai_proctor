// The MCP server's tools (#307, API-08): read-only v1. Names, descriptions and input
// schemas for tools/list; the database runs each one (internal.mcp_* in
// 20261105600000_mcp_server.sql), checks every argument and audit-logs the call. Keep the
// names in step with internal.mcp_tools().
//
// What no tool returns (API-04): capture images or links to them, window titles, websites,
// when a check-in was scheduled (so never the next one), anti-cheat flags or tamper
// reasons, and the free text people write (miss remarks, comments, manual entry reasons).

type Schema = Record<string, unknown>;

export interface Tool {
  name: string;
  title: string;
  description: string;
  inputSchema: Schema;
  annotations: Record<string, unknown>;
}

const uuid = (description: string): Schema => ({ type: "string", format: "uuid", description });
const day = (description: string): Schema => ({
  type: "string",
  pattern: "^\\d{4}-\\d{2}-\\d{2}$",
  description: `${description} (YYYY-MM-DD).`,
});

const statuses = [
  "active",
  "idle",
  "away",
  "away_locked",
  "in_meeting",
  "on_break",
  "paused",
  "offline",
  "tamper",
  "off_shift",
  "on_leave",
];

const readOnly = (title: string) => ({
  title,
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
});

function tool(
  name: string,
  title: string,
  description: string,
  properties: Schema,
  required: string[] = [],
): Tool {
  return {
    name,
    title,
    description,
    inputSchema: {
      type: "object",
      properties,
      ...(required.length ? { required } : {}),
      additionalProperties: false,
    },
    annotations: readOnly(title),
  };
}

export const tools: Tool[] = [
  tool(
    "list_people",
    "Find people",
    "People you can see in AI Proctor (yourself, your reports, or everyone for an owner or admin), with their role, team, manager and time zone. Use it to find the id other tools take for a person, team or manager. Active people only unless include_inactive is true. At most 200 rows (`truncated` says when there were more).",
    {
      query: {
        type: "string",
        maxLength: 100,
        description: "Part of the person's name (any case).",
      },
      team_id: uuid("Only this team's members."),
      manager_id: uuid("Only this manager's direct reports."),
      role: {
        type: "string",
        enum: ["owner", "admin", "manager", "employee"],
        description: "Only this role.",
      },
      include_inactive: { type: "boolean", description: "Also deactivated people. Default false." },
    },
  ),
  tool(
    "who_is_on_shift",
    "Who is on shift now",
    "Who is clocked in right now and their live status (active, idle, away, away_locked, in_meeting, on_break, paused, offline, tamper), since when, their last check-in result, the project they are on and today's check-ins shown and passed, like the dashboard's live team page. Only people you can see. Give `status` or include_off_shift to also see people who are off shift or on leave.",
    {
      team_id: uuid("Only this team's members."),
      status: { type: "string", enum: statuses, description: "Only people with this status now." },
      include_off_shift: {
        type: "boolean",
        description: "Also people who are off shift or on leave. Default false.",
      },
    },
  ),
  tool(
    "get_person_day",
    "A person's day",
    "One person's day in their own time zone: worked, flagged, excluded, manual, break and pause seconds; the time segments (type, project, task, counted, flagged, excluded); every check-in (outcome pass, miss, failed or deferred, when it was shown and answered, response time, and for a miss the reason they picked: meeting, phone_call, break, away or other); and the apps they spent the most time in (name and seconds; empty when the org doesn't record app activity). Flagged time needs review; it is never deducted. Durations are exact seconds.",
    {
      user_id: uuid("The person (from list_people). Default: you."),
      date: day("Their calendar day. Default: today in their time zone"),
    },
  ),
  tool(
    "list_timesheets",
    "Timesheets",
    "Weekly timesheets with status (draft, submitted, approved, returned), when they were submitted, approved or returned, the approver, and the week's worked, flagged, excluded and manual seconds. One week (`week`, any day in it; default this week) lists everyone you can see, including people who haven't started theirs (status draft, started false). `from`/`to` list the timesheets whose week starts in that range instead. waiting_for_my_approval: submitted weeks you can approve or return (any week unless `week` or `from`/`to` is given). At most 500 rows.",
    {
      week: day("Any day in the week"),
      from: day("Weeks starting on or after this day"),
      to: day("Weeks starting on or before this day"),
      status: {
        type: "string",
        enum: ["draft", "submitted", "approved", "returned"],
        description: "Only this status.",
      },
      waiting_for_my_approval: {
        type: "boolean",
        description: "Only submitted weeks waiting for you to approve or return.",
      },
      user_id: uuid("Only this person."),
      team_id: uuid("Only this team's members."),
    },
  ),
  tool(
    "hours_report",
    "Hours report",
    "Worked and flagged seconds for a date range (each person's own days, at most 366 days), grouped by person, team, client, project or task (task rows also name their project), from the same numbers as the dashboard's Reports page. Only people you can see; narrow it by team, manager, person, client or project. A null group is time without one (no team, no client, unassigned). Sorted by worked time, most first.",
    {
      from: day("First day"),
      to: day("Last day, inclusive"),
      group_by: {
        type: "string",
        enum: ["person", "team", "client", "project", "task"],
        description: "How to group the hours. Default person.",
      },
      team_id: uuid("Only this team's members."),
      manager_id: uuid("Only this manager's direct reports."),
      user_id: uuid("Only this person."),
      client_id: uuid("Only this client's projects."),
      project_id: uuid("Only this project."),
    },
    ["from", "to"],
  ),
  tool(
    "list_alerts",
    "Alerts",
    "Manager alerts you can see: consecutive_misses, offline, tamper, late_clock_in and pause_over_cap, with who they are about, when they were raised and their details, newest first. Yours, and for managers and admins those about the people they can see (never alerts about yourself). `from`/`to` are days in your time zone; the default is the last 7 days, at most 92 days. At most 200 rows.",
    {
      from: day("First day"),
      to: day("Last day, inclusive"),
      kind: {
        type: "string",
        enum: ["consecutive_misses", "offline", "tamper", "late_clock_in", "pause_over_cap"],
        description: "Only this kind.",
      },
      user_id: uuid("Only alerts about this person."),
      team_id: uuid("Only alerts about this team's members."),
    },
  ),
];

export const toolNames = new Set(tools.map((t) => t.name));

/** The MCP versions this server speaks, newest first. */
export const protocolVersions = ["2025-11-25", "2025-06-18", "2025-03-26"];

export const instructions =
  "AI Proctor records working time and presence check-ins for remote teams. These tools are read-only and see exactly what the signed-in person sees in the AI Proctor dashboard. Find people with list_people, then pass their id to the other tools. Dates are YYYY-MM-DD; a person's day is their own calendar day in their time zone. Durations are exact seconds: convert them to hours for people. Flagged time needs a manager's review and is never deducted. Screenshots, webcam frames, window titles, websites and when the next check-in will be are never available.";
