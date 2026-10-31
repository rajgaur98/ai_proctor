// Settings → Import (#256, ORG-03..08, PRJ-01, SHF-01; #282, TS-31): owners and admins add
// or update people, teams, clients, projects and shifts, and add manual time entries, from
// a spreadsheet. Pick what to import, download the template if needed, choose a CSV or
// .xlsx file, read the row-by-row preview, then import. Nothing changes until Import is
// pressed, and then all of it or none of it does. After an import the same file is checked again, so every row it
// changed reads "Unchanged".

import type { ImportKind } from "@ai-proctor/contracts";
import type { CsvReadResult } from "@ai-proctor/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { useId, useMemo, useState } from "react";
import { Button } from "../../components/ui/button";
import {
  type ImportContext,
  type ImportPreview,
  importTemplate,
  previewRead,
  type RowStatus,
  readImportFile,
  type TimeContext,
  templateColumns,
  templateFileName,
  timeEntriesScope,
} from "../../lib/import";
import {
  type ApplyResult,
  applyImport,
  importContextQuery,
  importTimeContextQuery,
} from "./importData";
import { explainImportError } from "./importErrors";

const KINDS: { kind: ImportKind; label: string; about: string }[] = [
  {
    kind: "people",
    label: "People",
    about:
      "Invite new people and update existing ones, matched on email. New people get the usual invite email.",
  },
  { kind: "teams", label: "Teams", about: "Create teams and add people to them, matched on name." },
  { kind: "clients", label: "Clients", about: "Create clients or archive them, matched on name." },
  {
    kind: "projects",
    label: "Projects",
    about: "Create projects and add who can log time to them, matched on client and name.",
  },
  {
    kind: "shifts",
    label: "Shifts",
    about:
      "Set people's shifts, one row per shift. Each person in the file gets exactly those shifts.",
  },
  {
    kind: "time_entries",
    label: "Time entries",
    about:
      "Add manual time entries, one row per entry, with times in each person's time zone. Each one needs approval as if the person had asked for it, unless they need none. Matched on email, start and end; existing entries are never changed.",
  },
];

// A time-entry file that names nobody (or can't be read) has nothing to check against.
const NO_TIME: TimeContext = { entries: [], clocked: [], locked: [] };

const STATUS: Record<RowStatus, string> = {
  create: "New",
  update: "Update",
  unchanged: "Unchanged",
  error: "Error",
};

// More rows than this are summed up, not drawn.
const SHOWN = 1000;

