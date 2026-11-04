// What the audit log's action names mean to a person (#53, AUD-01), and a one-line
// summary of each row's metadata. Unknown actions (added by newer migrations) fall
// back to the raw name and the metadata as JSON.
import type { Json } from "@ai-proctor/contracts";
import { reasonLabel } from "../day/checkinText";
import { holidayPlace, leaveWhen } from "../timeoff/leaveText";

export const actionLabels: Record<string, string> = {
  "member.invited": "Invited a member",
  "member.role_changed": "Changed a role",
  "member.manager_changed": "Changed a direct manager",
  "member.location_changed": "Changed a work location",
  "member.shifts_changed": "Changed shifts",
  "member.deactivated": "Deactivated a member",
  "member.reactivated": "Reactivated a member",
  "member.team_changed": "Changed a member's team",
  "member.assistive_input_changed": "Changed assistive input",
  "team.created": "Created a team",
  "team.renamed": "Renamed a team",
  "team.deleted": "Deleted a team",
  "team.policy_changed": "Changed a team's policy",
  "capture.viewed": "Viewed captures",
  "audit_log.exported": "Exported the audit log",
  "export.created": "Exported a list",
  "enrollment_token.created": "Created an enrollment token",
  "enrollment_token.revoked": "Revoked an enrollment token",
  "enrollment_token.used": "Enrolled a device",
  "import.applied": "Imported data",
  "checkin.miss_reason_set": "Set a miss reason",
  "timesheet.commented": "Commented on a timesheet",
  "api_key.created": "Created an API key",
  "api_key.revoked": "Revoked an API key",
  "api.read": "Read through the API",
  "api.write": "Changed through the API",
  "webhook.created": "Added a webhook endpoint",
  "webhook.changed": "Changed a webhook endpoint",
  "webhook.deleted": "Deleted a webhook endpoint",
  "webhook.secret_rotated": "Rotated a webhook secret",
  "webhook.disabled": "Turned off a failing webhook endpoint",
  "webhook.test_sent": "Sent a webhook test event",
  "webhook.redelivered": "Redelivered a webhook event",
  "leave_type.created": "Added a leave type",
  "leave_type.changed": "Changed a leave type",
  "holiday.added": "Added a holiday",
  "holiday.changed": "Changed a holiday",
  "holiday.removed": "Removed a holiday",
  "leave.requested": "Requested time off",
  "leave.approved": "Approved time off",
  "leave.rejected": "Declined time off",
  "leave.cancelled": "Cancelled time off",
};

/** Actions offered in the filter, in the order above. */
export const knownActions = Object.keys(actionLabels);

export function actionLabel(action: string): string {
  return actionLabels[action] ?? action;
}

type Meta = Record<string, unknown>;

const text = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const role = (v: unknown): string => {
  const r = text(v);
  return r ? r.charAt(0).toUpperCase() + r.slice(1) : "—";
};
const place = (v: unknown): string => {
  const p = (v ?? {}) as { country?: unknown; state?: unknown };
  return [text(p.country), text(p.state)].filter(Boolean).join(" · ") || "—";
};
const onOff = (v: unknown): string => (v === true ? "On" : v === false ? "Off" : "—");
const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;
const count = (v: unknown): number => (Array.isArray(v) ? v.length : 0);
/** An enrollment token (#86): its name and prefix, never the token. */
const tokenName = (m: Meta): string => {
  const prefix = text(m.prefix);
  return [text(m.label), prefix ? `${prefix}…` : null].filter(Boolean).join(" · ") || "—";
};

/** An API key (#306): its name and prefix, never the key. */
const apiKeyName = (m: Meta): string => {
  const prefix = text(m.prefix);
  return (
    [text(m.key_name) ?? text(m.name), prefix ? `${prefix}…` : null].filter(Boolean).join(" · ") ||
    "—"
  );
};

/** A webhook endpoint (#320): its host and events, never the whole URL or the secret. */
const webhookEvents = (v: unknown): string | null =>
  Array.isArray(v) && v.length ? v.map(String).join(", ") : null;

