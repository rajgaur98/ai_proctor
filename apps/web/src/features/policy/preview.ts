// "What employees see": the plain-language summary of the policy, next to the form. The
// published notice text is rendered by the database (internal.default_notice_body); this
// is the same facts in short rows, updated as the form changes.
import type { Policy } from "@ai-proctor/contracts";

export interface PreviewRow {
  label: string;
  text: string;
}

/** A number the admin is still typing may be blank or not a number. */
const n = (v: number | null): string => (v !== null && Number.isFinite(v) ? String(v) : "…");

export function noticePreview(p: Policy): PreviewRow[] {
  const interval =
    p.checkin_min_interval_min === p.checkin_max_interval_min
      ? `Every ${n(p.checkin_min_interval_min)} min`
      : `Every ${n(p.checkin_min_interval_min)} to ${n(p.checkin_max_interval_min)} min`;

  const images = [
    p.screenshots === "off"
      ? null
      : `a ${p.screenshots === "blurred" ? "blurred " : ""}screenshot of each screen`,
    p.webcam ? "one webcam frame" : null,
  ].filter((x): x is string => x !== null);
  const passed = images.length
    ? `${images.join(" and ").replace(/^./, (c) => c.toUpperCase())}.`
    : "Nothing but the time of the check-in.";

  const rows: PreviewRow[] = [
    {
      label: "Check-ins",
      text: `${interval} while clocked in, at random times. ${n(p.checkin_response_s)} s to respond.`,
    },
    { label: "On a passed check-in", text: passed },
    {
      label: "App activity",
      text: p.activity_sampling
        ? `App name and website (domain only), with the time spent in each${p.window_titles ? ", and window titles" : ""}.`
        : "Not recorded.",
    },
  ];
  if (p.excluded_apps.length > 0) {
    rows.push({
      label: "Excluded apps",
      text: `${p.excluded_apps.join(", ")}: never shown in screenshots, no window titles.`,
    });
  }
  rows.push(
    {
      label: "Never collected",
      text: "Anything on break, on pause or off shift, or on a missed check-in.",
    },
    {
      label: "Kept for",
      text: `${images.length ? `Images ${n(p.image_retention_days)} days. ` : ""}Time records with timesheets.`,
    },
    {
      label: "Breaks",
      text: `${p.breaks_paid ? "Paid" : "Unpaid"}${p.break_daily_max_min === null ? "" : `, up to ${n(p.break_daily_max_min)} min per day`}.`,
    },
    {
      label: "Pauses",
      text: `Up to ${n(p.pause_max_min)} min each, ${n(p.pause_daily_max_min)} min per day.`,
    },
  );
  return rows;
}
