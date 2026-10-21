// The Export dialog of the Timesheets tab (#45, #65, TS-20..23): date range, employee,
// team (#202), client, project, approval status, view and format, then a CSV or XLSX
// download. The XLSX highlights overtime (TS-19); the CSV is plain.
import { EXPORT_FORMATS, EXPORT_VIEWS, type ExportFormat, type ExportView } from "@ai-proctor/core";
import { useMutation, useQuery } from "@tanstack/react-query";
import { DateTime } from "luxon";
import { useState } from "react";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { Segmented } from "../policy/fields";
import { clientsQuery, projectsQuery } from "../projects/projectData";
import { teamsQuery } from "../teams/teamData";
import {
  downloadExport,
  exportFormatLabel,
  exportPeopleQuery,
  exportViewLabel,
} from "./exportData";
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
  const [teamId, setTeamId] = useState("");
  const [clientId, setClientId] = useState("");
  const [projectId, setProjectId] = useState("");
  const [status, setStatus] = useState<SheetStatus | "">("");
  const [view, setView] = useState<ExportView>("daily");
  const [format, setFormat] = useState<ExportFormat>("csv");
  const [problem, setProblem] = useState<string | null>(null);

  const people = useQuery(exportPeopleQuery);
  const teams = useQuery(teamsQuery);
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
          send.mutate({ view, format, from, to, userId, teamId, clientId, projectId, status });
        }}
      >
        <h2 id="export-title" className="text-lg font-semibold">
          Export timesheets
        </h2>
        <p className="text-[13px] text-ink2">
          Hours come from the same seconds as the timesheets, as decimals and as H:MM. Every export
          is recorded in the audit log.
        </p>
        <div className="flex flex-col gap-1.5">
          <span aria-hidden="true" className="text-[13px] font-medium text-ink2">
            Format
          </span>
          <Segmented
            label="Format"
            value={format}
            options={EXPORT_FORMATS.map((f) => [f, exportFormatLabel[f]] as const)}
            onChange={setFormat}
          />
          {format === "xlsx" && (
            <p className="text-[12.5px] text-ink3">
              Days and weeks above the overtime thresholds in Policy are highlighted. Nothing is
              paid or deducted.
            </p>
          )}
        </div>
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
        <div className="grid grid-cols-2 gap-3">
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
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="export-team">Team</Label>
            <select
              id="export-team"
              value={teamId}
              onChange={(e) => setTeamId(e.target.value)}
              className={fieldClass}
            >
              <option value="">All teams</option>
              {(teams.data ?? []).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </div>
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
            {send.isPending ? "Exporting…" : `Download ${exportFormatLabel[format]}`}
          </Button>
        </div>
      </form>
    </dialog>
  );
}
