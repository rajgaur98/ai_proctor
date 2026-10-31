// The Delegation section of the Timesheets tab (#44, TS-14): the manager names a
// delegate approver for a date range (e.g. while on leave), sees the current or
// upcoming one and ends it. A delegate sees who they cover. Past and early-ended
// delegations are listed below (#147).
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { DateTime } from "luxon";
import { useRef } from "react";
import { ExportButton } from "../../components/ExportButton";
import { Button } from "../../components/ui/button";
import { DelegateForm } from "./DelegateForm";
import { DelegationRows, delegationTable } from "./DelegationRows";
import { delegationsQuery, endDelegation } from "./delegationData";

export function Delegation() {
  const { profile } = useRouteContext({ from: "/_app" });
  const queryClient = useQueryClient();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const today = DateTime.now().setZone(profile.timezone).toISODate() ?? "";
  const delegations = useQuery(delegationsQuery());
  const rows = delegations.data ?? [];
  const live = rows.filter((d) => d.status === "upcoming" || d.status === "active");
  const past = rows.filter((d) => d.status === "completed" || d.status === "ended");
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["delegations"] });
  const end = useMutation({ mutationFn: endDelegation, onSuccess: refresh });

  return (
    <section
      aria-labelledby="delegation-title"
      className="overflow-hidden rounded-xl border border-line bg-panel"
    >
      <div className="flex items-center gap-3 border-b border-line px-5 py-3">
        <h2 id="delegation-title" className="text-sm font-semibold">
          Delegation
        </h2>
        <ExportButton
          title="Delegations"
          className="ml-auto h-9"
          ready={!delegations.isPending && !delegations.error}
          spec={{ page: "delegations", filters: {}, table: () => delegationTable(rows) }}
        />
        <Button variant="secondary" className="h-9" onClick={() => dialogRef.current?.showModal()}>
          Set a delegate
        </Button>
      </div>
      {delegations.error ? (
        <p role="alert" className="px-5 py-4 text-sm text-warnink">
          Couldn't load delegations: {delegations.error.message}
        </p>
      ) : delegations.isPending ? (
        <p className="px-5 py-4 text-sm text-ink2">Loading…</p>
      ) : (
        <>
          {live.length === 0 ? (
            <p className="px-5 py-4 text-sm text-ink2">
              No delegate. Name someone to approve for your team while you're away.
            </p>
          ) : (
            <DelegationRows
              rows={live}
              subjectId={profile.id}
              subjectName={null}
              onEnd={(id) => end.mutate(id)}
              ending={end.isPending}
            />
          )}
          {past.length > 0 && (
            <>
              <h3 className="border-t border-line bg-sunk px-5 py-2 text-xs font-medium text-ink3">
                Past delegations
              </h3>
              <DelegationRows rows={past} subjectId={profile.id} subjectName={null} />
            </>
          )}
        </>
      )}
      {end.error && (
        <p role="alert" className="border-t border-line px-5 py-3 text-sm text-warnink">
          {end.error.message}
        </p>
      )}
      <dialog
        ref={dialogRef}
        aria-labelledby="delegation-dialog-title"
        className="m-auto w-[min(480px,calc(100vw-32px))] rounded-xl border border-line bg-panel p-6 text-ink backdrop:bg-black/30"
      >
        <h2 id="delegation-dialog-title" className="mb-4 text-lg font-semibold">
          Set a delegate
        </h2>
        <DelegateForm
          today={today}
          zone={profile.timezone}
          onSet={() => {
            refresh();
            dialogRef.current?.close();
          }}
          onCancel={() => dialogRef.current?.close()}
        />
      </dialog>
    </section>
  );
}
