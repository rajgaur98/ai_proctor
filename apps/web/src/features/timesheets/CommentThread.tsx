// One comment thread on a week (#265, TS-33): on a row (project and task, Unassigned its own
// row) or on one manual entry. Self-contained so the weekly grid (TS-32) can host it in a row:
// it reads the week's comments itself (one shared read per week) and posts to its target. The
// employee and the people who review the week write; everyone else who can see it reads.
import { TimesheetComment } from "@ai-proctor/contracts";
import { DateTime } from "luxon";
import { useId, useState } from "react";
import { Button } from "../../components/ui/button";
import { useAddComment, useSheetComments } from "./commentData";
import { authorLabel, type CommentTarget, commentsFor, type SheetComment } from "./comments";

const areaClass = "w-full rounded-[9px] border border-line2 bg-panel p-3 text-sm text-ink";

export function CommentList({
  comments,
  viewerId,
}: {
  comments: SheetComment[];
  viewerId: string;
}) {
  return (
    <ul className="flex flex-col gap-2.5">
      {comments.map((c) => (
        <li key={c.id} className="flex flex-col gap-0.5">
          <p className="text-xs text-ink2">
            <span className="font-medium text-ink">{authorLabel(c, viewerId)}</span>
            {" · "}
            <time dateTime={c.createdAt}>
              {DateTime.fromISO(c.createdAt).toFormat("ccc d LLL, HH:mm")}
            </time>
          </p>
          <p className="text-[13px] whitespace-pre-line">{c.body}</p>
        </li>
      ))}
    </ul>
  );
}

export function CommentThread({
  timesheetId,
  target,
  viewerId,
  canPost,
  label,
  emptyText = "No comments yet.",
}: {
  timesheetId: string;
  target: CommentTarget;
  viewerId: string;
  /** The viewer is the employee or reviews the week (the database checks again). */
  canPost: boolean;
  /** What the thread is about, for the form's accessible name ("Website revamp · Design"). */
  label: string;
  emptyText?: string;
}) {
  const sheetComments = useSheetComments(timesheetId);
  const comments = commentsFor(sheetComments.data ?? [], target);
  const add = useAddComment(timesheetId, target);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [invalid, setInvalid] = useState<string | null>(null);
  const fieldId = useId();

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = TimesheetComment.safeParse(text);
    if (!parsed.success) {
      setInvalid(parsed.error.issues[0]?.message ?? "Write a comment");
      return;
    }
    setInvalid(null);
    add.mutate(parsed.data, {
      onSuccess: () => {
        setText("");
        setOpen(false);
      },
    });
  };

  return (
    <div className="flex flex-col gap-2.5">
      {sheetComments.isPending && timesheetId !== "" ? (
        <p className="text-xs text-ink3">Loading…</p>
      ) : sheetComments.error ? (
        <p role="alert" className="text-xs text-warnink">
          Couldn't load comments: {sheetComments.error.message}
        </p>
      ) : comments.length > 0 ? (
        <CommentList comments={comments} viewerId={viewerId} />
      ) : (
        <p className="text-xs text-ink3">{emptyText}</p>
      )}
      {canPost && !open && (
        <Button
          variant="secondary"
          className="h-8 self-start px-3 text-[12.5px]"
          aria-label={`${comments.length > 0 ? "Reply on" : "Comment on"} ${label}`}
          onClick={() => setOpen(true)}
        >
          {comments.length > 0 ? "Reply" : "Comment"}
        </Button>
      )}
      {canPost && open && (
        <form className="flex flex-col gap-2" onSubmit={submit} noValidate>
          <label htmlFor={fieldId} className="sr-only">
            Comment on {label}
          </label>
          <textarea
            id={fieldId}
            className={areaClass}
            rows={3}
            maxLength={2000}
            value={text}
            aria-invalid={invalid !== null}
            aria-describedby={invalid ? `${fieldId}-error` : undefined}
            onChange={(e) => setText(e.target.value)}
            // biome-ignore lint/a11y/noAutofocus: opened by the user's own click on Comment
            autoFocus
          />
          {(invalid || add.error) && (
            <p id={`${fieldId}-error`} role="alert" className="text-xs text-warnink">
              {invalid ?? add.error?.message}
            </p>
          )}
          <div className="flex gap-2">
            <Button
              type="button"
              variant="secondary"
              className="h-8 px-3 text-[12.5px]"
              onClick={() => {
                setOpen(false);
                setInvalid(null);
              }}
            >
              Cancel
            </Button>
            <Button type="submit" className="h-8 px-3 text-[12.5px]" disabled={add.isPending}>
              {add.isPending ? "Posting…" : "Post comment"}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}

/**
 * A manual entry's comments in the day list: a toggle with the count that opens the entry's
 * thread under it.
 */
export function EntryComments({
  timesheetId,
  entryId,
  viewerId,
  canPost,
  label,
}: {
  timesheetId: string;
  entryId: string;
  viewerId: string;
  canPost: boolean;
  /** The entry, for accessible names ("10:00–11:00 on Mon 2 Feb"). */
  label: string;
}) {
  const sheetComments = useSheetComments(timesheetId);
  const count = commentsFor(sheetComments.data ?? [], { kind: "entry", entryId }).length;
  const [open, setOpen] = useState(false);
  const regionId = useId();
  if (!canPost && count === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      <Button
        variant="secondary"
        className="h-8 self-start px-3 text-[12.5px]"
        aria-expanded={open}
        aria-controls={open ? regionId : undefined}
        aria-label={`Comments on ${label}${count > 0 ? ` (${count})` : ""}`}
        onClick={() => setOpen((o) => !o)}
      >
        {count > 0 ? `Comments (${count})` : "Comments"}
      </Button>
      {open && (
        <div id={regionId} className="border-l-2 border-line pl-3">
          <CommentThread
            timesheetId={timesheetId}
            target={{ kind: "entry", entryId }}
            viewerId={viewerId}
            canPost={canPost}
            label={label}
          />
        </div>
      )}
    </div>
  );
}
