// The employee's Unassigned time of a draft week (#139, PRJ-03/04): each stretch with a
// "Tag a project" action. Changing the project of a whole day is on the day's row of
// the week table. The database decides what is allowed (reassign_my_time).
import { DateTime } from "luxon";
import { Button } from "../../components/ui/button";
import { Time } from "../../lib/time";
import type { UnassignedSpan } from "./reassign";
import { formatDuration } from "./summary";

export function ProjectTime({
  spans,
  zone,
  loading,
  hasProjects,
  onTag,
}: {
  spans: UnassignedSpan[];
  zone: string;
  loading: boolean;
  /** The employee is assigned to at least one project. */
  hasProjects: boolean;
  onTag: (s: UnassignedSpan) => void;
}) {
  const total = spans.reduce((a, s) => a + s.seconds, 0);
  return (
    <section
      aria-labelledby="unassigned-title"
      className="overflow-hidden rounded-xl border border-line bg-panel"
    >
      <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1 border-b border-line px-5 py-4">
        <h2 id="unassigned-title" className="text-[15px] font-semibold">
          Unassigned time
        </h2>
        <span className="text-[12.5px] text-ink2">
          {loading
            ? "Loading…"
            : spans.length > 0
              ? `${formatDuration(total)} to tag to a project before you submit.`
              : "Everything this week has a project."}
        </span>
      </div>
      {!hasProjects && spans.length > 0 && (
        <p className="border-b border-line px-5 py-3 text-[13px] text-ink2">
          You aren't assigned to any project yet. Ask your manager to add you to one.
        </p>
      )}
      {spans.length > 0 && (
        <ul>
          {spans.map((s) => (
            <li
              key={s.startAt}
              className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line px-5 py-3 last:border-0"
            >
              <span className="font-mono text-[13px]">
                {DateTime.fromISO(s.startAt, { zone: "local" }).toFormat("ccc d")} ·{" "}
                <Time iso={s.startAt} employeeZone={zone} />–
                <Time iso={s.endAt} employeeZone={zone} />
              </span>
              <span className="text-[12.5px] text-ink2">
                {formatDuration(s.seconds)}
                {s.flagged && " · includes flagged time"}
              </span>
              <Button
                variant="secondary"
                className="ml-auto h-9"
                disabled={!hasProjects}
                onClick={() => onTag(s)}
              >
                Tag a project
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
