// Side panels of the timesheet page (#43): the week's manual entry requests with
// the manager's decision (reusing #42's decide RPC), and the manager's edits with
// their reasons, which the employee sees (TS-13), and the employee's own project
// changes on a draft week (#139, PRJ-04).
import { useMutation } from "@tanstack/react-query";
import { DateTime } from "luxon";
import { useId, useState } from "react";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { Time } from "../../lib/time";
import { decideEntry, type EntryStatus, type ManualEntry } from "../day/entryData";
import { formatDuration } from "./summary";
import type { SheetEdit } from "./timesheetData";

const entryStatus: Record<EntryStatus, { label: string; className: string }> = {
  pending: { label: "Pending", className: "text-warnink" },
  approved: { label: "Approved", className: "text-ink2" },
  rejected: { label: "Rejected", className: "text-ink2" },
};

export function WeekEntries({
  entries,
  zone,
  employeeName,
  projectName,
  canDecide,
  canAdjust,
  onChanged,
  onAdd,
  onAdjust,
}: {
  entries: ManualEntry[];
  zone: string;
  employeeName: string;
  projectName: (id: string | null) => string;
  /** The viewer is the direct manager or delegate. */
  canDecide: boolean;
  /** …and the week isn't approved. */
  canAdjust: boolean;
  onChanged: () => void;
  onAdd: () => void;
  onAdjust: (e: ManualEntry) => void;
}) {
  return (
    <section
      aria-labelledby="week-entries-title"
      className="flex flex-col gap-4 rounded-xl border border-line bg-panel p-[18px]"
    >
      <div className="flex items-center gap-2">
        <h2 id="week-entries-title" className="text-[15px] font-semibold">
          Manual entry requests
        </h2>
        {canAdjust && (
          <Button variant="secondary" className="ml-auto h-9" onClick={onAdd}>
            Add time
          </Button>
        )}
      </div>
      {entries.length === 0 ? (
        <p className="text-[13px] text-ink2">No manual entries this week.</p>
      ) : (
        <ul className="flex flex-col gap-4">
          {entries.map((e) => (
            <EntryCard
              key={e.id}
              entry={e}
              zone={zone}
              employeeName={employeeName}
              project={projectName(e.projectId)}
              canDecide={canDecide && e.status === "pending"}
              canAdjust={canAdjust && e.status !== "rejected"}
              onChanged={onChanged}
              onAdjust={() => onAdjust(e)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function EntryCard({
  entry: e,
  zone,
  employeeName,
  project,
  canDecide,
  canAdjust,
  onChanged,
  onAdjust,
}: {
  entry: ManualEntry;
  zone: string;
  employeeName: string;
  project: string;
  canDecide: boolean;
  canAdjust: boolean;
  onChanged: () => void;
  onAdjust: () => void;
}) {
  const noteId = useId();
  const [note, setNote] = useState("");
  const decide = useMutation({
    mutationFn: (approve: boolean) => decideEntry(e.id, approve, note),
    onSuccess: onChanged,
  });
  const { label, className } = entryStatus[e.status];
  const seconds = (Date.parse(e.endAt) - Date.parse(e.startAt)) / 1000;

  return (
    <li className="flex flex-col gap-3 border-b border-line pb-4 last:border-0 last:pb-0">
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <span className="font-mono text-[13px] text-ink2">
            {DateTime.fromISO(e.startAt, { zone: "local" }).toFormat("ccc d")} ·{" "}
            <Time iso={e.startAt} employeeZone={zone} />–<Time iso={e.endAt} employeeZone={zone} />{" "}
            · {formatDuration(seconds)}
          </span>
          <span className={`ml-auto text-xs font-medium ${className}`}>{label}</span>
        </div>
        <span className="text-[13px] text-ink2">{project}</span>
      </div>
      <p className="rounded-lg bg-sunk px-3 py-2.5 text-[13px] leading-[1.45] text-ink2">
        “{e.reason}” — {employeeName.split(" ")[0]}
      </p>
      {e.decisionNote && <p className="text-[12.5px] text-ink3">Note: {e.decisionNote}</p>}
      {canDecide && (
        <div className="flex flex-col gap-2">
          <Label htmlFor={noteId} className="sr-only">
            Note for the decision (optional)
          </Label>
          <Input
            id={noteId}
            value={note}
            maxLength={500}
            placeholder="Note (optional)"
            onChange={(ev) => setNote(ev.target.value)}
            className="h-9"
          />
          <div className="grid grid-cols-2 gap-2">
            <Button
              variant="secondary"
              disabled={decide.isPending}
              onClick={() => decide.mutate(false)}
            >
              Reject
            </Button>
            <Button disabled={decide.isPending} onClick={() => decide.mutate(true)}>
              Approve
            </Button>
          </div>
        </div>
      )}
      {canAdjust && (
        <Button variant="secondary" className="h-9 self-start" onClick={onAdjust}>
          Adjust
        </Button>
      )}
      {decide.error && (
        <p role="alert" className="text-sm text-warnink">
          {decide.error.message}
        </p>
      )}
    </li>
  );
}

const editTitle: Record<SheetEdit["kind"], string> = {
  keep: "Kept",
  exclude: "Excluded flagged time",
  include: "Put excluded time back",
  project: "Changed project",
  adjust: "Added or adjusted time",
  employee_project: "Employee changed project",
};

export function EditsList({
  edits,
  zone,
  editorName,
  projectName,
  heading,
  viewerIsEmployee = false,
}: {
  edits: SheetEdit[];
  zone: string;
  editorName: (id: string | null) => string;
  projectName: (id: string | null) => string;
  heading: string;
  /** The viewer is the person the week is about: their own edits read "You …". */
  viewerIsEmployee?: boolean;
}) {
  return (
    <section
      aria-labelledby="edits-title"
      className="flex flex-col gap-3 rounded-xl border border-line bg-panel p-[18px]"
    >
      <h2 id="edits-title" className="text-[15px] font-semibold">
        {heading}
      </h2>
      {edits.length === 0 ? (
        <p className="text-[13px] text-ink2">No edits this week.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {edits.map((e) => (
            <li
              key={e.id}
              className="flex flex-col gap-1 border-b border-line pb-3 text-[13px] last:border-0 last:pb-0"
            >
              <span className="font-medium">
                {e.kind === "employee_project" && viewerIsEmployee
                  ? "You changed project"
                  : editTitle[e.kind]}
                {(e.kind === "project" || e.kind === "employee_project") &&
                  ` to ${projectName(e.projectId)}`}
              </span>
              <span className="font-mono text-[12.5px] text-ink2">
                {DateTime.fromISO(e.startAt, { zone: "local" }).toFormat("ccc d")} ·{" "}
                <Time iso={e.startAt} employeeZone={zone} />–
                <Time iso={e.endAt} employeeZone={zone} />
              </span>
              {e.reason && <span className="text-ink2">Reason: {e.reason}</span>}
              <span className="text-xs text-ink3">
                {editorName(e.editorId)} ·{" "}
                {DateTime.fromISO(e.createdAt).toFormat("ccc d LLL, HH:mm")}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
