// Pure helpers for the webhooks part of Settings → API (#320, API-06): the events an endpoint
// can subscribe to, an endpoint's and a delivery's status, and the server's refusals. Kept
// apart from the data module so they test without a Supabase client.

/** The events in the order the page offers them (internal.webhook_event_types()). */
export const webhookEvents: { type: string; label: string }[] = [
  { type: "timesheet.submitted", label: "Timesheet submitted" },
  { type: "timesheet.approved", label: "Timesheet approved" },
  { type: "timesheet.returned", label: "Timesheet returned" },
  { type: "alert.raised", label: "Alert raised" },
  { type: "person.invited", label: "Person invited" },
  { type: "person.deactivated", label: "Person deactivated" },
  { type: "time_off.decided", label: "Time off decided" },
];

export function eventLabel(type: string): string {
  return webhookEvents.find((e) => e.type === type)?.label ?? type;
}

/** "Timesheet submitted, Alert raised" for an endpoint's events, in the page's order. */
export function eventSummary(events: string[]): string {
  const have = new Set(events);
  const known = webhookEvents.filter((e) => have.has(e.type)).map((e) => e.label);
  const other = events.filter((t) => !webhookEvents.some((e) => e.type === t));
  return [...known, ...other].join(", ");
}

export type EndpointStatus = "Active" | "Off" | "Turned off: failing";

export function endpointStatus(w: {
  enabled: boolean;
  disabledReason: string | null;
}): EndpointStatus {
  if (w.enabled) return "Active";
  return w.disabledReason === "failing" ? "Turned off: failing" : "Off";
}

export type DeliveryStatus = "Delivered" | "Failed" | "Retrying" | "Queued";

export function deliveryStatus(d: { status: string; attempts: number }): DeliveryStatus {
  if (d.status === "delivered") return "Delivered";
  if (d.status === "failed") return "Failed";
  return d.attempts > 0 ? "Retrying" : "Queued";
}

/** What the receiver answered, or why there was no answer. */
export function deliveryResult(d: {
  responseStatus: number | null;
  lastError: string | null;
}): string {
  if (d.responseStatus !== null && d.lastError === null) return `HTTP ${d.responseStatus}`;
  return d.lastError ?? "—";
}

const messages: Record<string, string> = {
  admin_only: "Only owners and admins can manage webhooks.",
  mfa_required: "Verify two-factor authentication to manage webhooks.",
  invalid_url:
    "Enter an https:// URL on a public host name (no private or local addresses, no user name or password).",
  invalid_events: "Choose at least one event.",
  url_taken: "Another endpoint already uses that URL.",
  too_many_webhooks: "An organization can have at most 10 endpoints. Delete one first.",
  webhook_not_found: "That endpoint is no longer there. Reload the page.",
};

export function explainWebhook(code: string): string {
  return messages[code] ?? code;
}
