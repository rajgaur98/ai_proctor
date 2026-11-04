// Pure helpers for AI assistant access (#307, API-07): the sign-in page's return path and
// what the consent page and the API page say. Kept apart from the data module so they
// test without a Supabase client.

/** A path in this dashboard to return to after signing in, or null: only "/…", never
 * "//host" or a full URL, so a link can't send someone elsewhere. */
export function safeReturnPath(value: unknown): string | null {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) return null;
  if (value.includes("\\") || [...value].some((c) => c.charCodeAt(0) < 0x20)) return null;
  return value;
}

/** Where an assistant sends the person back to, as a host they can recognise. */
export function returnHost(uri: string): string {
  try {
    const u = new URL(uri);
    return u.protocol === "http:" || u.protocol === "https:" ? u.host : `${u.protocol}//${u.host}`;
  } catch {
    return uri;
  }
}

export interface AccessChange {
  enabled: boolean;
  notice_version: number | null;
  notice_edited: boolean;
}

/** What happened to the monitoring notice when access changed (ADM-06). */
export function noticeOutcome(change: AccessChange): string {
  const state = change.enabled ? "on" : "off";
  if (change.notice_version !== null) {
    return `AI assistant access is ${state}. Monitoring notice version ${change.notice_version} was published to say so; everyone acknowledges it again.`;
  }
  if (change.notice_edited) {
    return `AI assistant access is ${state}. Your monitoring notice has your own text, so it wasn't changed: update it on the Notice page to say whether AI assistant access is on.`;
  }
  return `AI assistant access is ${state}.`;
}

/** The server's refusals, in words. */
export function explainAccessError(message: string): string {
  if (message.includes("admin_only")) return "Only owners and admins can change this.";
  if (message.includes("mfa_required")) return "Verify with your authenticator app first.";
  return message;
}
