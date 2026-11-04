// The OpenAPI 3.1 document of the public API v1 (#306, API-01), built from the route table.
// Served at GET /v1/openapi.json and committed as docs/api/openapi.json
// (`pnpm api:openapi` writes it; `pnpm api:openapi --check` fails when it is stale).
import { type Operation, operations, type Param, type ParamType } from "./routes.ts";

type Schema = Record<string, unknown>;

const id = { type: "string", format: "uuid" };
const nullableId = { type: ["string", "null"], format: "uuid" };
const time = { type: "string", format: "date-time", description: "ISO 8601 with a zone." };
const nullableTime = { ...time, type: ["string", "null"] };
const day = { type: "string", format: "date" };
const seconds = (description: string) => ({
  type: "number",
  description: `${description} In seconds, exact (never rounded).`,
});
const text = { type: "string" };
const nullableText = { type: ["string", "null"] };

function object(properties: Record<string, Schema>, description?: string): Schema {
  return {
    type: "object",
    ...(description ? { description } : {}),
    required: Object.keys(properties),
    properties,
  };
}

const schemas: Record<string, Schema> = {
  Person: object({
    id,
    full_name: text,
    email: { type: "string", format: "email" },
    role: { type: "string", enum: ["owner", "admin", "manager", "employee"] },
    manager_id: nullableId,
    team_id: nullableId,
    timezone: { type: "string", description: "IANA time zone, e.g. America/Chicago." },
    work_country: nullableText,
    work_state: nullableText,
    active: { type: "boolean" },
    approval_required: {
      type: "boolean",
      description: "Whether their timesheets and manual entries need their manager's approval.",
    },
    created_at: time,
    updated_at: time,
  }),
  Team: object({ id, name: text, created_at: time, updated_at: time }),
  Client: object({
    id,
    name: text,
    archived: { type: "boolean" },
    created_at: time,
    updated_at: time,
  }),
  Project: object({
    id,
    client_id: nullableId,
    name: text,
    billable: { type: "boolean" },
    archived: { type: "boolean" },
    created_at: time,
    updated_at: time,
  }),
  Task: object({
    id,
    project_id: id,
    name: text,
    billable: { type: "boolean" },
    archived: { type: "boolean" },
    sort_order: { type: "integer" },
    created_at: time,
    updated_at: time,
  }),
  Shift: object(
    {
      id,
      user_id: id,
      days: {
        type: "array",
        items: { type: "integer", minimum: 1, maximum: 7 },
        description: "ISO weekdays, 1 = Monday ... 7 = Sunday.",
      },
      start_time: { type: "string", description: "HH:MM in the shift's time zone." },
      end_time: {
        type: "string",
        description: "HH:MM; earlier than start_time for a shift that runs past midnight.",
      },
      timezone: text,
      created_at: time,
      updated_at: { ...time, description: "Same as created_at: shifts are replaced, not changed." },
    },
    "A weekly shift.",
  ),
  Timesheet: object(
    {
      id,
      user_id: id,
      period_start: day,
      period_end: day,
      status: { type: "string", enum: ["draft", "submitted", "approved", "returned"] },
      submitted_at: nullableTime,
      approved_at: nullableTime,
      approver_id: { ...nullableId, description: "Who approved it (approved weeks only)." },
      returned_at: nullableTime,
      return_comment: { ...nullableText, description: "The manager's comment when returned." },
      worked_s: seconds("Counted time, flagged time excluded by a manager left out."),
      flagged_s: seconds("Flagged time that needs review (never deducted automatically)."),
      excluded_s: seconds("Time a manager excluded."),
      manual_s: seconds("Approved manual entries."),
      created_at: time,
      updated_at: time,
    },
    "A person's week.",
  ),
  Segment: object(
    {
      id,
      user_id: id,
      day: { ...day, description: "The person's local day." },
      start_at: time,
      end_at: time,
      duration_s: seconds("end_at - start_at."),
      type: {
        type: "string",
        enum: [
          "verified",
          "meeting",
          "idle",
          "unverified",
          "away",
          "offline",
          "pause",
          "pause_over_cap",
          "break",
          "manual",
        ],
      },
      project_id: nullableId,
      task_id: nullableId,
      counted: { type: "boolean", description: "Counts toward worked time." },
      flagged: { type: "boolean", description: "Needs review." },
      excluded: { type: "boolean", description: "A manager excluded it." },
      excluded_reason: nullableText,
      source: { type: "string", enum: ["auto", "manual"] },
      updated_at: time,
    },
    "A stretch of one person's day on their timesheet.",
  ),
  ManualEntry: object({
    id,
    user_id: id,
    start_at: time,
    end_at: time,
    duration_s: seconds("end_at - start_at."),
    project_id: nullableId,
    task_id: nullableId,
    reason: text,
    note: nullableText,
    status: { type: "string", enum: ["pending", "approved", "rejected"] },
    decided_by: nullableId,
    decided_at: nullableTime,
    decision_note: nullableText,
    created_at: time,
    updated_at: time,
  }),
  Checkin: object(
    {
      id,
      user_id: id,
      project_id: nullableId,
      outcome: { type: "string", enum: ["pass", "miss", "failed", "deferred"] },
      shown_at: nullableTime,
      responded_at: nullableTime,
      response_ms: { type: ["integer", "null"] },
      created_at: time,
      updated_at: time,
    },
    "A check-in's metadata. Captures are never available through the API.",
  ),
  Alert: object({
    id,
    user_id: { ...id, description: "The person the alert is about." },
    recipient_id: { ...id, description: "Who received it." },
    kind: {
      type: "string",
      enum: ["consecutive_misses", "offline", "tamper", "late_clock_in", "pause_over_cap"],
    },
    details: { type: "object", description: "Kind-specific details." },
    triggered_at: time,
    updated_at: { ...time, description: "Same as triggered_at: alerts don't change." },
  }),
  PersonReport: object({
    user_id: id,
    full_name: text,
    manager_id: nullableId,
    team_id: nullableId,
    worked_s: seconds("Counted, not excluded."),
    flagged_s: seconds("Flagged, not excluded."),
    excluded_s: seconds("Excluded by a manager."),
    break_s: seconds("Breaks."),
    pause_s: seconds("Pauses."),
    manual_s: seconds("Approved manual entries."),
    checkins_shown: { type: "integer" },
    checkins_passed: { type: "integer" },
    checkins_missed: { type: "integer" },
    checkins_failed: { type: "integer" },
    response_rate: { type: ["number", "null"], description: "Passed / shown, 0 to 1." },
    median_response_ms: { type: ["number", "null"] },
    late_clock_ins: { type: "integer" },
    anomaly_flags: {
      type: "integer",
      description: "Anti-cheat flags (needs review, never penalties).",
    },
    anomaly_flags_needing_review: { type: "integer" },
  }),
  TaskReport: object({
    user_id: id,
    project_id: nullableId,
    task_id: nullableId,
    worked_s: seconds("Counted time."),
    flagged_s: seconds("Flagged time."),
  }),
  Error: object({
    error: {
      type: "object",
      required: ["code", "message"],
      properties: {
        code: {
          type: "string",
          description:
            "Stable, machine-readable: e.g. missing_key, invalid_key, key_revoked, key_expired, insufficient_scope, invalid_param, rate_limited, not_found, name_taken.",
        },
        message: { type: "string", description: "For people; may change." },
        param: { type: "string", description: "The parameter at fault (invalid_param)." },
      },
    },
  }),
};

