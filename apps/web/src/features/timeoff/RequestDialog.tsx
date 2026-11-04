// The employee's request for time off (#304, LV-03): a type, whole days or part of one
// day, and an optional note. Dates and times are the person's own (their profile's time
// zone), as the database reads them.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { DateTime } from "luxon";
import { useId, useState } from "react";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { leaveTypesQuery, requestLeave } from "./timeOffData";

const fieldClass = "h-11 w-full rounded-[9px] border border-line2 bg-panel px-3 text-sm text-ink";

/** What's wrong with the form before it goes to the database, or null. */
export function requestProblem(f: {
  typeId: string;
  partDay: boolean;
  firstDay: string;
  lastDay: string;
  start: string;
  end: string;
}): string | null {
  if (!f.typeId) return "Choose a type of leave.";
  if (!f.firstDay) return "Choose a date.";
  if (f.partDay) {
    if (!f.start || !f.end) return "Choose a start and an end time.";
    if (f.end <= f.start) return "The end time is after the start time.";
    return null;
  }
  if (!f.lastDay) return "Choose the last day.";
  if (f.lastDay < f.firstDay) return "The last day is on or after the first day.";
  return null;
}

export function RequestDialog({ zone, onClose }: { zone: string; onClose: () => void }) {
  const id = useId();
  const queryClient = useQueryClient();
  const types = (useQuery(leaveTypesQuery).data ?? []).filter((t) => !t.archived);
  const today = DateTime.now().setZone(zone).toISODate() ?? "";
  const [form, setForm] = useState({
    typeId: "",
    partDay: false,
    firstDay: today,
    lastDay: today,
    start: "13:00",
    end: "17:00",
    note: "",
  });
  const [problem, setProblem] = useState<string | null>(null);
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));
  const typeId = form.typeId || types[0]?.id || "";

  const send = useMutation({
    mutationFn: () =>
      requestLeave({
        typeId,
        firstDay: form.firstDay,
        lastDay: form.partDay ? form.firstDay : form.lastDay,
        partDay: form.partDay ? { start: form.start, end: form.end } : null,
        note: form.note,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["leave-requests"] });
      onClose();
    },
  });

  return (
    <dialog
      ref={(el) => {
        if (el && !el.open) el.showModal();
      }}
      onClose={onClose}
      aria-labelledby={`${id}-title`}
      className="m-auto w-[min(520px,calc(100vw-32px))] rounded-xl border border-line bg-panel p-6 text-ink backdrop:bg-black/30"
    >
      <form
        method="dialog"
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          const p = requestProblem({ ...form, typeId });
          setProblem(p);
          if (!p) send.mutate();
        }}
      >
        <h2 id={`${id}-title`} className="text-lg font-semibold">
          Request time off
        </h2>
        <p className="text-[13px] text-ink2">
          Your manager approves or declines it. Dates and times are in {zone}.
        </p>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-type`}>Type</Label>
          <select
            id={`${id}-type`}
            className={fieldClass}
            value={typeId}
            onChange={(e) => set({ typeId: e.target.value })}
          >
            {types.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
                {t.paid ? "" : " (unpaid)"}
              </option>
            ))}
          </select>
        </div>
        <fieldset className="flex flex-wrap gap-4">
          <legend className="mb-1.5 text-[13px] font-medium text-ink2">How long</legend>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name={`${id}-length`}
              checked={!form.partDay}
              onChange={() => set({ partDay: false })}
              className="h-4 w-4"
            />
            Whole days
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name={`${id}-length`}
              checked={form.partDay}
              onChange={() => set({ partDay: true })}
              className="h-4 w-4"
            />
            Part of a day
          </label>
        </fieldset>
        {form.partDay ? (
          <div className="grid grid-cols-3 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${id}-day`}>Date</Label>
              <Input
                id={`${id}-day`}
                type="date"
                required
                value={form.firstDay}
                onChange={(e) => set({ firstDay: e.target.value })}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${id}-start`}>From</Label>
              <Input
                id={`${id}-start`}
                type="time"
                required
                value={form.start}
                onChange={(e) => set({ start: e.target.value })}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${id}-end`}>To</Label>
              <Input
                id={`${id}-end`}
                type="time"
                required
                value={form.end}
                onChange={(e) => set({ end: e.target.value })}
              />
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${id}-first`}>First day</Label>
              <Input
                id={`${id}-first`}
                type="date"
                required
                value={form.firstDay}
                onChange={(e) =>
                  set({
                    firstDay: e.target.value,
                    lastDay: form.lastDay < e.target.value ? e.target.value : form.lastDay,
                  })
                }
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${id}-last`}>Last day</Label>
              <Input
                id={`${id}-last`}
                type="date"
                required
                min={form.firstDay}
                value={form.lastDay}
                onChange={(e) => set({ lastDay: e.target.value })}
              />
            </div>
          </div>
        )}
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-note`}>Note (optional)</Label>
          <textarea
            id={`${id}-note`}
            rows={3}
            maxLength={500}
            value={form.note}
            onChange={(e) => set({ note: e.target.value })}
            className="rounded-[9px] border border-line2 bg-panel p-3 text-sm text-ink"
          />
        </div>
        {(problem || send.error) && (
          <p role="alert" className="text-sm text-warnink">
            {problem ?? send.error?.message}
          </p>
        )}
        <div className="flex gap-2">
          <Button type="button" variant="secondary" className="ml-auto" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={send.isPending || types.length === 0}>
            {send.isPending ? "Sending…" : "Send request"}
          </Button>
        </div>
      </form>
    </dialog>
  );
}
