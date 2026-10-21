// The form that names a delegate for a date range (#44, TS-14), for the viewer or, for an
// owner or admin, on a manager's behalf (#147). Shown in a dialog on the Timesheets tab and
// inline in the manager's delegation dialog on the People page.
import { useMutation, useQuery } from "@tanstack/react-query";
import { DateTime } from "luxon";
import { useState } from "react";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { candidatesQuery, setDelegation } from "./delegationData";
import { rangeProblem } from "./range";

const fieldClass = "h-11 w-full rounded-[9px] border border-line2 bg-panel px-3 text-sm text-ink";

export function DelegateForm({
  managerId,
  managerName,
  today,
  zone,
  onSet,
  onCancel,
}: {
  /** Who the delegation is for when it is not the viewer. */
  managerId?: string;
  managerName?: string;
  /** Today in the manager's time zone (ISO date). */
  today: string;
  zone: string;
  onSet: () => void;
  onCancel?: () => void;
}) {
  const candidates = useQuery(candidatesQuery(managerId));
  const [form, setForm] = useState({
    delegateId: "",
    startsOn: today,
    endsOn: DateTime.fromISO(today).plus({ days: 6 }).toISODate() ?? today,
  });
  const [problem, setProblem] = useState<string | null>(null);
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));

  const send = useMutation({
    mutationFn: () => setDelegation(form.delegateId, form.startsOn, form.endsOn, managerId),
    onSuccess: () => {
      set({ delegateId: "" });
      onSet();
    },
  });

  function submit() {
    setProblem(null);
    if (!form.delegateId) {
      setProblem(`Choose who approves for ${managerName ?? "you"}.`);
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
    <form
      method="dialog"
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <p className="text-[13px] text-ink2">
        {managerName ? `${managerName}'s` : "Your"} delegate can see and approve{" "}
        {managerName ? "their" : "your"} team's timesheets and manual entries on these days, both
        included. Dates are in {zone}. It can be ended at any time.
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
        {onCancel && (
          <Button
            type="button"
            variant="secondary"
            className="ml-auto"
            onClick={() => {
              setProblem(null);
              send.reset();
              onCancel();
            }}
          >
            Cancel
          </Button>
        )}
        <Button type="submit" className={onCancel ? "" : "ml-auto"} disabled={send.isPending}>
          {send.isPending ? "Saving…" : "Set delegate"}
        </Button>
      </div>
    </form>
  );
}
