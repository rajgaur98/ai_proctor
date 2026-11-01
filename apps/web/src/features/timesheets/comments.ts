// Comments on a week (#265, TS-33): on a row of the week (a project and task, Unassigned its
// own row, as in the weekly grid of TS-32) or on one manual entry. The grouping here is pure;
// commentData.ts reads and writes them.
import { assignmentKey } from "./summary";

export interface SheetComment {
  id: string;
  timesheetId: string;
  /** Whose week it is. */
  userId: string;
  target: "row" | "entry";
  /** The row; for an entry comment, the entry's project and task when it was written. */
  projectId: string | null;
  taskId: string | null;
  /** Null for a row comment, and once the entry is gone (cancelled or merged away). */
  manualEntryId: string | null;
  /** Null once the author's account is deleted; the name stays as it was written. */
  authorId: string | null;
  authorName: string | null;
  body: string;
  createdAt: string;
}

/** What a thread is about: a row of the week, or one manual entry. */
export type CommentTarget =
  | { kind: "row"; projectId: string | null; taskId: string | null }
  | { kind: "entry"; entryId: string };

/** A row's key, the same one the week's totals use (a task only ever with its project). */
export function rowKey(projectId: string | null, taskId: string | null): string {
  return assignmentKey(projectId, projectId === null ? null : taskId);
}

const byTime = (a: SheetComment, b: SheetComment) =>
  a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);

/** The comments of one thread, oldest first. */
export function commentsFor(comments: SheetComment[], target: CommentTarget): SheetComment[] {
  return comments
    .filter((c) =>
      target.kind === "entry"
        ? c.target === "entry" && c.manualEntryId === target.entryId
        : c.target === "row" &&
          rowKey(c.projectId, c.taskId) === rowKey(target.projectId, target.taskId),
    )
    .sort(byTime);
}

/** The entry a group of entry comments is on; null for comments whose entry is gone. */
export interface EntryThread<E> {
  entry: E | null;
  comments: SheetComment[];
}

export interface CommentRow<E> {
  projectId: string | null;
  taskId: string | null;
  /** Comments on the row itself, oldest first. */
  comments: SheetComment[];
  /** Entries of the row that have comments, in time order; removed entries last. */
  entries: EntryThread<E>[];
}

interface EntryLike {
  id: string;
  startAt: string;
  projectId: string | null;
  taskId: string | null;
}

/**
 * The week's comments grouped by row, for the Comments panel. `rows` are the rows the week has
 * time on, in the order shown; rows that only have comments follow, oldest comment first. An
 * entry comment sits under the row its entry is on now (or was on, once the entry is gone).
 */
export function commentRows<E extends EntryLike>(
  comments: SheetComment[],
  rows: { projectId: string | null; taskId: string | null }[],
  entries: E[],
): CommentRow<E>[] {
  const out = new Map<string, CommentRow<E>>();
  const rowOf = (projectId: string | null, taskId: string | null) => {
    const key = rowKey(projectId, taskId);
    let row = out.get(key);
    if (!row) {
      row = { projectId, taskId: projectId === null ? null : taskId, comments: [], entries: [] };
      out.set(key, row);
    }
    return row;
  };
  for (const r of rows) rowOf(r.projectId, r.taskId);

  const entryById = new Map(entries.map((e) => [e.id, e]));
  const threads = new Map<string, EntryThread<E>>();
  for (const c of [...comments].sort(byTime)) {
    if (c.target === "row") {
      rowOf(c.projectId, c.taskId).comments.push(c);
      continue;
    }
    const entry = c.manualEntryId ? (entryById.get(c.manualEntryId) ?? null) : null;
    const row = entry ? rowOf(entry.projectId, entry.taskId) : rowOf(c.projectId, c.taskId);
    const key = `${rowKey(row.projectId, row.taskId)}\u0000${entry?.id ?? c.manualEntryId ?? ""}`;
    let thread = threads.get(key);
    if (!thread) {
      thread = { entry, comments: [] };
      threads.set(key, thread);
      row.entries.push(thread);
    }
    thread.comments.push(c);
  }
  for (const row of out.values()) {
    row.entries.sort((a, b) =>
      a.entry && b.entry
        ? a.entry.startAt.localeCompare(b.entry.startAt)
        : Number(a.entry === null) - Number(b.entry === null),
    );
  }
  return [...out.values()];
}

/**
 * How many comments each row's own thread has, by `rowKey`: the count on the grid's row
 * comment button (#299). Entry comments aren't counted; they show on the entry, in its cell.
 */
export function rowThreadCounts(comments: SheetComment[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const c of comments) {
    if (c.target !== "row") continue;
    const key = rowKey(c.projectId, c.taskId);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/** The row comment button's accessible name: "Comments on Website revamp · Design, 2". */
export function rowCommentsName(row: string, count: number): string {
  return `Comments on ${row}, ${count}`;
}

/** How many comments a row has, on itself and on its entries. */
export function rowCommentCount(row: CommentRow<unknown>): number {
  return row.comments.length + row.entries.reduce((n, t) => n + t.comments.length, 0);
}

/** Who wrote a comment, from the viewer's side. */
export function authorLabel(c: SheetComment, viewerId: string): string {
  if (c.authorId !== null && c.authorId === viewerId) return "You";
  return c.authorName ?? "Someone";
}
