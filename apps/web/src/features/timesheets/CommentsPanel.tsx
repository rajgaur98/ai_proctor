// The week's comments grouped by row (#265, TS-33): every row the week has time on (project and
// task, Unassigned its own row) and any other row with comments, each with its thread, then the
// threads on that row's manual entries. Comments stay after approval and may still be written.
import { formatTime, viewerZone } from "../../lib/time";
import type { ManualEntry } from "../day/entryData";
import { CommentList, CommentThread } from "./CommentThread";
import { useSheetComments } from "./commentData";
import { commentRows, rowCommentCount, rowKey } from "./comments";
import { localDay } from "./dayList";
import { dayLabel } from "./weeks";

/** "10:00–11:00 on Mon 2 Feb": times in the viewer's zone like the page, the employee's day. */
function entryLabel(e: ManualEntry, zone: string): string {
  const viewer = viewerZone();
  return `${formatTime(e.startAt, viewer)}–${formatTime(e.endAt, viewer)} on ${dayLabel(localDay(e.startAt, zone))}`;
}

export function CommentsPanel({
  timesheetId,
  viewerId,
  canPost,
  rows,
  entries,
  zone,
  assignment,
}: {
  timesheetId: string;
  viewerId: string;
  /** The viewer is the employee or reviews the week. */
  canPost: boolean;
  /** The rows the week has time on, in the order the page shows them. */
  rows: { projectId: string | null; taskId: string | null }[];
  entries: ManualEntry[];
  /** The employee's zone: the day an entry is on. */
  zone: string;
  /** "Website revamp · Design", or "Unassigned". */
  assignment: (projectId: string | null, taskId: string | null) => string;
}) {
  const comments = useSheetComments(timesheetId);
  const grouped = commentRows(comments.data ?? [], rows, entries);
  const total = (comments.data ?? []).length;

  return (
    <section
      aria-labelledby="comments-title"
      className="flex flex-col gap-4 rounded-xl border border-line bg-panel p-[18px]"
    >
      <div className="flex flex-col gap-1">
        <h2 id="comments-title" className="text-[15px] font-semibold">
          Comments{total > 0 ? ` (${total})` : ""}
        </h2>
        <p className="text-[13px] text-ink2">
          On each project and task of the week, and on manual entries. Comments stay after approval.
        </p>
      </div>
      {comments.error && (
        <p role="alert" className="text-sm text-warnink">
          Couldn't load comments: {comments.error.message}
        </p>
      )}
      {grouped.length === 0 && !comments.isPending && (
        <p className="text-[13px] text-ink3">No time or comments this week.</p>
      )}
      {grouped.map((row) => {
        const name = assignment(row.projectId, row.taskId);
        const key = rowKey(row.projectId, row.taskId);
        const count = rowCommentCount(row);
        return (
          <section
            key={key}
            aria-label={name}
            className="flex flex-col gap-2.5 border-t border-line pt-3"
          >
            <h3 className="text-[13.5px] font-semibold">
              {name}
              {count > 0 && <span className="font-normal text-ink2"> · {count}</span>}
            </h3>
            <CommentThread
              timesheetId={timesheetId}
              target={{ kind: "row", projectId: row.projectId, taskId: row.taskId }}
              viewerId={viewerId}
              canPost={canPost}
              label={name}
            />
            {row.entries.map((t) =>
              t.entry ? (
                <div key={t.entry.id} className="flex flex-col gap-2 border-l-2 border-line pl-3">
                  <h4 className="text-xs font-medium text-ink2">
                    On the entry {entryLabel(t.entry, zone)}
                  </h4>
                  <CommentThread
                    timesheetId={timesheetId}
                    target={{ kind: "entry", entryId: t.entry.id }}
                    viewerId={viewerId}
                    canPost={canPost}
                    label={`the entry ${entryLabel(t.entry, zone)}`}
                  />
                </div>
              ) : (
                <div
                  key={`gone-${t.comments[0]?.id ?? ""}`}
                  className="flex flex-col gap-2 border-l-2 border-line pl-3"
                >
                  <h4 className="text-xs font-medium text-ink2">
                    On an entry that's no longer in this week
                  </h4>
                  <CommentList comments={t.comments} viewerId={viewerId} />
                </div>
              ),
            )}
          </section>
        );
      })}
    </section>
  );
}