function download(kind: ImportKind) {
  const url = URL.createObjectURL(new Blob([importTemplate(kind)], { type: "text/csv" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = templateFileName(kind);
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

const plural = (n: number, one: string, many = `${one}s`) =>
  `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

export function ImportPage() {
  const { profile } = useRouteContext({ from: "/_app" });
  const queryClient = useQueryClient();
  const data = useQuery(importContextQuery);
  const [kind, setKind] = useState<ImportKind>("people");
  const [file, setFile] = useState<{ name: string; read: CsvReadResult } | null>(null);
  const [reading, setReading] = useState(false);
  const [done, setDone] = useState<ApplyResult | null>(null);
  const fileId = useId();

  const context = useMemo((): ImportContext | null => {
    if (!data.data) return null;
    const me = data.data.byId.get(profile.id);
    return {
      ...data.data,
      me: { email: me?.email ?? "" },
      // A new person's empty cells: the invite dialog's defaults (reporting to the importer).
      ...(me
        ? {
            defaults: {
              role: "employee" as const,
              manager_email: me.role === "employee" ? null : me.email,
              work_country: me.work_country,
              work_state: me.work_state,
              timezone: me.timezone,
            },
          }
        : {}),
    };
  }, [data.data, profile.id]);

  // Time entries also need what's already there for the file's people and dates.
  const scope = useMemo(
    () => (kind === "time_entries" && file ? timeEntriesScope(file.read) : null),
    [kind, file],
  );
  const time = useQuery({
    ...importTimeContextQuery(scope ?? { emails: [], from: "", to: "" }),
    enabled: scope !== null,
  });
  const previewContext = useMemo((): ImportContext | null => {
    if (!context || kind !== "time_entries") return context;
    if (!scope) return { ...context, time: NO_TIME };
    return time.data ? { ...context, time: time.data } : null;
  }, [context, kind, scope, time.data]);

  const preview: ImportPreview | null = useMemo(
    () => (file && previewContext ? previewRead(kind, file.read, previewContext) : null),
    [file, previewContext, kind],
  );

  const apply = useMutation({
    mutationFn: applyImport,
    onSuccess: async (result) => {
      setDone(result);
      await Promise.all(
        ["import-context", "import-time-context", "members", "teams", "projects", "clients"].map(
          (key) => queryClient.invalidateQueries({ queryKey: [key] }),
        ),
      );
    },
  });

  async function pick(f: File | undefined) {
    setDone(null);
    apply.reset();
    if (!f) {
      setFile(null);
      return;
    }
    setReading(true);
    try {
      const read = await readImportFile(f.name, new Uint8Array(await f.arrayBuffer()));
      setFile({ name: f.name, read });
    } finally {
      setReading(false);
    }
  }

  const about = KINDS.find((k) => k.kind === kind);
  const changes = preview ? preview.counts.create + preview.counts.update : 0;

  return (
    <section className="flex max-w-[960px] flex-col gap-5">
      <div>
        <p className="text-xs font-medium text-ink3">Settings</p>
        <h1 className="text-2xl font-semibold tracking-[-0.025em]">Import</h1>
        <p className="mt-1 max-w-[620px] text-[13.5px] text-ink2">
          Add or update {profile.orgName}'s people, teams, clients, projects and shifts, and add
          time entries, from a spreadsheet. Nothing changes until you import, and if any row fails
          nothing is imported.
        </p>
      </div>

      <div className="flex flex-col gap-4 rounded-xl border border-line bg-panel p-5">
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 text-sm font-semibold">What to import</legend>
          <div className="flex flex-wrap gap-2">
            {KINDS.map((k) => (
              <label
                key={k.kind}
                className="flex h-11 cursor-pointer items-center gap-2 rounded-[9px] border border-line2 px-3.5 text-sm has-[:checked]:border-acc has-[:checked]:bg-accsoft"
              >
                <input
                  type="radio"
                  name="import-kind"
                  value={k.kind}
                  checked={kind === k.kind}
                  onChange={() => {
                    setKind(k.kind);
                    setDone(null);
                    apply.reset();
                  }}
                />
                {k.label}
              </label>
            ))}
          </div>
          <p className="text-[13.5px] text-ink2">{about?.about}</p>
        </fieldset>

        <div className="flex flex-wrap items-center gap-3 text-[13.5px]">
          <span className="text-ink2">
            Columns:{" "}
            {templateColumns(kind).map((c, i) => (
              <span key={c.name}>
                {i > 0 && ", "}
                <code className="font-mono text-[12.5px] text-ink">{c.name}</code>
                {c.required && <span className="text-ink3"> (required)</span>}
              </span>
            ))}
          </span>
          <Button variant="secondary" className="ml-auto" onClick={() => download(kind)}>
            Download template
          </Button>
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor={fileId} className="text-sm font-semibold">
            Spreadsheet (CSV or Excel .xlsx, up to 5,000 rows)
          </label>
          <input
            id={fileId}
            type="file"
            accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            className="rounded-[9px] border border-dashed border-line2 bg-sunk p-4 text-sm file:mr-3 file:h-9 file:rounded-[8px] file:border file:border-line2 file:bg-panel file:px-3 file:text-ink"
            onChange={(e) => pick(e.target.files?.[0])}
            onDragOver={(e) => e.preventDefault()}
          />
        </div>
      </div>

      {data.error && (
        <p role="alert" className="text-sm text-warnink">
          Couldn't load your organisation's data: {data.error.message}
        </p>
      )}
      {time.error && (
        <p role="alert" className="text-sm text-warnink">
          Couldn't load the existing time for this file: {time.error.message}
        </p>
      )}
      {reading && <p className="text-sm text-ink2">Reading the file…</p>}
      {!reading && scope && time.isPending && (
        <p className="text-sm text-ink2">Checking the time already there…</p>
      )}

      {preview && file && (
        <Preview
          preview={preview}
          fileName={file.name}
          changes={changes}
          applying={apply.isPending}
          onApply={() => preview.payload && apply.mutate(preview.payload)}
        />
      )}

      <div aria-live="polite">
        {done && (
          <div role="status" className="rounded-xl border border-line bg-panel p-4 text-sm">
            <p className="font-semibold">
              Imported: {plural(done.created, "added", "added")},{" "}
              {plural(done.updated, "updated", "updated")}.
            </p>
            {done.invites.some((i) => !i.ok) && (
              <p className="mt-1 text-warnink">
                These invite emails didn't go out; invite them again from People:{" "}
                {done.invites
                  .filter((i) => !i.ok)
                  .map((i) => i.email)
                  .join(", ")}
              </p>
            )}
            {done.invites.some((i) => i.ok) && (
              <p className="mt-1 text-ink2">
                {plural(done.invites.filter((i) => i.ok).length, "invite email")} sent.
              </p>
            )}
          </div>
        )}
      </div>
      {apply.error && (
        <p
          role="alert"
          className="rounded-xl border border-warnline bg-warnbg p-4 text-sm text-warnink"
        >
          {explainImportError(apply.error)}
        </p>
      )}
    </section>
  );
}

function Preview({
  preview,
  fileName,
  changes,
  applying,
  onApply,
}: {
  preview: ImportPreview;
  fileName: string;
  changes: number;
  applying: boolean;
  onApply: () => void;
}) {
  const { counts } = preview;
  const rows = preview.rows.slice(0, SHOWN);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <h2 className="text-lg font-semibold">Preview</h2>
          <p className="text-[13.5px] text-ink2">
            {fileName}
            {preview.rows.length > 0 &&
              ` · ${plural(counts.create, "new")} · ${plural(counts.update, "update")} · ${plural(counts.unchanged, "unchanged", "unchanged")} · ${plural(counts.error, "error")}`}
          </p>
        </div>
        <Button className="ml-auto" disabled={!preview.payload || applying} onClick={onApply}>
          {applying ? "Importing…" : changes > 0 ? `Import ${plural(changes, "change")}` : "Import"}
        </Button>
      </div>

      {preview.fileErrors.length > 0 && (
        <div
          role="alert"
          className="rounded-xl border border-warnline bg-warnbg p-4 text-sm text-warnink"
        >
          {preview.fileErrors.map((e) => (
            <p key={e}>{e}</p>
          ))}
        </div>
      )}
      {counts.error > 0 && (
        <p role="alert" className="text-sm text-warnink">
          Fix the {plural(counts.error, "row")} marked Error in the file and choose it again.
        </p>
      )}
      {preview.fileErrors.length === 0 && counts.error === 0 && changes === 0 && (
        <p className="text-sm text-ink2">Everything in this file is already up to date.</p>
      )}
      {preview.ignoredColumns.length > 0 && (
        <p className="text-[13.5px] text-ink2">
          Not read (no such column): {preview.ignoredColumns.join(", ")}
        </p>
      )}

      {rows.length > 0 && (
        <div className="overflow-x-auto rounded-xl border border-line bg-panel">
          <table className="w-full border-collapse text-[13.5px]">
            <caption className="sr-only">Each row of the file and what importing it does</caption>
            <thead className="bg-sunk text-left text-xs font-medium text-ink3">
              <tr className="h-10 border-b border-line">
                <th scope="col" className="px-4 font-medium">
                  Row
                </th>
                <th scope="col" className="px-2 font-medium">
                  Matches
                </th>
                <th scope="col" className="px-2 font-medium">
                  Result
                </th>
                <th scope="col" className="px-2 pr-4 font-medium">
                  Details
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.row} className="border-b border-line align-top last:border-0">
                  <td className="px-4 py-2.5 tabular-nums text-ink2">{r.row}</td>
                  <td className="break-all px-2 py-2.5">{r.key}</td>
                  <td
                    className={`px-2 py-2.5 font-medium ${r.status === "error" ? "text-warnink" : r.status === "unchanged" ? "text-ink2" : ""}`}
                  >
                    {STATUS[r.status]}
                  </td>
                  <td className="px-2 py-2.5 pr-4">
                    {r.errors.length > 0 ? (
                      <ul className="flex flex-col gap-0.5 text-warnink">
                        {r.errors.map((e) => (
                          <li key={`${e.field}:${e.message}`}>
                            {e.field && (
                              <span className="font-mono text-[12.5px]">{e.field}: </span>
                            )}
                            {e.message}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <span className="text-ink2">{r.changes.join("; ")}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {preview.rows.length > SHOWN && (
            <p className="px-4 py-3 text-xs text-ink3">
              Showing the first {SHOWN.toLocaleString("en-US")} of{" "}
              {preview.rows.length.toLocaleString("en-US")} rows; the counts above cover them all.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
