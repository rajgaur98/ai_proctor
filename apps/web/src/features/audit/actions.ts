// What the audit log's action names mean to a person (#53, AUD-01), and a one-line
// summary of each row's metadata. Unknown actions (added by newer migrations) fall
// back to the raw name and the metadata as JSON.
import type { Json } from "@ai-proctor/contracts";

export const actionLabels: Record<string, string> = {
  "member.invited": "Invited a member",
  "member.role_changed": "Changed a role",
  "member.manager_changed": "Changed a direct manager",
  "member.location_changed": "Changed a work location",
  "member.shifts_changed": "Changed shifts",
  "member.deactivated": "Deactivated a member",
  "member.reactivated": "Reactivated a member",
  "capture.viewed": "Viewed captures",
  "audit_log.exported": "Exported the audit log",
  "enrollment_token.created": "Created an enrollment token",
  "enrollment_token.revoked": "Revoked an enrollment token",
  "enrollment_token.used": "Enrolled a device",
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
const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;
const count = (v: unknown): number => (Array.isArray(v) ? v.length : 0);
/** An enrollment token (#86): its name and prefix, never the token. */
const tokenName = (m: Meta): string => {
  const prefix = text(m.prefix);
  return [text(m.label), prefix ? `${prefix}…` : null].filter(Boolean).join(" · ") || "—";
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
    case "enrollment_token.created":
    case "enrollment_token.revoked":
      return tokenName(m);
    case "enrollment_token.used":
      return `With ${tokenName(m)}`;
    default:
      return Object.keys(m).length ? JSON.stringify(m) : "—";
  }
}