const webhookChange = (changed: unknown): string | null => {
  if (!changed || typeof changed !== "object") return null;
  const c = changed as Record<string, { from?: unknown; to?: unknown }>;
  return (
    [
      c.host ? `host ${text(c.host.from) ?? "—"} → ${text(c.host.to) ?? "—"}` : null,
      c.events ? `events → ${webhookEvents(c.events.to) ?? "none"}` : null,
      c.enabled ? (c.enabled.to === true ? "turned on" : "turned off") : null,
    ]
      .filter(Boolean)
      .join(" · ") || null
  );
};

/** "Vacation · Mon 16 Nov 2026" from a time-off row (#304); the note's length, never its words. */
const leave = (m: Meta): string => {
  const when = leaveWhen({
    kind: text(m.kind) ?? "days",
    firstDay: text(m.first_day) ?? "",
    lastDay: text(m.last_day) ?? "",
    startAt: text(m.start_at) ?? "",
    endAt: text(m.end_at) ?? "",
    timezone: text(m.timezone) ?? "UTC",
  });
  const noteLength = typeof m.note_length === "number" ? m.note_length : 0;
  return [
    text(m.type_name),
    m.paid === false ? "unpaid" : null,
    when || null,
    noteLength > 0 ? `note ${plural(noteLength, "character")}` : null,
    m.auto_approved === true ? "approved at once (no manager)" : null,
  ]
    .filter(Boolean)
    .join(" · ");
};

