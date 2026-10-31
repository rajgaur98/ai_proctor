// The selected check-in (#124, DSH-04/05, from the Claude Design DayView screen): for a
// pass the captures with Shown / Answered in / Active app / Project and the note that
// the view is logged; for a miss the facts around it, the employee's reason and a link
// to the timesheet. Deferred and failed check-ins get the same panel with what we know.
//
// Captures stay behind "View captures": opening them is an audit-logged view (AUD-01,
// EMP-03), so selecting a row or marker must not open one by itself.
import { Link } from "@tanstack/react-router";
import { DateTime } from "luxon";
import { type ReactNode, useState } from "react";
import { formatTime, Time, viewerZone } from "../../lib/time";
import { CaptureImages, DisplaySwitch, screenFiles, useCaptureView } from "./CaptureViewer";
import {
  deferralText,
  minutesText,
  missReason,
  noFace,
  outcomeWord,
  screenState,
  secondsText,
} from "./checkinText";
import { Marker } from "./DayTimeline";
import type { CheckinRow } from "./dayData";
import { NeedsReviewBadge, NoFaceBadge } from "./NeedsReview";
import { removedText } from "./removedText";

function title(c: CheckinRow, at: string): string {
  if (c.outcome === "miss") return `Missed check-in · ${at}`;
  if (c.outcome === "deferred") return `Deferred check-in · ${at}`;
  return `Check-in · ${at}`;
}

function chip(c: CheckinRow): string {
  if (c.outcome === "pass" && c.responseMs !== null) {
    return `${outcomeWord.pass} · ${secondsText(c.responseMs)}`;
  }
  return outcomeWord[c.outcome];
}

function Cell({
  label,
  children,
  className = "",
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={className}>
      <div className="text-xs text-ink3">{label}</div>
      <div className="mt-[3px]">{children}</div>
    </div>
  );
}

