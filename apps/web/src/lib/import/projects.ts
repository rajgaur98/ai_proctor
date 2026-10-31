// Project imports (#256, PRJ-01): projects matched on client + name (case-insensitive,
// like the unique index), with who can log to them. The client must already exist.
// Empty billable / archived cells keep the current values; new projects are billable
// and active. Listed members are added; nobody is removed.
import { ImportProject } from "@ai-proctor/contracts";
import { ARCHIVED_WORDS } from "./clients";
import type { RowCells } from "./columns";
import { addIssues, listWords, RowResult } from "./rows";
import type { ImportContext } from "./types";
import { nameKey, parseEmailList, parseYesNo } from "./values";

const BILLABLE_WORDS = { yes: ["billable"], no: ["non-billable", "nonbillable", "not billable"] };

const projectKey = (client: string | null, name: string) =>
  `${nameKey(client ?? "")}\u0000${nameKey(name)}`;

export function previewProjects(rows: RowCells[], ctx: ImportContext) {
  const clients = new Map(ctx.clients.map((c) => [nameKey(c.name), c.name]));
  const projects = new Map(ctx.projects.map((p) => [projectKey(p.client, p.name), p]));
  const people = new Map(ctx.people.map((p) => [p.email.toLowerCase(), p]));
  const firstRow = new Map<string, number>();
  const results: RowResult[] = [];
  const items: ImportProject[] = [];

  for (const cells of rows) {
    const name = cells.get("project").replace(/\s+/g, " ");
    const clientCell = cells.get("client").replace(/\s+/g, " ");
    const result = new RowResult(
      cells.row,
      name ? (clientCell ? `${clientCell} / ${name}` : name) : `row ${cells.row}`,
    );
    results.push(result);
    if (cells.overflow) result.error(null, "This row has more values than the header has columns.");

    let client: string | null = null;
    if (clientCell) {
      const found = clients.get(nameKey(clientCell));
      if (found === undefined) {
        result.error(
          "client",
          `There's no client named "${clientCell}". Import clients first, or leave it empty.`,
        );
      } else client = found;
    }

    const key = projectKey(client, name);
    if (!name) result.error("project", "The project name is missing.");
    else if (name.length > 120)
      result.error("project", "The project name is longer than 120 characters.");
    else if (!clientCell || client !== null) {
      const first = firstRow.get(key);
      if (first !== undefined) {
        result.error("project", `The project "${result.key}" is also on row ${first}.`);
      } else firstRow.set(key, cells.row);
    }
    const current = projects.get(key);

    let billable = current?.billable ?? true;
    const billableCell = cells.get("billable");
    if (billableCell) {
      const b = parseYesNo(billableCell, BILLABLE_WORDS);
      if (b.ok) billable = b.value;
      else result.error("billable", b.message);
    }
    let archived = current?.archived ?? false;
    const archivedCell = cells.get("archived");
    if (archivedCell) {
      const a = parseYesNo(archivedCell, ARCHIVED_WORDS);
      if (a.ok) archived = a.value;
      else result.error("archived", a.message);
    }

    const list = parseEmailList(cells.get("members"));
    const members = list.ok ? list.value : [];
    if (!list.ok) result.error("members", list.message);
    const unknown = members.filter((e) => !people.has(e));
    const inactive = members.filter((e) => people.get(e)?.active === false);
    if (unknown.length > 0) {
      result.error(
        "members",
        `${listWords(unknown)} ${unknown.length === 1 ? "isn't" : "aren't"} in your organisation. Import people first.`,
      );
    }
    if (inactive.length > 0) {
      result.error(
        "members",
        `${listWords(inactive)} ${inactive.length === 1 ? "is" : "are"} deactivated.`,
      );
    }
    if (!result.ok) continue;

    if (!current) result.action = "create";
    else {
      if (billable !== current.billable) {
        result.changes.push(billable ? "makes it billable" : "makes it non-billable");
      }
      if (archived !== current.archived)
        result.changes.push(archived ? "archives it" : "makes it active");
      const had = new Set(current.members.map((e) => e.toLowerCase()));
      const adding = members.filter((e) => !had.has(e));
      if (adding.length > 0) result.changes.push(`adds ${listWords(adding)}`);
      result.action = result.changes.length > 0 ? "update" : "unchanged";
    }
    if (result.action === "unchanged") continue;
    const item = ImportProject.safeParse({
      rows: [result.row],
      action: result.action,
      name: current?.name ?? name,
      client,
      billable,
      archived,
      members,
    });
    if (item.success) items.push(item.data);
    else
      addIssues(result, item.error.issues, (k) =>
        k === "name" ? "project" : k === "rows" || k === "action" ? null : k,
      );
  }

  return { rows: results.map((r) => r.preview()), items };
}
