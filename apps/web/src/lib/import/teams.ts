// Team imports (#256, ORG-08): teams by name (case-insensitive), with the emails of
// people to put in each. A person is in one team at most, so listing someone moves them
// from their current team. Nobody is taken out of a team by an import.
import { ImportTeam } from "@ai-proctor/contracts";
import type { RowCells } from "./columns";
import { addIssues, listWords, RowResult } from "./rows";
import type { ImportContext } from "./types";
import { nameKey, parseEmailList } from "./values";

export function previewTeams(rows: RowCells[], ctx: ImportContext) {
  const teams = new Map(ctx.teams.map((t) => [nameKey(t.name), t.name]));
  const people = new Map(ctx.people.map((p) => [p.email.toLowerCase(), p]));
  const firstRow = new Map<string, number>();
  const memberRow = new Map<string, { row: number; team: string }>();
  const results: RowResult[] = [];
  const items: ImportTeam[] = [];

  for (const cells of rows) {
    const name = cells.get("team").replace(/\s+/g, " ");
    const result = new RowResult(cells.row, name || `row ${cells.row}`);
    results.push(result);
    if (cells.overflow) result.error(null, "This row has more values than the header has columns.");

    const key = nameKey(name);
    if (!name) result.error("team", "The team name is missing.");
    else if (name.length > 80) result.error("team", "The team name is longer than 80 characters.");
    else {
      const first = firstRow.get(key);
      if (first !== undefined) result.error("team", `The team "${name}" is also on row ${first}.`);
      else firstRow.set(key, cells.row);
    }
    const current = teams.get(key);

    const list = parseEmailList(cells.get("members"));
    const members = list.ok ? list.value : [];
    if (!list.ok) result.error("members", list.message);
    const unknown: string[] = [];
    const inactive: string[] = [];
    for (const email of members) {
      const person = people.get(email);
      if (!person) unknown.push(email);
      else if (!person.active) inactive.push(email);
      const other = memberRow.get(email);
      if (other && nameKey(other.team) !== key) {
        result.error(
          "members",
          `${email} is also in "${other.team}" on row ${other.row}. A person can be in one team.`,
        );
      } else if (!other) memberRow.set(email, { row: cells.row, team: name });
    }
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

    if (current === undefined) result.action = "create";
    else {
      const joining: string[] = [];
      for (const email of members) {
        const was = people.get(email)?.team ?? null;
        if (was === null) joining.push(email);
        else if (nameKey(was) !== key) result.changes.push(`moves ${email} from ${was}`);
      }
      if (joining.length > 0) result.changes.unshift(`adds ${listWords(joining)}`);
      result.action = result.changes.length > 0 ? "update" : "unchanged";
    }
    if (result.action === "unchanged") continue;
    const item = ImportTeam.safeParse({
      rows: [result.row],
      action: result.action,
      name: current ?? name,
      members,
    });
    if (item.success) items.push(item.data);
    else
      addIssues(result, item.error.issues, (k) =>
        k === "name" ? "team" : k === "members" ? "members" : null,
      );
  }

  return { rows: results.map((r) => r.preview()), items };
}
