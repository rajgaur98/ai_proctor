// Who has acknowledged (#145, AGT-04, ADM-06, AUD-01): one row per active member with
// the latest version they acknowledged, a filter, counts and a CSV export (the
// database audit-logs each export). People who never acknowledged anything are
// highlighted: the server refuses their clock-in.
import { useMutation, useQuery } from "@tanstack/react-query";
import { DateTime } from "luxon";
import { useId, useState } from "react";
import { Button } from "../../components/ui/button";
import { Label } from "../../components/ui/label";
import { cn } from "../../lib/cn";
import {
  type AckFilter,
  ackCounts,
  ackFilters,
  ackReportCsv,
  filterAcks,
  isBlocked,
  roleName,
} from "./ackRows";
import { DateTimeText } from "./NoticeView";
import { ackReportQuery, exportAckReport } from "./noticeData";

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function AckReport({ currentVersion }: { currentVersion: number }) {
  const filterId = useId();
  const { data, error, isPending } = useQuery(ackReportQuery);
  const [filter, setFilter] = useState<AckFilter>("all");
  const rows = data ?? [];
  const counts = ackCounts(rows);
  const visible = filterAcks(rows, filter);

  const exportCsv = useMutation({
    mutationFn: () => exportAckReport(filter),
    onSuccess: (exported) =>
      download(`notice-acknowledgements-${DateTime.now().toISODate()}.csv`, ackReportCsv(exported)),
  });

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-line bg-panel p-5">
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <h2 className="text-base font-semibold">Who has acknowledged</h2>
          <p className="mt-1 text-[13px] text-ink2">
            Active members and the latest version each one acknowledged. Exports are recorded in the
            audit log.
          </p>
        </div>
        <div className="ml-auto flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={filterId}>Show</Label>
            <select
              id={filterId}
              value={filter}
              onChange={(e) => setFilter(e.target.value as AckFilter)}
              className="h-11 rounded-[9px] border border-line2 bg-panel px-3 text-sm text-ink"
            >
              {ackFilters.map((f) => (
                <option key={f.value} value={f.value}>
                  {f.label}
                </option>
              ))}
            </select>
          </div>
          <Button
            variant="secondary"
            disabled={isPending || !!error || exportCsv.isPending}
            onClick={() => exportCsv.mutate()}
          >
            {exportCsv.isPending ? "Exporting…" : "Export CSV"}
          </Button>
        </div>
      </div>

      {error ? (
        <p role="alert" className="text-sm text-warnink">
          Couldn't load the report: {error.message}
        </p>
      ) : isPending ? (
        <p className="text-sm text-ink2">Loading…</p>
      ) : (
        <>
          <p className="text-[13.5px] text-ink2">
            {counts.current} of {counts.total} acknowledged version {currentVersion}
            {counts.blocked > 0 &&
              ` · ${counts.blocked} ${counts.blocked === 1 ? "person has" : "people have"} never acknowledged and cannot clock in`}
          </p>
          <div className="overflow-hidden rounded-xl border border-line">
            <table className="w-full border-collapse text-[13.5px]">
              <caption className="sr-only">
                Acknowledgements by person, {visible.length} shown
              </caption>
              <thead className="hidden bg-sunk text-left text-xs font-medium text-ink3 md:table-header-group">
                <tr className="h-10 border-b border-line">
                  <th className="px-5 font-medium">Person</th>
                  <th className="font-medium">Role</th>
                  <th className="font-medium">Manager</th>
                  <th className="font-medium">Acknowledged</th>
                  <th className="pr-5 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((r) => (
                  <tr
                    key={r.userId}
                    className={cn(
                      "flex flex-col gap-1 border-b border-line px-5 py-3 last:border-0 md:table-row md:h-14 md:p-0",
                      isBlocked(r) && "bg-warnbg",
                    )}
                  >
                    <td className="md:px-5">
                      <span className="flex flex-col">
                        <span className="font-medium">{r.fullName}</span>
                        <span
                          className={cn("text-xs", isBlocked(r) ? "text-warnink" : "text-ink3")}
                        >
                          {r.email}
                        </span>
                      </span>
                    </td>
                    <td>{roleName(r.role)}</td>
                    <td className={isBlocked(r) ? "text-warnink" : "text-ink2"}>
                      {r.managerName ?? "—"}
                    </td>
                    <td className={isBlocked(r) ? "text-warnink" : "text-ink2"}>
                      {r.acknowledgedVersion !== null && r.acknowledgedAt ? (
                        <>
                          Version {r.acknowledgedVersion} · <DateTimeText iso={r.acknowledgedAt} />
                        </>
                      ) : (
                        "Never"
                      )}
                    </td>
                    <td className="md:pr-5">
                      {isBlocked(r) ? (
                        <span className="font-medium text-warnink">Blocked from clocking in</span>
                      ) : r.acknowledgedCurrent ? (
                        <span className="text-ink2">Up to date</span>
                      ) : (
                        <span className="text-ink2">Needs version {currentVersion}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {visible.length === 0 && <p className="p-5 text-sm text-ink2">No one matches.</p>}
          </div>
        </>
      )}
      {exportCsv.error && (
        <p role="alert" className="text-sm text-warnink">
          Couldn't export: {exportCsv.error.message}
        </p>
      )}
    </div>
  );
}
