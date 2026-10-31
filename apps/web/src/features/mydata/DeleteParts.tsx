// "Delete…" on one of the employee's own check-ins (#253, EMP-06): they pick any of the
// webcam frame, the screen captures, the minute's apps and its browser domains, see
// exactly what will go, and confirm. The delete-checkin-parts function removes the files
// from Storage and the rows, and logs it (AUD-01). The check-in still counts as passed;
// the manager's day view says what was removed, by whom and when.
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "../../components/ui/button";
import { callFunction } from "../../lib/functions";
import type { Part } from "../day/removedText";
import { type PartOption, pickedParts } from "./partOptions";

async function deleteCheckinParts(checkinId: string, parts: Part[]): Promise<void> {
  await callFunction(
    "delete-checkin-parts",
    { checkin_id: checkinId, parts },
    "The deletion failed. Try again.",
  );
}

export function DeletePartsDialog({
  checkinId,
  time,
  options,
  onClose,
}: {
  checkinId: string;
  /** When the check-in was shown, HH:mm. */
  time: string;
  options: PartOption[];
  onClose: () => void;
}) {
  const [picked, setPicked] = useState<Set<Part>>(new Set());
  const queryClient = useQueryClient();
  const run = useMutation({
    mutationFn: () => deleteCheckinParts(checkinId, pickedParts(picked)),
    // The row, its app and the day's activity change.
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["my-data"] }),
  });
  const chosen = options.filter((o) => picked.has(o.part));
  const toggle = (part: Part, on: boolean) => {
    const next = new Set(picked);
    if (on) next.add(part);
    else next.delete(part);
    setPicked(next);
  };
  const titleId = `delete-parts-${checkinId}`;

  return (
    <dialog
      ref={(el) => {
        if (el && !el.open) el.showModal();
      }}
      onClose={onClose}
      // A running deletion isn't cancelled by Escape.
      onCancel={(e) => run.isPending && e.preventDefault()}
      aria-labelledby={titleId}
      className="m-auto w-[min(520px,calc(100vw-32px))] rounded-xl border border-line bg-panel p-6 text-ink backdrop:bg-black/30"
    >
      <form
        method="dialog"
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (chosen.length > 0 && !run.isPending && !run.isSuccess) run.mutate();
        }}
      >
        <h2 id={titleId} className="text-lg font-semibold">
          Delete from the {time} check-in
        </h2>

        {run.isSuccess ? (
          <p role="status" className="text-sm">
            Deleted. The check-in still counts as passed, and the audit log has an entry for it.
          </p>
        ) : (
          <>
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-1 text-sm text-ink2">Pick what to delete.</legend>
              {options.map((o) => (
                <label key={o.part} className="flex min-h-9 items-center gap-2.5 text-sm">
                  <input
                    type="checkbox"
                    className="h-4 w-4"
                    checked={picked.has(o.part)}
                    disabled={run.isPending}
                    onChange={(e) => toggle(o.part, e.target.checked)}
                  />
                  {o.label}
                </label>
              ))}
              <Button
                type="button"
                variant="secondary"
                className="h-9 self-start"
                disabled={run.isPending || chosen.length === options.length}
                onClick={() => setPicked(new Set(options.map((o) => o.part)))}
              >
                Delete all of it
              </Button>
            </fieldset>
            {chosen.length > 0 && (
              <div className="flex flex-col gap-1.5 text-sm text-ink2">
                <p>This deletes, and it can't be undone:</p>
                <ul className="list-disc pl-5">
                  {chosen.map((o) => (
                    <li key={o.part}>{o.detail}</li>
                  ))}
                </ul>
                <p>
                  The check-in still counts as passed and your time is unchanged. Your manager sees
                  what you deleted and when, not what it showed.
                </p>
              </div>
            )}
          </>
        )}

        {run.error && (
          <p role="alert" className="text-sm text-warnink">
            {run.error.message}
          </p>
        )}

        <div className="flex gap-2">
          {run.isSuccess ? (
            <Button type="button" className="ml-auto" onClick={onClose}>
              Close
            </Button>
          ) : (
            <>
              <Button
                type="button"
                variant="secondary"
                className="ml-auto"
                disabled={run.isPending}
                onClick={onClose}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={chosen.length === 0 || run.isPending}>
                {run.isPending ? "Deleting…" : "Delete for good"}
              </Button>
            </>
          )}
        </div>
      </form>
    </dialog>
  );
}
