// send-emails (#50, #46; ALR-01, ALR-02, TS-17, LLD jobs table): delivers the emails
// waiting in email_outbox (alerts, and the reminder_* timesheet reminders). Called every minute by the send_emails cron job (internal.send_emails_kick,
// through pg_net) with the service-role key as the bearer token; nobody else may call it.
//
// It claims due rows with email_claim (which counts the attempt and sets the retry
// backoff), sends each, and records the result with email_mark_sent / email_mark_failed.
// After five attempts a row is left alone with its last_error.
//
// Transport:
//  - RESEND_API_KEY set (production): Resend's HTTP API, from EMAIL_FROM
//    ("AI Proctor <alerts@your-domain>"). The outbox id is the Idempotency-Key, so a
//    retry after a lost response never sends twice.
//  - RESEND_API_KEY unset (local): the stack's Mailpit (MAILPIT_URL, default
//    http://inbucket:8025, the address the edge runtime sees), so mail can be read in
//    its inbox. EMAIL_FROM is optional there.
// DASHBOARD_URL (default http://localhost:5173) is the base of the links in the mail.
// Reply: { claimed, sent, failed }.
import { createClient } from "npm:@supabase/supabase-js@2.118.0";

const MAX_BATCH = 50;
// Resend allows 2 requests a second on the free tier.
const RESEND_SPACING_MS = 600;

interface OutboxRow {
  id: string;
  to_email: string;
  template: string;
  payload: Record<string, unknown>;
}

interface Message {
  subject: string;
  text: string;
  html: string;
}

interface AlertItem {
  id: string;
  triggered_at: string;
  details: Record<string, unknown>;
}

function reply(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

/** Compares without stopping at the first difference. */
function sameSecret(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** "Tue 20 Oct, 14:03 PDT" in the employee's own zone. */
function when(iso: unknown, zone: string): string {
  const d = new Date(String(iso));
  if (Number.isNaN(d.getTime())) return String(iso);
  try {
    return new Intl.DateTimeFormat("en-US", {
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      timeZoneName: "short",
      timeZone: zone,
    }).format(d);
  } catch {
    return d.toISOString();
  }
}

const KIND_TITLES: Record<string, string> = {
  consecutive_misses: "Missed check-ins in a row",
  offline: "Offline during a shift",
  tamper: "Tamper status",
  late_clock_in: "Late clock-in",
  pause_over_cap: "Pauses over the daily cap",
};

/** One line saying what happened for one alert. */
function describe(kind: string, a: AlertItem, name: string, zone: string): string {
  const d = a.details;
  switch (kind) {
    case "consecutive_misses":
      return `${name} has missed ${d.misses} check-ins in a row, since ${when(d.first_miss_at, zone)}.`;
    case "offline":
      return `${name} has been offline since ${when(d.since, zone)} (alert after ${d.threshold_min} min) while clocked in.`;
    case "tamper":
      return `${name} has been in Tamper status since ${when(d.since, zone)}: capture was blocked or the agent stopped reporting. This needs review; it is not a penalty.`;
    case "late_clock_in":
      return `${name} had not clocked in ${d.grace_min} min after the shift started at ${when(d.shift_start, zone)}.`;
    case "pause_over_cap": {
      const mins = Math.round(Number(d.total_s) / 60);
      return `${name} has paused ${mins} min on ${d.day}, over the daily cap of ${d.cap_min} min.`;
    }
    default:
      return `${name}: ${kind}.`;
  }
}

function alertMessage(row: OutboxRow, dashboardUrl: string): Message {
  const p = row.payload;
  const kind = String(p.kind);
  const name = String(p.employee_name ?? "An employee");
  const zone = String(p.employee_timezone ?? "UTC");
  const alerts = (Array.isArray(p.alerts) ? p.alerts : []) as AlertItem[];
  const title = KIND_TITLES[kind] ?? kind;
  const link = `${dashboardUrl.replace(/\/$/, "")}/team/${encodeURIComponent(String(p.employee_id))}`;
  const lines = alerts.map((a) => describe(kind, a, name, zone));
  const subject =
    alerts.length > 1 ? `${name}: ${title} (${alerts.length} alerts)` : `${name}: ${title}`;
  const greeting = `Hi ${String(p.recipient_name ?? "there")},`;

  const text = [
    greeting,
    "",
    ...lines.map((l) => `- ${l}`),
    "",
    `Open ${name}'s day: ${link}`,
    "",
    "You get at most one email an hour per person and alert type. Alerts are also in the dashboard.",
  ].join("\n");
  const html = [
    `<p>${escapeHtml(greeting)}</p>`,
    `<ul>${lines.map((l) => `<li>${escapeHtml(l)}</li>`).join("")}</ul>`,
    `<p><a href="${escapeHtml(link)}">Open ${escapeHtml(name)}'s day</a></p>`,
    `<p style="color:#696d74;font-size:13px">You get at most one email an hour per person and alert type. Alerts are also in the dashboard.</p>`,
  ].join("\n");
  return { subject, text, html };
}

/** "Mon 12 Oct" for a plain date (YYYY-MM-DD). */
function day(d: unknown): string {
  const t = new Date(`${String(d)}T00:00:00Z`);
  if (Number.isNaN(t.getTime())) return String(d);
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  }).format(t);
}