/** Bordered 2-column facts, as the design's miss details. */
function Facts({ cells }: { cells: { label: string; value: ReactNode }[] }) {
  return (
    <dl className="grid grid-cols-1 overflow-hidden rounded-[10px] border border-line text-[13.5px] sm:grid-cols-2">
      {cells.map(({ label, value }, i) => (
        <div
          key={label}
          className={`px-3.5 py-3 ${i > 0 ? "border-t border-line" : ""} ${i === 1 ? "sm:border-t-0" : ""} ${i % 2 === 1 ? "sm:border-l sm:border-line" : ""}`}
        >
          <dt className="text-xs text-ink3">{label}</dt>
          <dd className="mt-[3px]">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function CheckinDetails({
  c,
  zone,
  needsReview,
  projectName,
  responseWindowS,
  userId,
  week,
  isSelf,
  personName,
}: {
  c: CheckinRow;
  zone: string;
  needsReview: boolean;
  /** The check-in's project, already named. */
  projectName: string;
  responseWindowS: number;
  userId: string;
  /** The timesheet week the day falls in. */
  week: string;
  isSelf: boolean;
  personName: string;
}) {
  const [opened, setOpened] = useState(false);
  const [display, setDisplay] = useState(0);
  const view = useCaptureView(c.id, opened);
  const viewer = viewerZone();
  const at = formatTime(c.shownAt ?? c.scheduledAt, viewer, viewer);
  const screens = view.data ? screenFiles(view.data.files) : [];
  const shownTime = c.shownAt ? <Time iso={c.shownAt} employeeZone={zone} seconds /> : "—";
  // #253: parts the employee removed. Not a flag: the check-in still passed.
  const removedBy = isSelf ? "you" : personName;
  const removedNote = removedText(c.removed, removedBy, viewer);
  const filesLeft = c.objectKeys.some((k) =>
    k === "webcam.webp" ? c.removed.webcam === null : c.removed.screen === null,
  );

  const timesheetLink = (
    <Link
      to="/timesheets/$userId"
      params={{ userId }}
      search={{ week }}
      className="ml-auto font-medium text-acctext"
    >
      Review in timesheet →
    </Link>
  );

  return (
    <section
      aria-labelledby="checkin-title"
      className="flex flex-col gap-4 rounded-xl border border-line bg-panel p-5"
    >
      <div className="flex flex-wrap items-center gap-2.5">
        <h2 id="checkin-title" className="text-[17px] font-semibold tracking-[-0.015em]">
          {title(c, at)}
        </h2>
        <span className="inline-flex h-[26px] items-center gap-[7px] rounded-full border border-line pr-2.5 pl-[9px] text-[12.5px] font-medium">
          <Marker outcome={c.outcome} size={9} />
          {chip(c)}
        </span>
        {needsReview && <NeedsReviewBadge />}
        {noFace(c) && <NoFaceBadge />}
        {c.outcome === "pass" && opened && screens.length > 1 && (
          <DisplaySwitch names={screens.map((s) => s.name)} value={display} onChange={setDisplay} />
        )}
      </div>

      {c.outcome === "pass" && (
        <>
          <CaptureImages
            keys={c.objectKeys}
            opened={opened}
            onOpen={() => setOpened(true)}
            view={view}
            display={display}
            removed={c.removed}
            removedBy={removedBy}
          />
          {removedNote && (
            <p className="rounded-[9px] border border-line bg-sunk px-3 py-2.5 text-[13px] text-ink2">
              <span className="font-semibold text-ink">{removedNote}.</span> The check-in still
              counts as passed and its time is unchanged.
            </p>
          )}
          <div className="grid grid-cols-2 gap-3 text-[13px] sm:grid-cols-4">
            <Cell label="Shown">{shownTime}</Cell>
            <Cell label="Answered in">
              <span className="font-mono">
                {c.responseMs !== null ? secondsText(c.responseMs) : "—"}
              </span>
            </Cell>
            <Cell label="Active app">
              <span className="font-medium">
                {c.removed.apps !== null
                  ? `Removed by ${removedBy}`
                  : !opened
                    ? "Shown with the captures"
                    : view.data
                      ? view.data.app
                        ? `${view.data.app}${view.data.domain ? ` (${view.data.domain})` : ""}`
                        : "Not recorded"
                      : "…"}
              </span>
            </Cell>
            <Cell label="Project">
              <span className="font-medium">{projectName}</span>
            </Cell>
          </div>
          {noFace(c) && (
            <p className="rounded-[9px] border border-warnline bg-warnbg px-3 py-2.5 text-[13px] text-warnink">
              <span className="font-semibold">No face detected in the webcam frame.</span> Needs
              review: they may have stepped away, or the camera was covered or pointed elsewhere.
              The check-in still passed. Detection runs on their computer and never identifies
              anyone.
            </p>
          )}
          {c.wrongClicks > 0 && (
            <p className="text-[13px] text-ink2">
              {c.wrongClicks} wrong {c.wrongClicks === 1 ? "click" : "clicks"} before the right one.
            </p>
          )}
          {filesLeft && (
            <p className="flex items-center gap-2.5 rounded-[9px] bg-accsoft px-3 py-2.5 text-[13px]">
              <span
                aria-hidden
                className="flex h-4 w-4 flex-none items-center justify-center rounded-full border-[1.5px] border-acctext text-[10px] font-bold text-acctext"
              >
                i
              </span>
              <span>
                {isSelf ? (
                  <>
                    <span className="font-semibold">Every view of your captures is logged.</span>{" "}
                    You see who opened each capture and when.
                  </>
                ) : (
                  <>
                    <span className="font-semibold">
                      Your view is logged and visible to {personName}.
                    </span>{" "}
                    They see who opened each capture and when.
                  </>
                )}
                {opened && " Links expire in 5 minutes."}
              </span>
            </p>
          )}
        </>
      )}

      {c.outcome === "miss" && (
        <>
          <Facts
            cells={[
              { label: "Shown", value: shownTime },
              { label: "Response window", value: `${responseWindowS} s · no answer` },
              {
                label: "Idle before check-in",
                value:
                  c.idleSAtShow === null ? (
                    "—"
                  ) : (
                    <>
                      <span className="font-mono">
                        {minutesText(Math.round(c.idleSAtShow / 60))}
                      </span>
                      {c.shownAt && (
                        <span className="text-ink2">
                          {" · since "}
                          {DateTime.fromISO(c.shownAt, { zone: viewer })
                            .minus({ seconds: c.idleSAtShow })
                            .toFormat("HH:mm")}
                        </span>
                      )}
                    </>
                  ),
              },
              { label: "Screen", value: screenState(c.deviceState) },
            ]}
          />
          <MissReason c={c} personName={personName} />
          <p className="flex flex-wrap items-center gap-3 text-[13px] text-ink2">
            <span>
              No captures: screenshots and webcam frames are only taken when a check-in is passed.
            </span>
            {timesheetLink}
          </p>
        </>
      )}

      {c.outcome === "failed" && (
        <>
          <Facts
            cells={[
              { label: "Shown", value: shownTime },
              {
                label: "Response time",
                value: c.responseMs !== null ? secondsText(c.responseMs) : "—",
              },
              { label: "Wrong clicks", value: String(c.wrongClicks) },
              { label: "Screen", value: screenState(c.deviceState) },
            ]}
          />
          <p className="flex flex-wrap items-center gap-3 text-[13px] text-ink2">
            <span>
              Two wrong clicks fail the challenge. No screenshot or webcam frame is taken.
            </span>
            {timesheetLink}
          </p>
        </>
      )}

      {c.outcome === "deferred" && (
        <>
          <Facts
            cells={[
              { label: "Due", value: <Time iso={c.scheduledAt} employeeZone={zone} seconds /> },
              { label: "Reason", value: deferralText(c.deferralReason) },
            ]}
          />
          <p className="text-[13px] text-ink2">
            Not shown. The check-in comes once it ends, and this is not counted as missed.
          </p>
        </>
      )}
    </section>
  );
}

function MissReason({ c, personName }: { c: CheckinRow; personName: string }) {
  const { kind, note } = missReason(c.missedReasonKind, c.missedReason);
  return (
    <div className="flex flex-col gap-1.5 rounded-[10px] border border-line bg-sunk p-3.5">
      <span className="text-xs text-ink3">Employee's reason{kind && note ? ` · ${kind}` : ""}</span>
      {note || kind ? (
        <span className="text-base font-medium">{note ? `“${note}”` : kind}</span>
      ) : (
        <span className="text-[13.5px] text-ink2">No reason given yet by {personName}.</span>
      )}
    </div>
  );
}
