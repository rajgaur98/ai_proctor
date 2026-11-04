// Holiday imports (#319, LV-02): holidays matched on date and place like the unique index
// (date, country, state; no country is everyone). A holiday that isn't there is added;
// one with the same name is left alone; one with another name is renamed. Imports never
// delete holidays. The place is the country and state columns, or both in one `location`
// cell ("US-CA"); empty is everyone.
import { ImportHoliday } from "@ai-proctor/contracts";
import type { RowCells } from "./columns";
import { addIssues, RowResult } from "./rows";
import type { ImportContext } from "./types";
import { parseCountry, parseDate, parseLocation, parseState } from "./values";

const placeKey = (day: string, country: string | null, state: string | null) =>
  `${day}|${country ?? ""}|${state ?? ""}`;

const placeWords = (country: string | null, state: string | null) =>
  country ? (state ? `${country} ${state}` : country) : "everyone";

export function previewHolidays(rows: RowCells[], ctx: ImportContext) {
  const existing = new Map(
    (ctx.holidays ?? []).map((h) => [placeKey(h.day, h.country, h.state), h]),
  );
  const firstRow = new Map<string, number>();
  const results: RowResult[] = [];
  const items: ImportHoliday[] = [];

  for (const cells of rows) {
    const dateCell = cells.get("date");
    const name = cells.get("name").replace(/\s+/g, " ");
    const result = new RowResult(cells.row, name || `row ${cells.row}`);
    results.push(result);
    if (cells.overflow) result.error(null, "This row has more values than the header has columns.");

    let day: string | undefined;
    if (!dateCell) result.error("date", "The date is missing.");
    else {
      const d = parseDate(dateCell);
      if (d.ok) day = d.value;
      else result.error("date", d.message);
    }
    if (!name) result.error("name", "The holiday name is missing.");
    else if (name.length > 80)
      result.error("name", "The holiday name is longer than 80 characters.");

    // Place: country and state, or both in one cell. Empty: everyone.
    let country: string | undefined;
    let state: string | undefined;
    const locationCell = cells.get("location");
    if (locationCell) {
      const l = parseLocation(locationCell);
      if (!l.ok) result.error("location", l.message);
      else {
        country = l.value.country;
        if (l.value.state) state = l.value.state;
      }
    }
    const countryCell = cells.get("country");
    if (countryCell) {
      const c = parseCountry(countryCell);
      if (!c.ok) result.error("country", c.message);
      else if (country !== undefined && country !== c.value) {
        result.error("country", `The country (${c.value}) and the location (${country}) disagree.`);
      } else country = c.value;
    }
    const stateCell = cells.get("state");
    if (stateCell) {
      const s = parseState(stateCell);
      if (!s.ok) result.error("state", s.message);
      else if (state !== undefined && state !== s.value) {
        result.error("state", `The state (${s.value}) and the location (${state}) disagree.`);
      } else state = s.value;
    }
    const placeBad = result.errors.some((e) =>
      ["country", "state", "location"].includes(e.field ?? ""),
    );
    if (!placeBad && state !== undefined && country !== "US") {
      result.error(
        "state",
        country
          ? "Only US holidays have a state."
          : "A state needs a country; only US holidays have one.",
      );
    }
    if (!result.ok || day === undefined) continue;

    result.key = `${day}, ${placeWords(country ?? null, state ?? null)}`;
    const key = placeKey(day, country ?? null, state ?? null);
    const first = firstRow.get(key);
    if (first !== undefined) {
      result.error(
        null,
        `A holiday for ${placeWords(country ?? null, state ?? null)} on ${day} is also on row ${first}.`,
      );
      continue;
    }
    firstRow.set(key, cells.row);

    const current = existing.get(key);
    if (!current) result.action = "create";
    else if (current.name === name) result.action = "unchanged";
    else {
      result.action = "update";
      result.changes.push(`renames it from ${current.name} to ${name}`);
    }
    if (result.action === "unchanged") continue;
    const item = ImportHoliday.safeParse({
      rows: [result.row],
      action: result.action,
      day,
      name,
      country: country ?? null,
      state: state ?? null,
    });
    if (item.success) items.push(item.data);
    else
      addIssues(result, item.error.issues, (k) =>
        k === "day" ? "date" : k === "name" || k === "country" || k === "state" ? k : null,
      );
  }

  return { rows: results.map((r) => r.preview()), items };
}
