// Timesheet status as colour + shape + label (NFR-UX-01), with when it happened.
import { DateTime } from "luxon";
import type { CSSProperties } from "react";
import { statusLabel, type Timesheet } from "./timesheetData";

const tone: Record<Timesheet["status"], string> = {
  draft: "border border-line bg-sunk text-ink2",
  submitted: "bg-accsoft text-acctext",
  approved: "border border-line bg-panel text-ink",
  returned: "border border-warnline bg-warnbg text-warnink",
};

const mark: Record<Timesheet["status"], CSSProperties> = {
  draft: { border: "1.5px dashed currentColor", borderRadius: "50%" },
  submitted: { background: "currentColor", borderRadius: "50%" },
  approved: { background: "var(--sactive)", borderRadius: 2 },
  returned: { background: "currentColor", transform: "rotate(45deg) scale(0.85)", borderRadius: 1 },
};

function when(sheet: Timesheet): string | null {
  const at =
    sheet.status === "submitted"
      ? sheet.submittedAt
      : sheet.status === "approved"
        ? sheet.approvedAt
        : sheet.status === "returned"
          ? sheet.returnedAt
          : null;
  return at ? DateTime.fromISO(at).toFormat("ccc d LLL, HH:mm") : null;
}

export function SheetStatusChip({
  sheet,
  withTime = false,
}: {
  sheet: Timesheet;
  withTime?: boolean;
}) {
  const at = withTime ? when(sheet) : null;
  return (
    <span
      className={`inline-flex h-[26px] items-center gap-[7px] rounded-full px-2.5 text-[12.5px] font-semibold ${tone[sheet.status]}`}
    >
      <span
        aria-hidden="true"
        className="block h-2 w-2 flex-none box-border"
        style={mark[sheet.status]}
      />
      {statusLabel[sheet.status]}
      {at ? ` · ${at}` : ""}
    </span>
  );
}

/** TS-18: "3 events since Tue 17 Mar, 09:00", for an approved week that got data after approval. */
export function lateDataSummary(sheet: Timesheet): string | null {
  if (sheet.status !== "approved" || sheet.lateDataCount <= 0 || !sheet.lateDataAt) return null;
  const n = sheet.lateDataCount;
  const since = DateTime.fromISO(sheet.lateDataAt).toFormat("ccc d LLL, HH:mm");
  return `${n} ${n === 1 ? "event" : "events"} since ${since}`;
}

/** Neutral badge in the Timesheets list: this approved week has data it doesn't include. */
export function LateDataBadge({ sheet }: { sheet: Timesheet }) {
  if (lateDataSummary(sheet) === null) return null;
  return (
    <span
      title="New data arrived after approval"
      className="inline-flex h-[26px] items-center rounded-full border border-line bg-sunk px-2.5 text-[12.5px] font-medium text-ink2"
    >
      New data
    </span>
  );
}
