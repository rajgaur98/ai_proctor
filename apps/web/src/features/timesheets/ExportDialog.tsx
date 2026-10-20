// The Export CSV dialog of the Timesheets tab (#45, TS-20..23): date range, employee,
// client, project, approval status and view, then a CSV download. The team filter waits
// for teams (ORG-08).
import { EXPORT_VIEWS, type ExportView } from "@ai-proctor/core";
import { useMutation, useQuery } from "@tanstack/react-query";
import { DateTime } from "luxon";
import { useState } from "react";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { clientsQuery, projectsQuery } from "../projects/projectData";
import { downloadExport, exportPeopleQuery, exportViewLabel } from "./exportData";
import { type SheetStatus, statusLabel } from "./timesheetData";

const fieldClass = "h-11 w-full rounded-[9px] border border-line2 bg-panel px-3 text-sm text-ink";
const statuses: SheetStatus[] = ["draft", "submitted", "approved", "returned"];

export function ExportDialog({
  dialogRef,
  defaultFrom,
  defaultTo,
}: {
  dialogRef: React.RefObject<HTMLDialogElement | null>;
  defaultFrom: string;
  defaultTo: string;
}) {
  const [from, setFrom] = useState(defaultFrom);
  const [to, setTo] = useState(defaultTo);
  const [userId, setUserId] = useState("");
  const [clientId, setClientId] = useState("");
  const [projectId, setProjectId] = useState("");
  const [status, setStatus] = useState<SheetStatus | "">("");
  const [view, setView] = useState<ExportView>("daily");
  const [problem, setProblem] = useState<string | null>(null);

  const people = useQuery(exportPeopleQuery);
  const clients = useQuery(clientsQuery);
  const projects = useQuery(projectsQuery);
  const projectChoices = (projects.data ?? []).filter((p) => !clientId || p.clientId === clientId);

  const send = useMutation({
    mutationFn: downloadExport,
    onSuccess: () => dialogRef.current?.close(),
  });

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="export-title"
      className="m-auto w-[min(520px,calc(100vw-32px))] rounded-xl border border-line bg-panel p-6 text-ink backdrop:bg-black/30"
    >
      <form
        method="dialog"
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          setProblem(null);
          const days = DateTime.fromISO(to).diff(DateTime.fromISO(from), "days").days;
          if (!from || !to || !(days >= 0)) {
            setProblem("Choose a start date and an end date that is the same or later.");
            return;
          }
          if (days > 365) {
            setProblem("The range can be up to a year.");
            return;
          }
          send.mutate({ view, from, to, userId, clientId, projectId, status });
        }}
      >
        <h2 id="export-title" className="text-lg font-semibold">
          Export CSV
        </h2>
        <p className="text-[13px] text-ink2">
          Hours come from the same seconds as the timesheets, as decimals and as H:MM. Every export
          is recorded in the audit log.
        </p>
        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="export-from">From</Label>
            <Input
              id="export-from"
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="export-to">To</Label>
            <Input id="export-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="export-view">View</Label>
          <select
            id="export-view"
            value={view}
            onChange={(e) => setView(e.target.value as ExportView)}
            className={fieldClass}
          >
            {EXPORT_VIEWS.map((v) => (
              <option key={v} value={v}>
                {exportViewLabel[v]}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="export-employee">Employee</Label>
          <select
            id="export-employee"
            value={userId}
            onChange={(e) => setUserId(e.target.value)}
            className={fieldClass}
          >
            <option value="">Everyone I can see</option>
            {(people.data ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.full_name}
              </option>
            ))}
          </select>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="export-client">Client</Label>
            <select
              id="export-client"
              value={clientId}
              onChange={(e) => {
                setClientId(e.target.value);
                setProjectId("");
              }}
              className={fieldClass}
            >
              <option value="">All clients</option>
              {(clients.data ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="export-project">Project</Label>
            <select
              id="export-project"
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
              className={fieldClass}
            >
              <option value="">All projects</option>
              {projectChoices.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
        </div>
        <p className="-mt-2 text-[12.5px] text-ink3">
          Choosing a client or project leaves out time without a project.
        </p>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="export-status">Approval status</Label>
          <select
            id="export-status"
            value={status}
            onChange={(e) => setStatus(e.target.value as SheetStatus | "")}
            className={fieldClass}
          >
            <option value="">Any</option>
            {statuses.map((s) => (
              <option key={s} value={s}>
                {statusLabel[s]}
              </option>
            ))}
          </select>
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
            {send.isPending ? "Exporting…" : "Download CSV"}
          </Button>
        </div>
      </form>
    </dialog>
  );
}
