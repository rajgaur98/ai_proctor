// Audit log (#53, AUD-01/02): owners and admins search who did what to whom, and
// export what they see. The export itself is audit-logged by the database.
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { DateTime } from "luxon";
import { useId, useMemo, useState } from "react";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { membersQuery } from "../people/members";
import { actionLabel, knownActions, summarize } from "./actions";
import { type AuditFilters, auditQuery, exportAuditLog, noFilters } from "./audit";

const select =
  "h-11 w-full rounded-[9px] border border-line2 bg-panel px-3 text-sm text-ink disabled:opacity-60";

function download(filename: string, csv: string) {
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export function AuditLog() {
  const { profile } = useRouteContext({ from: "/_app" });
  const queryClient = useQueryClient();
  const id = useId();
  const [filters, setFilters] = useState<AuditFilters>(noFilters);
  const set = (patch: Partial<AuditFilters>) => setFilters({ ...filters, ...patch });
  const filtered = JSON.stringify(filters) !== JSON.stringify(noFilters);

  const members = useQuery(membersQuery);
  const names = useMemo(
    () => new Map((members.data ?? []).map((m) => [m.id, m.fullName])),
    [members.data],
  );
  const nameOf = (userId: string | null) =>
    userId ? (names.get(userId) ?? userId.slice(0, 8)) : "nobody";

  const { data, error, isPending, hasNextPage, fetchNextPage, isFetchingNextPage } =
    useInfiniteQuery(auditQuery(filters));
  const rows = data?.pages.flatMap((p) => p.rows) ?? [];

  const exportCsv = useMutation({
    mutationFn: () => exportAuditLog(filters),
    onSuccess: ({ csv, filename }) => {
      download(filename, csv);
      // The export is now an entry of its own.
      queryClient.invalidateQueries({ queryKey: ["audit"] });
    },
  });

  const time = (iso: string) => {
    const t = DateTime.fromISO(iso, { zone: profile.timezone });
    return (
      <time dateTime={iso} className="font-mono text-[12.5px] whitespace-nowrap">
        {t.toFormat("d LLL yyyy, HH:mm:ss")}
      </time>
    );
  };

  return (
    <section className="flex flex-col gap-5">
      <div className="flex flex-wrap items-end gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-[-0.025em]">Audit log</h1>
          <p className="mt-1 text-[13.5px] text-ink2">
            {profile.orgName} · times in {profile.timezone}
          </p>
        </div>
        <Button
          className="ml-auto"
          variant="secondary"
          disabled={exportCsv.isPending}
          onClick={() => exportCsv.mutate()}
        >
          {exportCsv.isPending ? "Exporting…" : "Export CSV"}
        </Button>
      </div>

      <form
        aria-label="Filters"
        className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[repeat(5,minmax(0,1fr))_auto]"
        onSubmit={(e) => e.preventDefault()}
      >
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-actor`}>Actor</Label>
          <select
            id={`${id}-actor`}
            className={select}
            value={filters.actorId}
            onChange={(e) => set({ actorId: e.target.value })}
          >
            <option value="">Anyone</option>
            {(members.data ?? []).map((m) => (
              <option key={m.id} value={m.id}>
                {m.fullName}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-target`}>Target</Label>
          <select
            id={`${id}-target`}
            className={select}
            value={filters.targetId}
            onChange={(e) => set({ targetId: e.target.value })}
          >
            <option value="">Anyone</option>
            {(members.data ?? []).map((m) => (
              <option key={m.id} value={m.id}>
                {m.fullName}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="text-[13px] font-medium text-ink2">Action</span>
          <details className="relative">
            <summary className="flex h-11 cursor-pointer list-none items-center rounded-[9px] border border-line2 bg-panel px-3 text-sm text-ink">
              {filters.actions.length ? `${filters.actions.length} selected` : "Any action"}
            </summary>
            <fieldset className="absolute left-0 z-10 mt-2 flex w-64 flex-col gap-0.5 rounded-xl border border-line bg-panel p-2 shadow-lg">
              <legend className="sr-only">Actions</legend>
              {knownActions.map((a) => (
                <label
                  key={a}
                  className="flex min-h-9 items-center gap-2 rounded-lg px-2 text-[13.5px] hover:bg-sunk"
                >
                  <input
                    type="checkbox"
                    checked={filters.actions.includes(a)}
                    onChange={(e) =>
                      set({
                        actions: e.target.checked
                          ? [...filters.actions, a]
                          : filters.actions.filter((x) => x !== a),
                      })
                    }
                  />
                  {actionLabel(a)}
                </label>
              ))}
            </fieldset>
          </details>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-from`}>From</Label>
          <Input
            id={`${id}-from`}
            type="date"
            value={filters.from}
            max={filters.to || undefined}
            onChange={(e) => set({ from: e.target.value })}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-to`}>To</Label>
          <Input
            id={`${id}-to`}
            type="date"
            value={filters.to}
            min={filters.from || undefined}
            onChange={(e) => set({ to: e.target.value })}
          />
        </div>
        <Button
          type="button"
          variant="ghost"
          className="self-end"
          onClick={() => setFilters(noFilters)}
        >
          Clear filters
        </Button>
      </form>

      {exportCsv.error && (
        <p role="alert" className="text-sm text-warnink">
          Couldn't export: {exportCsv.error.message}
        </p>
      )}
      {exportCsv.isSuccess && (
        <p role="status" className="text-sm text-ink2">
          Exported {exportCsv.data.rowCount} {exportCsv.data.rowCount === 1 ? "entry" : "entries"}{" "}
          to {exportCsv.data.filename}. The export is recorded in the log.
        </p>
      )}

      <div className="overflow-hidden rounded-xl border border-line bg-panel">
        {error ? (
          <p role="alert" className="p-6 text-sm text-warnink">
            Couldn't load the audit log: {error.message}
          </p>
        ) : isPending ? (
          <p className="p-6 text-sm text-ink2">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="p-6 text-sm text-ink2">
            {filtered ? "No entries match these filters." : "Nothing has been logged yet."}
          </p>
        ) : (
          <table className="w-full border-collapse text-[13.5px]">
            <thead className="hidden bg-sunk text-left text-xs font-medium text-ink3 md:table-header-group">
              <tr className="h-10 border-b border-line">
                <th className="px-5 font-medium">Time</th>
                <th className="font-medium">Actor</th>
                <th className="font-medium">Action</th>
                <th className="font-medium">Target</th>
                <th className="pr-5 font-medium">Details</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.id}
                  className="flex flex-col gap-1 border-b border-line px-5 py-3 last:border-0 md:table-row md:p-0 md:align-top"
                >
                  <td className="md:px-5 md:py-3">{time(r.at)}</td>
                  <td className="md:py-3">{r.actorName ?? "System"}</td>
                  <td className="font-medium md:py-3">
                    {actionLabel(r.action)}
                    <span className="block font-mono text-[11.5px] font-normal text-ink3">
                      {r.action}
                    </span>
                  </td>
                  <td className="text-ink2 md:py-3">{r.targetName ?? "—"}</td>
                  <td className="break-words text-ink2 md:py-3 md:pr-5">
                    {summarize(r.action, r.metadata, nameOf)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="flex items-center gap-3 px-5 py-3 text-xs text-ink3">
          <span>
            {rows.length} {rows.length === 1 ? "entry" : "entries"} shown. Entries can't be edited
            or deleted.
          </span>
          {hasNextPage && (
            <Button
              variant="secondary"
              className="ml-auto h-9"
              disabled={isFetchingNextPage}
              onClick={() => fetchNextPage()}
            >
              {isFetchingNextPage ? "Loading…" : "Load more"}
            </Button>
          )}
        </div>
      </div>
    </section>
  );
}
