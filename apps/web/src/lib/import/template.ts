// Downloadable templates (#256): the header row and one example row per import, written
// with the same CSV writer as the exports (#65), so a template imports as it is.
import type { ImportKind } from "@ai-proctor/contracts";
import { toCsv } from "@ai-proctor/core";
import { COLUMNS, TEMPLATE_SKIP } from "./columns";

export function templateColumns(kind: ImportKind) {
  return COLUMNS[kind].filter((c) => !TEMPLATE_SKIP.has(c.name));
}

export function importTemplate(kind: ImportKind): string {
  const columns = templateColumns(kind);
  return toCsv([columns.map((c) => c.name), columns.map((c) => c.example)]);
}

export function templateFileName(kind: ImportKind): string {
  return `ai-proctor-${kind}-import-template.csv`;
}