function paramSchema(p: Param): Schema {
  const base: Record<ParamType, Schema> = {
    string: { type: "string" },
    uuid: { type: "string", format: "uuid" },
    date: { type: "string", format: "date" },
    datetime: { type: "string", format: "date-time" },
    boolean: { type: "boolean" },
    integer: { type: "integer" },
  };
  return p.enum ? { ...base[p.type], enum: p.enum } : base[p.type];
}

const rateHeaders = {
  "X-RateLimit-Limit": { $ref: "#/components/headers/RateLimitLimit" },
  "X-RateLimit-Remaining": { $ref: "#/components/headers/RateLimitRemaining" },
  "X-RateLimit-Reset": { $ref: "#/components/headers/RateLimitReset" },
};

const errorResponse = (description: string) => ({
  description,
  content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
});

const responses = {
  BadRequest: errorResponse("A parameter is missing or wrong (`invalid_param`, with `param`)."),
  Unauthorized: errorResponse("No key, or a key that is not valid, revoked or expired."),
  Forbidden: errorResponse("The key lacks the scope (`insufficient_scope`)."),
  NotFound: errorResponse("The id is not in this organization."),
  Conflict: errorResponse("A conflict: a taken name, an overlap or a locked week."),
  RateLimited: {
    ...errorResponse("Too many requests (`rate_limited`); see Retry-After."),
    headers: { "Retry-After": { schema: { type: "integer" } }, ...rateHeaders },
  },
};

