// Flagged time of a week (#43, TS-02, DSH-06): the manager decides on each segment.
// Keep is a review decision; Exclude takes the time out of the worked total and
// needs a reason the employee sees (TS-13). Flagged time is never deducted unless
// the manager does so here.
import { TimesheetReason } from "@ai-proctor/contracts";
import { useMutation } from "@tanstack/react-query";
import { DateTime } from "luxon";
import { useId, useState } from "react";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { Time } from "../../lib/time";
import { missReason } from "../day/checkinText";
import { missesBySegment, type WeekMiss } from "./misses";
import { formatDuration } from "./summary";
import { editSegment, type FlaggedSegment, type SegmentEdit } from "./timesheetData";

const kindStyle: Record<string, { label: string; detail: string; color: string }> = {
  idle: { label: "Idle", detail: "No keyboard or mouse activity", color: "var(--sidle)" },
  unverified: {
    label: "Unverified",
    detail: "Missed or failed check-in, or capture blocked",
    color: "var(--saway)",
  },
  away: {
    label: "Away · locked",
    detail: "Screen locked or device asleep",
    color: "var(--slocked)",
  },
  offline: { label: "Offline", detail: "No signal while clocked in", color: "var(--soffline)" },
  pause_over_cap: {
    label: "Pause over the cap",
    detail: "Pause beyond the org's limit",
    color: "var(--spaused)",
  },
};

/** The design's hatch: flagged time is counted until the manager excludes it. */
const hatch = (c: string) =>
  `repeating-linear-gradient(135deg, ${c} 0 3px, color-mix(in oklch, ${c} 35%, var(--panel)) 3px 6px)`;

export function FlaggedSegments({
  timesheetId,
  employeeName,
  zone,
  segments,
  misses,
  projectName,
  editable,
  onChanged,
  onChangeProject,
}: {
  timesheetId: string;
  employeeName: string;
  zone: string;
  segments: FlaggedSegment[];
  /** The week's missed check-ins with the employee's reason (#252). */
  misses: WeekMiss[];
  projectName: (id: string | null) => string;
  /** The viewer decides and the week isn't approved. */
  editable: boolean;
  onChanged: () => void;
  onChangeProject: (s: FlaggedSegment) => void;
}) {
  const { bySegment, other } = missesBySegment(segments, misses);
  return (
    <section
      aria-labelledby="flagged-title"
      className="overflow-hidden rounded-xl border border-line bg-panel"
    >
      <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1 border-b border-line px-5 py-4">
        <h2 id="flagged-title" className="text-[15px] font-semibold">
          Flagged segments
        </h2>
        <span className="text-[12.5px] text-ink2">Excluded edits are shown to the employee.</span>
      </div>
      {segments.length === 0 ? (
        <p className="px-5 py-4 text-sm text-ink2">Nothing was flagged this week.</p>
      ) : (
        <ul>
          {segments.map((s) => (
            <FlaggedRow
              key={s.id}
              timesheetId={timesheetId}
              employeeName={employeeName}
              zone={zone}
              segment={s}
              misses={bySegment.get(s.id) ?? []}
              project={projectName(s.projectId)}
              editable={editable}
              onChanged={onChanged}
              onChangeProject={() => onChangeProject(s)}
            />
          ))}
        </ul>
      )}
      {other.length > 0 && (
        <div className="flex flex-col gap-1.5 border-t border-line px-5 py-4">
          <span className="text-[12.5px] font-medium">Other missed check-ins</span>
          <MissList misses={other} zone={zone} />
        </div>
      )}
    </section>
  );
}

/**
 * Each miss with the employee's quick pick and remark, or that none was given. Plain
 * lines, not a nested list: the segments are the list items of this section.
 */
function MissList({ misses, zone }: { misses: WeekMiss[]; zone: string }) {
  return (
    <div className="flex flex-col gap-1">
      {misses.map((m) => {
        const { kind, note } = missReason(m.kind, m.remark);
        return (
          <p key={m.id} className="text-[12.5px] text-ink2">
            <span className="font-mono">
              {DateTime.fromISO(m.at, { zone: "local" }).toFormat("ccc d")} ·{" "}
              <Time iso={m.at} employeeZone={zone} />
            </span>{" "}
            Missed check-in ·{" "}
            {kind || note ? (
              <>
                <span className="font-medium text-ink">{kind ?? "Remark"}</span>
                {note && <span className="break-words whitespace-pre-line">: “{note}”</span>}
              </>
            ) : (
              "no reason given"
            )}
          </p>
        );
      })}
    </div>
  );
}