/**
 * The timesheet reminders (TS-17, #46): reminder_submit (to the employee),
 * reminder_approval (to the manager or delegate) and reminder_escalation (to admins,
 * notify only). The payload is written by internal.queue_reminder.
 */
function reminderMessage(row: OutboxRow, dashboardUrl: string): Message {
  const p = row.payload;
  const base = dashboardUrl.replace(/\/$/, "");
  const name = String(p.employee_name ?? "An employee");
  const range = `${day(p.period_start)} to ${day(p.period_end)}`;
  const zone = String(p.recipient_timezone ?? "UTC");
  const greeting = `Hi ${String(p.recipient_name ?? "there")},`;
  const review = `${base}/timesheets/${encodeURIComponent(String(p.employee_id))}?week=${encodeURIComponent(String(p.period_start))}`;

  let subject: string;
  let lines: string[];
  let link: string;
  let action: string;
  if (row.template === "reminder_submit") {
    subject = `Submit your timesheet for ${range}`;
    lines = [`Your week from ${range} is over. Check your time and submit it for approval.`];
    link = `${base}/my-timesheet`;
    action = "Open my timesheet";
  } else if (row.template === "reminder_approval") {
    subject = `${name}'s timesheet is waiting for your approval`;
    lines = [
      `${name} submitted the week from ${range} on ${when(p.submitted_at, zone)}. It is still waiting for you to approve or return it.`,
    ];
    link = review;
    action = `Review ${name}'s week`;
  } else {
    const manager = p.manager_name ? String(p.manager_name) : "Their manager";
    subject = `${name}'s timesheet has waited 5 days for approval`;
    lines = [
      `${name} submitted the week from ${range} on ${when(p.submitted_at, zone)}. ${manager} has not approved or returned it yet.`,
      "This is a notice only. Admins can't approve timesheets, so there is nothing to do except check with the manager.",
    ];
    link = review;
    action = `View ${name}'s week`;
  }

  const text = [greeting, "", ...lines, "", `${action}: ${link}`].join("\n");
  const html = [
    `<p>${escapeHtml(greeting)}</p>`,
    ...lines.map((l) => `<p>${escapeHtml(l)}</p>`),
    `<p><a href="${escapeHtml(link)}">${escapeHtml(action)}</a></p>`,
  ].join("\n");
  return { subject, text, html };
}

function render(row: OutboxRow, dashboardUrl: string): Message {
  if (row.template === "alert") return alertMessage(row, dashboardUrl);
  if (
    row.template === "reminder_submit" ||
    row.template === "reminder_approval" ||
    row.template === "reminder_escalation"
  ) {
    return reminderMessage(row, dashboardUrl);
  }
  throw new Error(`unknown template: ${row.template}`);
}

async function sendResend(apiKey: string, from: string, row: OutboxRow, m: Message): Promise<void> {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "Idempotency-Key": row.id,
    },
    body: JSON.stringify({
      from,
      to: [row.to_email],
      subject: m.subject,
      text: m.text,
      html: m.html,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`resend ${res.status}: ${(await res.text()).slice(0, 300)}`);
}

async function sendMailpit(
  baseUrl: string,
  from: string,
  row: OutboxRow,
  m: Message,
): Promise<void> {
  const match = from.match(/^\s*(?:"?([^"<]*?)"?\s*)?<([^>]+)>\s*$/);
  const res = await fetch(`${baseUrl.replace(/\/$/, "")}/api/v1/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      From: { Email: match ? match[2] : from, Name: match?.[1] ?? "" },
      To: [{ Email: row.to_email }],
      Subject: m.subject,
      Text: m.text,
      HTML: m.html,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`mailpit ${res.status}: ${(await res.text()).slice(0, 300)}`);
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return reply({ error: "method_not_allowed" }, 405);

  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const bearer = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (serviceKey === "" || !sameSecret(bearer, serviceKey)) {
    return reply({ error: "not_allowed" }, 401);
  }

  const resendKey = Deno.env.get("RESEND_API_KEY") ?? "";
  const from = Deno.env.get("EMAIL_FROM") ?? "AI Proctor <alerts@aiproctor.test>";
  if (resendKey !== "" && !Deno.env.get("EMAIL_FROM")) {
    return reply({ error: "email_from_not_set" }, 500);
  }
  const mailpitUrl = Deno.env.get("MAILPIT_URL") ?? "http://inbucket:8025";
  const dashboardUrl = Deno.env.get("DASHBOARD_URL") ?? "http://localhost:5173";

  const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", serviceKey, {
    auth: { persistSession: false },
  });
  const { data, error } = await admin.rpc("email_claim", { p_limit: MAX_BATCH });
  if (error) return reply({ error: "claim_failed", detail: error.message }, 500);

  const rows = (data ?? []) as OutboxRow[];
  let sent = 0;
  let failed = 0;
  for (const [i, row] of rows.entries()) {
    try {
      const message = render(row, dashboardUrl);
      if (resendKey !== "") {
        if (i > 0) await new Promise((r) => setTimeout(r, RESEND_SPACING_MS));
        await sendResend(resendKey, from, row, message);
      } else {
        await sendMailpit(mailpitUrl, from, row, message);
      }
      await admin.rpc("email_mark_sent", { p_id: row.id });
      sent++;
    } catch (e) {
      failed++;
      await admin.rpc("email_mark_failed", {
        p_id: row.id,
        p_error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return reply({ claimed: rows.length, sent, failed });
});
