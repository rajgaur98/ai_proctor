// The employee's reason for one of their own missed check-ins (CHK-23, #252): a quick
// pick and a typed remark, in a small dialog opened from My data or their own day page.
// The rule is the tray's: a pick or a remark, and "Other" needs a remark. The server
// checks it again, refuses an approved week and audit-logs every change.
import { useMutation } from "@tanstack/react-query";
import { useId, useRef, useState } from "react";
import { Button } from "../../components/ui/button";
import { Label } from "../../components/ui/label";
import { MISS_REMARK_MAX, type MissReasonKind, missReasonProblem, missReasons } from "./helpers";
import { setMissReason } from "./queries";

const dialogClass =
  "m-auto w-[min(480px,calc(100vw-32px))] rounded-xl border border-line bg-panel p-6 text-ink backdrop:bg-black/30";

const asKind = (kind: string | null): MissReasonKind | null =>
  missReasons.find((r) => r.kind === kind)?.kind ?? null;

/** "Add a reason" (none yet) or "Edit reason", and the dialog it opens. */
export function MissReasonEdit({
  checkinId,
  time,
  kind,
  remark,
  onSaved,
}: {
  checkinId: string;
  /** The miss's time as shown, for the button's accessible name and the title. */
  time: string;
  kind: string | null;
  remark: string | null;
  onSaved: () => void | Promise<unknown>;
}) {
  const id = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [pick, setPick] = useState<MissReasonKind | null>(null);
  const [text, setText] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () => setMissReason(checkinId, pick, text.trim() || null),
    onSuccess: async () => {
      await onSaved();
      dialogRef.current?.close();
    },
  });
  const hasReason = !!kind || !!remark?.trim();

  function open() {
    setPick(asKind(kind));
    setText(remark ?? "");
    setProblem(null);
    save.reset();
    dialogRef.current?.showModal();
  }

  return (
    <>
      <Button
        type="button"
        variant="secondary"
        aria-label={`${hasReason ? "Edit the reason" : "Add a reason"} for the ${time} miss`}
        onClick={open}
      >
        {hasReason ? "Edit" : "Add a reason"}
      </Button>
      <dialog ref={dialogRef} aria-labelledby={`${id}-title`} className={dialogClass}>
        <form
          method="dialog"
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            const why = missReasonProblem(pick, text);
            setProblem(why);
            if (!why) save.mutate();
          }}
        >
          <h2 id={`${id}-title`} className="text-lg font-semibold">
            Reason for the {time} miss
          </h2>
          <p className="text-[13px] text-ink2">
            Your manager sees it next to the miss. You can change it until the week is approved.
          </p>
          <fieldset className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0">
            <legend className="mb-2 text-[13px] font-medium">Reason</legend>
            <div className="flex flex-wrap gap-1.5">
              {missReasons.map((r) => (
                <button
                  key={r.kind}
                  type="button"
                  aria-pressed={pick === r.kind}
                  onClick={() => setPick(pick === r.kind ? null : r.kind)}
                  className={`h-11 rounded-[9px] px-3.5 text-[13.5px] font-medium text-ink ${
                    pick === r.kind
                      ? "border-[1.5px] border-acc bg-accsoft"
                      : "border border-line2 bg-panel"
                  }`}
                >
                  {r.label}
                </button>
              ))}
            </div>
          </fieldset>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${id}-remark`}>
              Remark {pick === "other" ? "(needed for Other)" : "(optional)"}
            </Label>
            <textarea
              id={`${id}-remark`}
              rows={4}
              maxLength={MISS_REMARK_MAX}
              value={text}
              aria-describedby={`${id}-count`}
              onChange={(e) => setText(e.target.value)}
              className="rounded-[9px] border border-line2 bg-panel p-3 text-sm text-ink"
            />
            <span id={`${id}-count`} className="self-end text-xs text-ink3 tabular-nums">
              {text.length} / {MISS_REMARK_MAX}
            </span>
          </div>
          {(problem || save.error) && (
            <p role="alert" className="text-sm text-warnink">
              {problem ?? save.error?.message}
            </p>
          )}
          <div className="flex gap-2">
            <Button
              type="button"
              variant="secondary"
              className="ml-auto"
              onClick={() => dialogRef.current?.close()}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={save.isPending}>
              {save.isPending ? "Saving…" : "Save reason"}
            </Button>
          </div>
        </form>
      </dialog>
    </>
  );
}
