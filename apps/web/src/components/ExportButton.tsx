// The Export button of a list page (#255, TS-20 extended, AUD-01) and its dialog: pick
// CSV or XLSX and download what the page shows with its current filters. The export is
// recorded in the audit log before the file is saved. A page adds it with a few lines:
//
//   <ExportButton title="People" spec={{ page: "people", filters: { search },
//     table: () => peopleTable(visible) }} />
//
// A page with several tables (the day view: check-ins, segments, apps) passes `choices`
// instead: the dialog then asks which table, and each is its own file and audit row.
import { useMutation } from "@tanstack/react-query";
import { useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Segmented } from "../features/policy/fields";
import {
  activeFilters,
  EXPORT_FORMAT_LABEL,
  EXPORT_FORMATS,
  type ExportFormat,
} from "../lib/exportFile";
import { type ExportSpec, runExport } from "../lib/exports";
import { Button } from "./ui/button";

/** One of the tables a page with several offers. */
export interface ExportChoice {
  /** The table, as the page calls it: "Check-ins". */
  label: string;
  spec: ExportSpec;
  /** As ExportButton's `ready`, for this table. */
  ready?: boolean;
}

export function ExportButton({
  title,
  ready = true,
  className,
  ...source
}: {
  /** What is exported, as the page calls it: "People", "Enrollment tokens". */
  title: string;
  /**
   * False while the page's rows are loading (or failed to): the dialog opens but its
   * Download waits. The Export button itself never flips between enabled and disabled.
   */
  ready?: boolean;
  /** Extra classes for the button, e.g. a smaller height in a section header. */
  className?: string;
} & ({ spec: ExportSpec; choices?: never } | { choices: ExportChoice[]; spec?: never })) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [format, setFormat] = useState<ExportFormat>("csv");
  const [picked, setPicked] = useState(0);
  const choices: ExportChoice[] = source.spec
    ? [{ label: title, spec: source.spec }]
    : (source.choices ?? []);
  const choice = choices[picked] ?? choices[0];
  const canDownload = ready && !!choice && (choice.ready ?? true);
  const send = useMutation({
    mutationFn: () => {
      if (!choice) throw new Error("Nothing to export.");
      return runExport(choice.spec, format);
    },
    onSuccess: () => dialogRef.current?.close(),
  });
  const filters = Object.entries(activeFilters(choice?.spec.filters ?? {}));
  const what = title.toLowerCase();

  return (
    <>
      <Button
        variant="secondary"
        className={className}
        aria-label={`Export ${what}`}
        onClick={() => {
          send.reset();
          dialogRef.current?.showModal();
        }}
      >
        Export
      </Button>
      {createPortal(
        // In <body>, so a page can place the button inside a form or another dialog.
        <dialog
          ref={dialogRef}
          aria-labelledby={titleId}
          className="m-auto w-[min(480px,calc(100vw-32px))] rounded-xl border border-line bg-panel p-6 text-ink backdrop:bg-black/30"
        >
          <form
            method="dialog"
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              send.mutate();
            }}
          >
            <h2 id={titleId} className="text-lg font-semibold">
              Export {what}
            </h2>
            <p className="text-[13px] text-ink2">
              {filters.length === 0
                ? "Everything this page lists for you, without filters."
                : "What this page lists for you, with its current filters:"}
            </p>
            {filters.length > 0 && (
              <ul className="-mt-2 flex flex-col gap-0.5 text-[13px]">
                {filters.map(([key, value]) => (
                  <li key={key}>
                    <span className="text-ink2">{key}:</span> {value}
                  </li>
                ))}
              </ul>
            )}
            {source.choices && (
              <div className="flex flex-col gap-1.5">
                <span aria-hidden="true" className="text-[13px] font-medium text-ink2">
                  Table
                </span>
                <Segmented
                  label="Table"
                  value={String(picked)}
                  options={source.choices.map((c, i) => [String(i), c.label] as const)}
                  onChange={(v) => {
                    setPicked(Number(v));
                    send.reset();
                  }}
                />
              </div>
            )}
            <div className="flex flex-col gap-1.5">
              <span aria-hidden="true" className="text-[13px] font-medium text-ink2">
                Format
              </span>
              <Segmented
                label="Format"
                value={format}
                options={EXPORT_FORMATS.map((f) => [f, EXPORT_FORMAT_LABEL[f]] as const)}
                onChange={setFormat}
              />
            </div>
            <p className="text-[12.5px] text-ink3">
              Every export is recorded in the audit log, with its filters and row count.
            </p>
            {send.error && (
              <p role="alert" className="text-sm text-warnink">
                {send.error.message}
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
              <Button type="submit" disabled={!canDownload || send.isPending}>
                {!canDownload
                  ? "Loading…"
                  : send.isPending
                    ? "Exporting…"
                    : `Download ${EXPORT_FORMAT_LABEL[format]}`}
              </Button>
            </div>
          </form>
        </dialog>,
        document.body,
      )}
    </>
  );
}
