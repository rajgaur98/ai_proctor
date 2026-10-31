// Client imports (#256, PRJ-01): clients by name (case-insensitive, like the unique
// index). An empty archived cell keeps the current value; new clients are active.
import { ImportClient } from "@ai-proctor/contracts";
import type { RowCells } from "./columns";
import { addIssues, RowResult } from "./rows";
import type { ImportContext } from "./types";
import { nameKey, parseYesNo } from "./values";

export const ARCHIVED_WORDS = { yes: ["archived"], no: ["active"] };

export function previewClients(rows: RowCells[], ctx: ImportContext) {
  const clients = new Map(ctx.clients.map((c) => [nameKey(c.name), c]));
  const firstRow = new Map<string, number>();
  const results: RowResult[] = [];
  const items: ImportClient[] = [];

  for (const cells of rows) {
    const name = cells.get("name").replace(/\s+/g, " ");
    const result = new RowResult(cells.row, name || `row ${cells.row}`);
    results.push(result);
    if (cells.overflow) result.error(null, "This row has more values than the header has columns.");

    const key = nameKey(name);
    if (!name) result.error("name", "The client name is missing.");
    else if (name.length > 120)
      result.error("name", "The client name is longer than 120 characters.");
    else {
      const first = firstRow.get(key);
      if (first !== undefined)
        result.error("name", `The client "${name}" is also on row ${first}.`);
      else firstRow.set(key, cells.row);
    }
    const current = clients.get(key);

    let archived = current?.archived ?? false;
    const archivedCell = cells.get("archived");
    if (archivedCell) {
      const a = parseYesNo(archivedCell, ARCHIVED_WORDS);
      if (a.ok) archived = a.value;
      else result.error("archived", a.message);
    }
    if (!result.ok) continue;

    if (!current) result.action = "create";
    else {
      if (archived !== current.archived)
        result.changes.push(archived ? "archives it" : "makes it active");
      result.action = result.changes.length > 0 ? "update" : "unchanged";
    }
    if (result.action === "unchanged") continue;
    const item = ImportClient.safeParse({
      rows: [result.row],
      action: result.action,
      name: current?.name ?? name,
      archived,
    });
    if (item.success) items.push(item.data);
    else addIssues(result, item.error.issues, (k) => (k === "name" || k === "archived" ? k : null));
  }

  return { rows: results.map((r) => r.preview()), items };
}
