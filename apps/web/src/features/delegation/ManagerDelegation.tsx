// An owner's or admin's view of one manager's delegation (#147, TS-14, AUD-01): set a
// delegate for a date range or end the current one on the manager's behalf, and read the
// history (upcoming, active, completed, ended early). Opened from the People page.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { DateTime } from "luxon";
import { Button } from "../../components/ui/button";
import { DelegateForm } from "./DelegateForm";
import { DelegationRows } from "./DelegationRows";
import { delegationsQuery, endDelegation } from "./delegationData";

export function ManagerDelegation({
  manager,
  onClose,
}: {
  manager: { id: string; fullName: string; timezone: string };
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const today = DateTime.now().setZone(manager.timezone).toISODate() ?? "";
  const history = useQuery(delegationsQuery(manager.id));
  const rows = history.data ?? [];
  const live = rows.filter(
    (d) => d.managerId === manager.id && (d.status === "upcoming" || d.status === "active"),
  );
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["delegations"] });
  const end = useMutation({ mutationFn: endDelegation, onSuccess: refresh });

  return (
    <dialog
      ref={(el) => {
        if (el && !el.open) el.showModal();
      }}
      onClose={onClose}
      aria-labelledby="manager-delegation-title"
      className="m-auto max-h-[calc(100vh-32px)] w-[min(560px,calc(100vw-32px))] overflow-y-auto rounded-xl border border-line bg-panel p-6 text-ink backdrop:bg-black/30"
    >
      <div className="flex flex-col gap-4">
        <h2 id="manager-delegation-title" className="text-lg font-semibold">
          Delegation for {manager.fullName}
        </h2>
        <section aria-labelledby="manager-delegation-history" className="flex flex-col gap-2">
          <h3 id="manager-delegation-history" className="text-sm font-semibold">
            History
          </h3>
          <div className="overflow-hidden rounded-xl border border-line">
            {history.error ? (
              <p role="alert" className="px-5 py-4 text-sm text-warnink">
                Couldn't load delegations: {history.error.message}
              </p>
            ) : history.isPending ? (
              <p className="px-5 py-4 text-sm text-ink2">Loading…</p>
            ) : rows.length === 0 ? (
              <p className="px-5 py-4 text-sm text-ink2">No delegations yet.</p>
            ) : (
              <DelegationRows
                rows={rows}
                subjectId={manager.id}
                subjectName={manager.fullName}
                onEnd={(id) => end.mutate(id)}
                ending={end.isPending}
              />
            )}
          </div>
          {end.error && (
            <p role="alert" className="text-sm text-warnink">
              {end.error.message}
            </p>
          )}
        </section>
        <section aria-labelledby="manager-delegation-set" className="flex flex-col gap-3">
          <h3 id="manager-delegation-set" className="text-sm font-semibold">
            New delegation
          </h3>
          {live.length > 0 && (
            <p className="text-[13px] text-ink2">
              {manager.fullName} already has a delegate. Dates that overlap it are refused, so end
              it first to change it.
            </p>
          )}
          <DelegateForm
            managerId={manager.id}
            managerName={manager.fullName}
            today={today}
            zone={manager.timezone}
            onSet={refresh}
          />
        </section>
        <div className="flex">
          <Button type="button" variant="secondary" className="ml-auto" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    </dialog>
  );
}