const ref = (name: keyof typeof responses) => ({ $ref: `#/components/responses/${name}` });

function successSchema(op: Operation): Schema {
  const item = { $ref: `#/components/schemas/${op.schema}` };
  if (op.shape === "object") return object({ data: item });
  if (op.shape === "list") {
    return object({
      data: { type: "array", items: item },
      next_cursor: {
        type: ["string", "null"],
        description: "Pass as `cursor` for the next page; null on the last page.",
      },
    });
  }
  const extra =
    op.id === "reports.people"
      ? {
          late_grace_min: {
            type: "integer",
            description: "Minutes after a shift's start before a clock-in counts as late.",
          },
          median_response_ms: {
            type: ["number", "null"],
            description: "Over every passed check-in of these people.",
          },
        }
      : {};
  return {
    type: "object",
    required: ["data", "from", "to"],
    properties: { data: { type: "array", items: item }, from: day, to: day, ...extra },
  };
}

function operationObject(op: Operation): Schema {
  const parameters = [
    ...(op.path.includes("{id}")
      ? [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }]
      : []),
    ...(op.query ?? []).map((p) => ({
      name: p.name,
      in: "query",
      required: p.required ?? false,
      description: p.description,
      schema: paramSchema(p),
    })),
  ];
  const body = op.body
    ? {
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                additionalProperties: false,
                required: op.body.filter((p) => p.required).map((p) => p.name),
                properties: Object.fromEntries(
                  op.body.map((p) => [p.name, { ...paramSchema(p), description: p.description }]),
                ),
              },
            },
          },
        },
      }
    : {};
  const ok = op.method === "POST" && op.id.endsWith(".create") ? "201" : "200";
  return {
    operationId: op.id.replace(/[._](\w)/g, (_, c: string) => c.toUpperCase()),
    tags: [op.tag],
    summary: op.summary,
    description: [op.description, `Scope: \`${op.scope}\`.`].filter(Boolean).join("\n\n"),
    security: [{ apiKey: [] }],
    ...(parameters.length ? { parameters } : {}),
    ...body,
    responses: {
      [ok]: {
        description: "OK",
        headers: rateHeaders,
        content: { "application/json": { schema: successSchema(op) } },
      },
      "400": ref("BadRequest"),
      "401": ref("Unauthorized"),
      "403": ref("Forbidden"),
      ...(op.method === "POST" ? { "404": ref("NotFound"), "409": ref("Conflict") } : {}),
      "429": ref("RateLimited"),
    },
  };
}

export function openApiDocument(): Schema {
  const paths: Record<string, Record<string, Schema>> = {};
  for (const op of operations) {
    paths[op.path] ??= {};
    paths[op.path][op.method.toLowerCase()] = operationObject(op);
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "AI Proctor API",
      version: "1.0.0",
      description:
        "Read people, projects, timesheets, time, check-in metadata, reports and alerts, and create clients, projects, tasks and manual entries. Authenticate with an org API key (`Authorization: Bearer aip_...`) made by an owner or admin on the dashboard's API page. Times are ISO 8601 with a zone; durations are exact seconds. Every request is recorded in the org's audit log. The API never returns capture images or links to them, window titles, or when a check-in is scheduled. See docs/api/v1.md.",
    },
    servers: [
      {
        url: "/functions/v1/api-v1",
        description:
          "Relative to the backend's URL (the Supabase project URL). The production host is set at deploy.",
      },
    ],
    security: [{ apiKey: [] }],
    tags: [
      { name: "People" },
      { name: "Projects" },
      { name: "Timesheets" },
      { name: "Check-ins" },
      { name: "Reports" },
      { name: "Alerts" },
    ],
    paths,
    components: {
      securitySchemes: {
        apiKey: {
          type: "http",
          scheme: "bearer",
          description: "An org API key: `aip_` and 43 characters.",
        },
      },
      schemas,
      responses,
      headers: {
        RateLimitLimit: {
          description: "Requests per minute for the key.",
          schema: { type: "integer" },
        },
        RateLimitRemaining: { description: "Left in this minute.", schema: { type: "integer" } },
        RateLimitReset: {
          description: "When the minute ends (epoch seconds).",
          schema: { type: "integer" },
        },
      },
    },
  };
}
