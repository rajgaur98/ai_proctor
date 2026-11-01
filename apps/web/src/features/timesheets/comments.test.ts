import { describe, expect, it } from "vitest";
import {
  authorLabel,
  commentRows,
  commentsFor,
  rowCommentCount,
  rowKey,
  type SheetComment,
} from "./comments";

const MAX = "max";
const ERIN = "erin";

let n = 0;
function comment(over: Partial<SheetComment>): SheetComment {
  n += 1;
  return {
    id: `c${String(n).padStart(2, "0")}`,
    timesheetId: "t1",
    userId: ERIN,
    target: "row",
    projectId: null,
    taskId: null,
    manualEntryId: null,
    authorId: MAX,
    authorName: "Max Manager",
    body: `Comment ${n}`,
    createdAt: `2026-10-20T10:${String(n).padStart(2, "0")}:00Z`,
    ...over,
  };
}

const unassigned = comment({ body: "Unassigned?" });
const revamp = comment({ projectId: "p1", body: "Revamp, no task" });
const design = comment({ projectId: "p1", taskId: "t-design", body: "Design?" });
const reply = comment({
  projectId: "p1",
  taskId: "t-design",
  authorId: ERIN,
  authorName: "Erin Employee",
  body: "Yes, checkout",
});
const onEntry = comment({
  target: "entry",
  projectId: "p1",
  manualEntryId: "e1",
  body: "Workshop?",
});
const onMoved = comment({ target: "entry", projectId: "p1", manualEntryId: "e2", body: "Moved" });
const onGone = comment({ target: "entry", projectId: "p2", manualEntryId: null, body: "Gone" });
const all = [onGone, reply, onEntry, design, revamp, unassigned, onMoved];

const entries = [
  { id: "e1", startAt: "2026-10-19T17:00:00Z", projectId: "p1", taskId: null },
  // Moved to the Design task after the comment was written.
  { id: "e2", startAt: "2026-10-19T15:00:00Z", projectId: "p1", taskId: "t-design" },
];

describe("rowKey", () => {
  it("keeps a task only with its project", () => {
    expect(rowKey(null, "t")).toBe(rowKey(null, null));
    expect(rowKey("p1", "t")).not.toBe(rowKey("p1", null));
  });
});

describe("commentsFor", () => {
  it("picks one row's thread, oldest first", () => {
    expect(
      commentsFor(all, { kind: "row", projectId: "p1", taskId: "t-design" }).map((c) => c.body),
    ).toEqual(["Design?", "Yes, checkout"]);
    expect(
      commentsFor(all, { kind: "row", projectId: "p1", taskId: null }).map((c) => c.body),
    ).toEqual(["Revamp, no task"]);
    expect(
      commentsFor(all, { kind: "row", projectId: null, taskId: null }).map((c) => c.body),
    ).toEqual(["Unassigned?"]);
  });

  it("picks one entry's thread, and never a row's", () => {
    expect(commentsFor(all, { kind: "entry", entryId: "e1" }).map((c) => c.body)).toEqual([
      "Workshop?",
    ]);
    expect(commentsFor(all, { kind: "entry", entryId: "nope" })).toEqual([]);
  });
});

describe("commentRows", () => {
  const rows = commentRows(
    all,
    [
      { projectId: "p1", taskId: "t-design" },
      { projectId: null, taskId: null },
    ],
    entries,
  );

  it("keeps the week's rows in order, then the rows that only have comments", () => {
    expect(rows.map((r) => rowKey(r.projectId, r.taskId))).toEqual([
      rowKey("p1", "t-design"),
      rowKey(null, null),
      rowKey("p1", null),
      rowKey("p2", null),
    ]);
  });

  it("puts row comments on their row and entry comments under the entry's row now", () => {
    const design = rows[0];
    expect(design?.comments.map((c) => c.body)).toEqual(["Design?", "Yes, checkout"]);
    expect(design?.entries.map((t) => t.entry?.id)).toEqual(["e2"]);
    const revampRow = rows[2];
    expect(revampRow?.comments.map((c) => c.body)).toEqual(["Revamp, no task"]);
    expect(revampRow?.entries.map((t) => [t.entry?.id, t.comments.map((c) => c.body)])).toEqual([
      ["e1", ["Workshop?"]],
    ]);
    if (design) expect(rowCommentCount(design)).toBe(3);
  });

  it("keeps a removed entry's comments on the row they were written on", () => {
    expect(rows[3]?.entries).toEqual([{ entry: null, comments: [onGone] }]);
  });

  it("lists rows with time even with no comments", () => {
    expect(rows[1]?.comments.map((c) => c.body)).toEqual(["Unassigned?"]);
    expect(commentRows([], [{ projectId: "p1", taskId: null }], [])).toEqual([
      { projectId: "p1", taskId: null, comments: [], entries: [] },
    ]);
  });
});

describe("authorLabel", () => {
  it("is You for the viewer's own, else the name as written", () => {
    expect(authorLabel(reply, ERIN)).toBe("You");
    expect(authorLabel(reply, MAX)).toBe("Erin Employee");
    expect(authorLabel({ ...design, authorId: null, authorName: null }, ERIN)).toBe("Someone");
  });
});
