// NFR-UX-03: every time is shown in the viewer's time zone, with the employee's
// own zone available on hover.
import { DateTime } from "luxon";

export function viewerZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** "14:03" in `zone`, plus the zone abbreviation when it isn't the viewer's. */
export function formatTime(iso: string, zone: string, viewer = viewerZone()): string {
  const t = DateTime.fromISO(iso, { zone });
  const text = t.toFormat("HH:mm");
  return zone === viewer ? text : `${text} ${t.toFormat("ZZZZ")}`;
}

/** Tooltip text: the same instant in the employee's zone, labelled. */
export function employeeZoneTitle(iso: string, employeeZone: string): string {
  const t = DateTime.fromISO(iso, { zone: employeeZone });
  return `${t.toFormat("ccc d LLL, HH:mm")} ${t.toFormat("ZZZZ")} (employee's time, ${employeeZone})`;
}

export function Time({ iso, employeeZone }: { iso: string; employeeZone?: string | undefined }) {
  const viewer = viewerZone();
  return (
    <time
      dateTime={iso}
      className="font-mono text-[12.5px]"
      title={employeeZone ? employeeZoneTitle(iso, employeeZone) : undefined}
    >
      {formatTime(iso, viewer, viewer)}
    </time>
  );
}
