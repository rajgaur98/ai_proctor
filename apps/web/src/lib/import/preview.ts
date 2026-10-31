// The import preview (#256): a CSV file and what already exists in, a row-by-row verdict
// and the apply payload out. Nothing is written here; phase B's RPC applies `payload`
// all or nothing, so the payload is only there when no row has an error.
import { type ImportKind, ImportPayload } from "@ai-proctor/contracts";
import { readCsv } from "@ai-proctor/core";
import { previewClients } from "./clients";
import { mapColumns, type RowCells, rowCells } from "./columns";
import { previewPeople } from "./people";
import { previewProjects } from "./projects";
import { previewShifts } from "./shifts";
import { previewTeams } from "./teams";
import type { ImportContext, ImportPreview, PreviewRow, RowStatus } from "./types";

type KindPreview = (
  rows: RowCells[],
  ctx: ImportContext,
) => { rows: PreviewRow[]; items: unknown[] };

const KINDS: Record<ImportKind, KindPreview> = {
  people: previewPeople,
  teams: previewTeams,
  clients: previewClients,
  projects: previewProjects,
  shifts: previewShifts,
};

function counts(rows: PreviewRow[]): Record<RowStatus, number> {
  const c: Record<RowStatus, number> = { create: 0, update: 0, unchanged: 0, error: 0 };
  for (const r of rows) c[r.status]++;
  return c;
}

const failed = (
  kind: ImportKind,
  fileErrors: string[],
  ignoredColumns: string[] = [],
): ImportPreview => ({
  kind,
  fileErrors,
  ignoredColumns,
  rows: [],
  counts: counts([]),
  payload: null,
});

/** Checks every row of `text` (a CSV file) as an import of `kind` into what `ctx` holds. */
export function previewImport(kind: ImportKind, text: string, ctx: ImportContext): ImportPreview {
  const read = readCsv(text);
  if (!read.ok) return failed(kind, [read.error]);
  const { header, rows } = read.table;
  const map = mapColumns(kind, header);
  if (map.errors.length > 0) return failed(kind, map.errors, map.ignored);

  const result = KINDS[kind](
    rows.map((r) => rowCells(r, header, map)),
    ctx,
  );
  const preview: ImportPreview = {
    kind,
    fileErrors: [],
    ignoredColumns: map.ignored,
    rows: result.rows,
    counts: counts(result.rows),
    payload: null,
  };
  if (preview.counts.error > 0 || result.items.length === 0) return preview;
  const payload = ImportPayload.safeParse({ kind, items: result.items });
  if (payload.success) {
    preview.payload = payload.data;
  } else {
    // Each item was checked on its own, so this only fails on a bug; say so, send nothing.
    const why = payload.error.issues[0]?.message ?? "unknown problem";
    preview.fileErrors.push(`The import couldn't be prepared: ${why}.`);
  }
  return preview;
}
