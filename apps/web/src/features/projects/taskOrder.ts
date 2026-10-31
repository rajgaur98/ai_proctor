// Task order (#269, PRJ-05): an owner or admin moves a project's tasks up and down. The
// database takes the project's whole list in the new order (reorder_tasks).

/**
 * `ids` with `id` moved `by` places (-1 up, +1 down), or null when it can't move that
 * way (already first or last, or not in the list).
 */
export function moveId(ids: string[], id: string, by: -1 | 1): string[] | null {
  const from = ids.indexOf(id);
  const to = from + by;
  if (from < 0 || to < 0 || to >= ids.length) return null;
  const next = [...ids];
  next.splice(from, 1);
  next.splice(to, 0, id);
  return next;
}

/**
 * `tasks` (every project's, in order) with `projectId`'s put in the order of `ids`; other
 * projects' tasks keep their places. For showing a move before the database confirms it.
 */
export function withOrder<T extends { id: string; projectId: string }>(
  tasks: T[],
  projectId: string,
  ids: string[],
): T[] {
  const own = tasks.filter((t) => t.projectId === projectId);
  const rank = new Map(ids.map((id, i) => [id, i]));
  // Tasks missing from `ids` keep their order, after the others.
  const ordered = [...own].sort(
    (a, b) => (rank.get(a.id) ?? ids.length) - (rank.get(b.id) ?? ids.length),
  );
  let next = 0;
  return tasks.map((t) => (t.projectId === projectId ? (ordered[next++] as T) : t));
}