function FlaggedRow({
  timesheetId,
  employeeName,
  zone,
  segment: s,
  misses,
  project,
  editable,
  onChanged,
  onChangeProject,
}: {
  timesheetId: string;
  employeeName: string;
  zone: string;
  segment: FlaggedSegment;
  misses: WeekMiss[];
  project: string;
  editable: boolean;
  onChanged: () => void;
  onChangeProject: () => void;
}) {
  const reasonId = useId();
  // The decision being written: excluding, or putting excluded time back. Both need a reason.
  const [asking, setAsking] = useState<"exclude" | "include" | null>(null);
  const [reason, setReason] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const edit = useMutation({
    mutationFn: (e: Omit<SegmentEdit, "timesheetId" | "startAt" | "endAt">) =>
      editSegment({ ...e, timesheetId, startAt: s.startAt, endAt: s.endAt }),
    onSuccess: () => {
      setAsking(null);
      setReason("");
      onChanged();
    },
  });
  const style = kindStyle[s.type] ?? { label: s.type, detail: "", color: "var(--soffline)" };
  const seconds = (Date.parse(s.endAt) - Date.parse(s.startAt)) / 1000;
  const day = DateTime.fromISO(s.startAt, { zone: "local" }).toFormat("ccc d");
  const excluded = s.decision === "exclude";

  function choose(kind: "keep" | "exclude") {
    setProblem(null);
    edit.reset();
    if (kind === "exclude") {
      if (!excluded) setAsking("exclude");
    } else if (excluded) {
      setAsking("include");
    } else if (s.decision !== "keep") {
      setAsking(null);
      edit.mutate({ kind: "keep" });
    }
  }

  function save() {
    setProblem(null);
    const parsed = TimesheetReason.safeParse(reason);
    if (!parsed.success) {
      setProblem(parsed.error.issues[0]?.message ?? "Give a reason.");
      return;
    }
    if (asking) edit.mutate({ kind: asking, reason: parsed.data });
  }

  const seg = (on: boolean) =>
    `h-11 px-4 text-[13.5px] font-medium disabled:opacity-45 ${on ? "bg-ink text-panel" : "bg-panel text-ink"}`;

  return (
    <li className="flex flex-col gap-3 border-b border-line px-5 py-4 last:border-0">
      <div className="flex flex-wrap items-center gap-4">
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
            <span className="font-mono text-[13px]">
              {day} · <Time iso={s.startAt} employeeZone={zone} />–
              <Time iso={s.endAt} employeeZone={zone} />
            </span>
            <span className="inline-flex items-center gap-1.5 text-[12.5px] font-medium whitespace-nowrap">
              <span
                aria-hidden
                className="block h-2.5 w-3.5 rounded-sm"
                style={{ background: hatch(style.color) }}
              />
              {style.label} · {formatDuration(seconds)}
            </span>
          </div>
          <span className="text-[12.5px] text-ink2">
            {project} · {style.detail}
          </span>
          {excluded && s.excludedReason && (
            <span className="text-[12.5px] text-ink2">Excluded: {s.excludedReason}</span>
          )}
          {misses.length > 0 && <MissList misses={misses} zone={zone} />}
        </div>
        {editable && (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="secondary"
              className="h-9"
              disabled={edit.isPending}
              onClick={onChangeProject}
            >
              Change project
            </Button>
            <fieldset className="m-0 flex min-w-0 overflow-hidden rounded-[9px] border border-line2 p-0">
              <legend className="sr-only">Decision for the {style.label} segment</legend>
              <button
                type="button"
                aria-pressed={s.decision === "keep"}
                disabled={edit.isPending}
                onClick={() => choose("keep")}
                className={seg(s.decision === "keep")}
              >
                Keep
              </button>
              <button
                type="button"
                aria-pressed={excluded}
                disabled={edit.isPending}
                onClick={() => choose("exclude")}
                className={`${seg(excluded)} border-l border-line2`}
              >
                Exclude
              </button>
            </fieldset>
          </div>
        )}
      </div>
      {asking && (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={reasonId} className="text-xs">
            {asking === "exclude" ? "Reason for excluding" : "Reason for putting it back"}{" "}
            <span className="font-normal text-ink3">
              (required, shown to {employeeName.split(" ")[0]})
            </span>
          </Label>
          <div className="flex flex-wrap gap-2">
            <Input
              id={reasonId}
              value={reason}
              maxLength={500}
              placeholder="e.g. Idle before lunch, not work time"
              onChange={(e) => setReason(e.target.value)}
              className="min-w-0 flex-1"
            />
            <Button disabled={edit.isPending} onClick={save}>
              {asking === "exclude" ? "Save exclusion" : "Put back"}
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                setAsking(null);
                setProblem(null);
                setReason("");
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
      {(problem || edit.error) && (
        <p role="alert" className="text-sm text-warnink">
          {problem ?? edit.error?.message}
        </p>
      )}
    </li>
  );
}
