// Timesheet totals (#266, TS-29): worked time split into billable and non-billable and by
// client, project and task, on the week page (one person) and the Timesheets list (the
// timesheets shown). The numbers come from packages/core workTotals, summed from raw
// seconds; they are rounded only here, for display. Overtime (#65, TS-19) is shown next to
// them by the page, which knows whether it is one person's week or many.
import type { ClientTotal, WorkTotals } from "@ai-proctor/core";
import type { ReactNode } from "react";
import { ExportButton } from "../../components/ExportButton";
import type { ExportFilters } from "../../lib/exportFile";
import { totalsTable } from "./sheetExport";
import { formatDuration } from "./summary";

interface Names {
  client: (c: ClientTotal) => string;
  project: (projectId: string | null) => string;
  task: (projectId: string | null, taskId: string | null) => string;
}

/** Names for the totals from the org's clients, projects and tasks. */
export function totalsNames(
  clients: readonly { id: string; name: string }[],
  projects: readonly { id: string; name: string }[],
  tasks: readonly { id: string; name: string }[],
): Names {
  const project = (id: string | null) =>
    id ? (projects.find((p) => p.id === id)?.name ?? "Project") : "Unassigned";
  return {
    client: (c) =>
      c.unassigned
        ? "Unassigned"
        : c.clientId
          ? (clients.find((x) => x.id === c.clientId)?.name ?? "Client")
          : "No client",
    project,
    task: (projectId, taskId) =>
      projectId === null
        ? "Unassigned"
        : `${project(projectId)} › ${taskId ? (tasks.find((t) => t.id === taskId)?.name ?? "Task") : "No task"}`,
  };
}

function Stat({ label, seconds }: { label: string; seconds: number }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs text-ink3">{label}</dt>
      <dd className="font-mono text-[15px] font-medium">{formatDuration(seconds)}</dd>
    </div>
  );
}

function SplitTable({
  id,
  heading,
  column,
  rows,
}: {
  id: string;
  heading: string;
  column: string;
  rows: { key: string; name: string; seconds: number; billable: number }[];
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <h3 id={id} className="text-[13px] font-semibold">
        {heading}
      </h3>
      <table aria-labelledby={id} className="w-full border-collapse text-[13px]">
        <thead className="text-left text-xs text-ink3">
          <tr className="h-8 border-b border-line">
            <th scope="col" className="pr-3 font-medium">
              {column}
            </th>
            <th scope="col" className="pr-3 text-right font-medium">
              Worked
            </th>
            <th scope="col" className="text-right font-medium">
              Billable
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key} className="h-9 border-b border-line last:border-0">
              <th scope="row" className="pr-3 text-left font-normal break-words">
                {r.name}
              </th>
              <td className="pr-3 text-right font-mono whitespace-nowrap">
                {formatDuration(r.seconds)}
              </td>
              <td className="text-right font-mono whitespace-nowrap text-ink2">
                {r.billable > 0 ? formatDuration(r.billable) : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function TotalsPanel({
  id,
  title,
  description,
  totals,
  names,
  overtime,
  loading,
  exportAs,
}: {
  id: string;
  title: string;
  description?: string;
  totals: WorkTotals;
  names: Names;
  /** The overtime note shown next to the totals, or nothing. */
  overtime?: ReactNode;
  loading?: boolean;
  /** #255: an Export of these totals, recorded as `page` with the view's filters. */
  exportAs?: { page: string; filters: ExportFilters };
}) {
  return (
    <section
      aria-labelledby={`${id}-title`}
      className="overflow-hidden rounded-xl border border-line bg-panel"
    >
      <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1 border-b border-line px-5 py-4">
        <h2 id={`${id}-title`} className="text-[15px] font-semibold">
          {title}
        </h2>
        {description && <span className="text-[12.5px] text-ink2">{description}</span>}
        {exportAs && (
          <ExportButton
            title={title}
            className="ml-auto h-9"
            ready={!loading}
            spec={{ ...exportAs, table: () => totalsTable(totals, names) }}
          />
        )}
      </div>
      {loading ? (
        <p className="px-5 py-4 text-[13px] text-ink2">Loading…</p>
      ) : (
        <div className="flex flex-col gap-4 px-5 py-4">
          <div className="flex flex-wrap items-end gap-x-8 gap-y-3">
            <dl className="flex flex-wrap gap-x-8 gap-y-3">
              <Stat label="Worked" seconds={totals.seconds} />
              <Stat label="Billable" seconds={totals.billable} />
              <Stat label="Non-billable" seconds={totals.nonBillable} />
            </dl>
            {overtime}
          </div>
          {totals.seconds > 0 ? (
            <div className="grid gap-5 lg:grid-cols-3">
              <SplitTable
                id={`${id}-clients`}
                heading="By client"
                column="Client"
                rows={totals.byClient.map((c) => ({
                  key: c.unassigned ? "unassigned" : (c.clientId ?? "none"),
                  name: names.client(c),
                  seconds: c.seconds,
                  billable: c.billable,
                }))}
              />
              <SplitTable
                id={`${id}-projects`}
                heading="By project"
                column="Project"
                rows={totals.byProject.map((p) => ({
                  key: p.projectId ?? "none",
                  name: names.project(p.projectId),
                  seconds: p.seconds,
                  billable: p.billable,
                }))}
              />
              <SplitTable
                id={`${id}-tasks`}
                heading="By task"
                column="Task"
                rows={totals.byTask.map((t) => ({
                  key: `${t.projectId ?? ""}:${t.taskId ?? ""}`,
                  name: names.task(t.projectId, t.taskId),
                  seconds: t.seconds,
                  billable: t.billable,
                }))}
              />
            </div>
          ) : (
            <p className="text-[13px] text-ink2">No worked time.</p>
          )}
        </div>
      )}
    </section>
  );
}

/** Overtime next to the totals, in the highlight style (TS-19); nothing when none. */
export function OvertimeChips({ items }: { items: string[] }) {
  if (items.length === 0) return null;
  return (
    <p className="flex flex-wrap items-center gap-2 text-[13px]">
      <span className="text-ink2">Overtime:</span>
      {items.map((text) => (
        <span
          key={text}
          className="inline-flex h-6 items-center rounded-full border border-warnline bg-warnbg px-2.5 text-warnink"
        >
          {text}
        </span>
      ))}
    </p>
  );
}