/** `nameOf` turns a user id into a name (or something short when it's unknown). */
export function summarize(
  action: string,
  metadata: Json,
  nameOf: (id: string | null) => string,
): string {
  const m: Meta =
    metadata && typeof metadata === "object" && !Array.isArray(metadata) ? metadata : {};
  switch (action) {
    case "member.invited":
      return `As ${role(m.role)}, reporting to ${nameOf(text(m.manager_id))}`;
    case "member.role_changed":
      return `${role(m.from)} → ${role(m.to)}`;
    case "member.manager_changed":
      return `${nameOf(text(m.from))} → ${nameOf(text(m.to))}`;
    case "member.location_changed":
      return `${place(m.from)} → ${place(m.to)}`;
    case "member.shifts_changed":
      return `${plural(count(m.from), "shift")} → ${plural(count(m.to), "shift")}`;
    case "member.deactivated":
    case "member.reactivated":
      return "—";
    case "member.team_changed":
      return `${text(m.from_name) ?? "No team"} → ${text(m.to_name) ?? "No team"}`;
    case "member.assistive_input_changed":
      return `${onOff(m.from)} → ${onOff(m.to)}`;
    case "team.created":
      return text(m.name) ?? "—";
    case "team.renamed":
      return `${text(m.from) ?? "—"} → ${text(m.to) ?? "—"}`;
    case "team.deleted":
      return `${text(m.name) ?? "—"} · ${plural(count(m.members), "member")}`;
    case "team.policy_changed": {
      const changed = m.changed && typeof m.changed === "object" ? Object.keys(m.changed) : [];
      return `${text(m.name) ?? "—"} · ${plural(changed.length, "setting")}`;
    }
    case "capture.viewed": {
      const id = text(m.checkin_id);
      const files = count(m.objects);
      return [id ? `Check-in ${id.slice(0, 8)}` : null, files ? plural(files, "file") : null]
        .filter(Boolean)
        .join(" · ");
    }
    case "audit_log.exported": {
      const f = (m.filters ?? {}) as Meta;
      const parts = [plural(typeof m.row_count === "number" ? m.row_count : 0, "row")];
      if (Array.isArray(f.actions)) parts.push(`actions: ${f.actions.map(String).join(", ")}`);
      if (text(f.actor_id)) parts.push(`actor: ${nameOf(text(f.actor_id))}`);
      if (text(f.target_user_id)) parts.push(`target: ${nameOf(text(f.target_user_id))}`);
      if (text(f.from)) parts.push(`from ${text(f.from)}`);
      if (text(f.to)) parts.push(`to ${text(f.to)}`);
      return parts.join(" · ");
    }
    case "export.created": {
      // #255: a list page's export; the filters are as the page names them.
      const f = (m.filters ?? {}) as Meta;
      const parts = [
        text(m.page) ?? "—",
        (text(m.format) ?? "").toUpperCase() || null,
        plural(typeof m.row_count === "number" ? m.row_count : 0, "row"),
        ...Object.entries(f).map(([k, v]) => `${k}: ${String(v)}`),
      ];
      return parts.filter(Boolean).join(" · ");
    }
    case "enrollment_token.created":
    case "enrollment_token.revoked":
      return tokenName(m);
    case "enrollment_token.used":
      return `With ${tokenName(m)}`;
    case "import.applied": {
      const n = (v: unknown) => (typeof v === "number" ? v : 0);
      const kind = role(m.kind);
      return `${kind} · ${n(m.created)} added, ${n(m.updated)} updated · ${plural(n(m.rows), "row")}`;
    }
    case "checkin.miss_reason_set": {
      // #252: the quick pick before and after, and the remark's length (never its words).
      const pick = (v: unknown) => reasonLabel[text(v) ?? ""] ?? text(v) ?? "None";
      const remark = (v: unknown) =>
        typeof v === "number" && v > 0 ? `remark ${plural(v, "character")}` : "no remark";
      return `${pick(m.from_kind)} (${remark(m.from_note_length)}) → ${pick(m.to_kind)} (${remark(m.to_note_length)})`;
    }
    case "timesheet.commented": {
      // #265: where the comment is and its length (its words stay with the timesheet).
      const week = text(m.period_start);
      return [
        m.target === "entry" ? "On a manual entry" : "On a row",
        week ? `week of ${week}` : null,
        typeof m.length === "number" ? plural(m.length, "character") : null,
      ]
        .filter(Boolean)
        .join(" · ");
    }
    case "api_key.created": {
      const scopes = Array.isArray(m.scopes) ? m.scopes.map(String).join(", ") : "";
      return [apiKeyName(m), scopes || null].filter(Boolean).join(" · ");
    }
    case "api_key.revoked":
      return apiKeyName(m);
    case "api.read": {
      // #306: like an export, the operation, its filters and the row count.
      const f = (m.filters ?? {}) as Meta;
      return [
        text(m.operation) ?? "—",
        plural(typeof m.row_count === "number" ? m.row_count : 0, "row"),
        ...Object.entries(f).map(([k, v]) => `${k}: ${String(v)}`),
        `key ${apiKeyName(m)}`,
      ].join(" · ");
    }
    case "api.write":
      return [text(m.operation) ?? "—", `key ${apiKeyName(m)}`].join(" · ");
    case "webhook.created":
    case "webhook.deleted":
      return [text(m.host), webhookEvents(m.events)].filter(Boolean).join(" · ") || "—";
    case "webhook.changed":
      return [text(m.host), webhookChange(m.changed)].filter(Boolean).join(" · ") || "—";
    case "webhook.secret_rotated":
    case "webhook.test_sent":
      return text(m.host) ?? "—";
    case "webhook.redelivered":
      return [text(m.host), text(m.event_type)].filter(Boolean).join(" · ") || "—";
    case "webhook.disabled":
      return (
        [
          text(m.host),
          typeof m.failed_deliveries === "number"
            ? `${plural(m.failed_deliveries, "failed event")} in a row`
            : null,
        ]
          .filter(Boolean)
          .join(" · ") || "—"
      );
    case "leave_type.created":
      return `${text(m.name) ?? "—"} · ${m.paid === false ? "Unpaid" : "Paid"}`;
    case "leave_type.changed": {
      const changed = m.changed && typeof m.changed === "object" ? Object.keys(m.changed) : [];
      return [text(m.name) ?? "—", changed.length ? `changed ${changed.join(", ")}` : null]
        .filter(Boolean)
        .join(" · ");
    }
    case "holiday.added":
    case "holiday.changed":
    case "holiday.removed":
      return [text(m.name) ?? "—", text(m.day), holidayPlace(text(m.country), text(m.state))]
        .filter(Boolean)
        .join(" · ");
    case "leave.requested":
    case "leave.approved":
    case "leave.rejected":
    case "leave.cancelled":
      return leave(m) || "—";
    default:
      return Object.keys(m).length ? JSON.stringify(m) : "—";
  }
}
