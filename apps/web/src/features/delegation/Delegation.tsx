// The Delegation section of the Timesheets tab (#44, TS-14): the manager names a
// delegate approver for a date range (e.g. while on leave), sees the current or
// upcoming one and ends it. A delegate sees who they cover.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { DateTime } from "luxon";
import { useRef, useState } from "react";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import {
  candidatesQuery,
  type Delegation as DelegationRow,
  delegationsQuery,
  endDelegation,
  setDelegation,
} from "./delegationData";
import { rangeLabel, rangeProblem } from "./range";

const fieldClass = "h-11 w-full rounded-[9px] border border-line2 bg-panel px-3 text-sm text-ink";

export function Delegation() {
  const { profile } = useRouteContext({ from: "/_app" });
  const queryClient = useQueryClient();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const today = DateTime.now().setZone(profile.timezone).toISODate() ?? "";
  const delegations = useQuery(delegationsQuery);
  const given = (delegations.data ?? []).filter((d) => d.managerId === profile.id);
  const received = (delegations.data ?? []).filter((d) => d.delegateId === profile.id);
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
        <Button
          variant="secondary"
          className="ml-auto h-9"
          onClick={() => dialogRef.current?.showModal()}
        >
          Set a delegate
        </Button>
      </div>
      {delegations.error ? (
        <p role="alert" className="px-5 py-4 text-sm text-warnink">
          Couldn't load delegations: {delegations.error.message}
        </p>
      ) : delegations.isPending ? (
        <p className="px-5 py-4 text-sm text-ink2">Loading…</p>
      ) : given.length === 0 && received.length === 0 ? (
        <p className="px-5 py-4 text-sm text-ink2">
          No delegate. Name someone to approve for your team while you're away.
        </p>
      ) : (
        <ul>
          {given.map((d) => (
            <li
              key={d.id}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-5 py-3 text-[13.5px] last:border-0"
            >
              <span>
                <span className="font-medium">{d.delegateName}</span> approves for you
              </span>
              <span className="text-ink2">{rangeLabel(d.startsOn, d.endsOn)}</span>
              <span className="text-ink3">{d.startsOn > today ? "Upcoming" : "Active"}</span>
              <Button
                variant="secondary"
                className="ml-auto h-9"
                aria-label={`End delegation to ${d.delegateName}`}
                disabled={end.isPending}
                onClick={() => end.mutate(d.id)}
              >
                End
              </Button>
            </li>
          ))}
          {received.map((d) => (
            <ReceivedRow key={d.id} d={d} today={today} />
          ))}
        </ul>
      )}
      {end.error && (
        <p role="alert" className="border-t border-line px-5 py-3 text-sm text-warnink">
          {end.error.message}
        </p>
      )}
      <DelegateDialog dialogRef={dialogRef} today={today} zone={profile.timezone} onSet={refresh} />
    </section>
  );
}

function ReceivedRow({ d, today }: { d: DelegationRow; today: string }) {
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-5 py-3 text-[13.5px] last:border-0">
      <span>
        You approve for <span className="font-medium">{d.managerName}</span>
      </span>
      <span className="text-ink2">{rangeLabel(d.startsOn, d.endsOn)}</span>
      <span className="text-ink3">{d.startsOn > today ? "Upcoming" : "Active"}</span>
    </li>
  );
}

function DelegateDialog({
  dialogRef,
  today,
  zone,
  onSet,
}: {
  dialogRef: React.RefObject<HTMLDialogElement | null>;
  today: string;
  zone: string;
  onSet: () => void;
}) {
  const candidates = useQuery(candidatesQuery);
  const [form, setForm] = useState({
    delegateId: "",
    startsOn: today,
    endsOn: DateTime.fromISO(today).plus({ days: 6 }).toISODate() ?? today,
  });
  const [problem, setProblem] = useState<string | null>(null);
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));

  const send = useMutation({
    mutationFn: () => setDelegation(form.delegateId, form.startsOn, form.endsOn),
    onSuccess: () => {
      onSet();
      dialogRef.current?.close();
    },
  });

  function submit() {
    setProblem(null);
    if (!form.delegateId) {
      setProblem("Choose who approves for you.");
      return;
    }
    const range = rangeProblem(form.startsOn, form.endsOn, today);
    if (range) {
      setProblem(range);
      return;
    }
    send.mutate();
  }

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="delegation-dialog-title"
      className="m-auto w-[min(480px,calc(100vw-32px))] rounded-xl border border-line bg-panel p-6 text-ink backdrop:bg-black/30"
    >
      <form
        method="dialog"
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <h2 id="delegation-dialog-title" className="text-lg font-semibold">
          Set a delegate
        </h2>
        <p className="text-[13px] text-ink2">
          Your delegate can see and approve your team's timesheets and manual entries on these days,
          both included. Dates are in {zone}. You can end it at any time.
        </p>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="delegate-person">Delegate</Label>
          <select
            id="delegate-person"
            value={form.delegateId}
            onChange={(e) => set({ delegateId: e.target.value })}
            className={fieldClass}
          >
            <option value="">Choose a person</option>
            {(candidates.data ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.fullName}
              </option>
            ))}
          </select>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="delegate-from">From</Label>
            <Input
              id="delegate-from"
              type="date"
              required
              min={today}
              value={form.startsOn}
              onChange={(e) => set({ startsOn: e.target.value })}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="delegate-to">To</Label>
            <Input
              id="delegate-to"
              type="date"
              required
              min={form.startsOn || today}
              value={form.endsOn}
              onChange={(e) => set({ endsOn: e.target.value })}
            />
          </div>
        </div>
        {(problem || send.error) && (
          <p role="alert" className="text-sm text-warnink">
            {problem ?? send.error?.message}
          </p>
        )}
        <div className="flex gap-2">
          <Button
            type="button"
            variant="secondary"
            className="ml-auto"
            onClick={() => {
              setProblem(null);
              send.reset();
              dialogRef.current?.close();
            }}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={send.isPending}>
            {send.isPending ? "Saving…" : "Set delegate"}
          </Button>
        </div>
      </form>
    </dialog>
  );
}
