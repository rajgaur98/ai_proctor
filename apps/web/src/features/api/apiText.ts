// Pure helpers for the API page (#306): the scopes a key can hold, a key's status and the
// server's refusals, kept apart from the data module so they test without a Supabase client.

/** The scopes in the order the page offers them (internal.api_scopes()). */
export const scopeGroups: { resource: string; about: string; read: string; write?: string }[] = [
  { resource: "People", about: "Names, emails, roles, managers, teams", read: "people:read" },
  { resource: "Teams", about: "Team names", read: "teams:read" },
  {
    resource: "Clients, projects and tasks",
    about: "Write: create and archive them",
    read: "projects:read",
    write: "projects:write",
  },
  { resource: "Shifts", about: "Weekly shifts", read: "shifts:read" },
  {
    resource: "Timesheets",
    about: "Weekly status, approver and totals",
    read: "timesheets:read",
  },
  {
    resource: "Time",
    about: "Per-day segments and manual entries. Write: request manual entries",
    read: "time:read",
    write: "time:write",
  },
  {
    resource: "Check-ins",
    about: "Outcome, times and response time only; never captures",
    read: "checkins:read",
  },
  { resource: "Reports", about: "Totals per person, project and task", read: "reports:read" },
  { resource: "Alerts", about: "Manager alerts", read: "alerts:read" },
  {
    resource: "Time off",
    about: "Time-off requests (never their notes) and holidays",
    read: "timeoff:read",
  },
];

export const allScopes = scopeGroups.flatMap((g) => (g.write ? [g.read, g.write] : [g.read]));

/** "People: read", "Time: read, write" … for a key's scopes, in the page's order. */
export function scopeSummary(scopes: string[]): string {
  const have = new Set(scopes);
  return scopeGroups
    .map((g) => {
      const parts = [
        have.has(g.read) ? "read" : null,
        g.write && have.has(g.write) ? "write" : null,
      ];
      const on = parts.filter(Boolean);
      return on.length ? `${g.resource}: ${on.join(", ")}` : null;
    })
    .filter(Boolean)
    .join(" · ");
}

export type KeyStatus = "Active" | "Revoked" | "Expired";

export function keyStatus(
  k: { revokedAt: string | null; expiresAt: string | null },
  now: Date = new Date(),
): KeyStatus {
  if (k.revokedAt) return "Revoked";
  if (k.expiresAt && new Date(k.expiresAt) <= now) return "Expired";
  return "Active";
}

/** The end of a local day (YYYY-MM-DD) as an ISO time: a key "expires on" that day. */
export function endOfDay(day: string): string {
  const [y = 0, m = 1, d = 1] = day.split("-").map(Number);
  return new Date(y, m - 1, d, 23, 59, 59).toISOString();
}

const messages: Record<string, string> = {
  admin_only: "Only owners and admins can manage API keys.",
  mfa_required: "Verify two-factor authentication to manage API keys.",
  invalid_name: "Enter a name of up to 80 characters.",
  invalid_scopes: "Choose at least one thing the key may read or change.",
  invalid_expiry: "Choose an expiry date after today.",
  key_not_found: "That key is no longer there. Reload the page.",
};

export function explain(code: string): string {
  return messages[code] ?? code;
}
