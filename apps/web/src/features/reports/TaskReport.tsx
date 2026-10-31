// Reports grouped by task (#269, DSH-10): worked and flagged time per project, and under
// each project per task in the project's order, then "No task". The same people and
// seconds as the per-person report.
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { projectsQuery, tasksQuery } from "../projects/projectData";
import { formatDuration } from "../timesheets/summary";
import { taskReportQuery } from "./reportData";
import { groupByTask } from "./taskGroups";

export function TaskReport({ from, to, teamId }: { from: string; to: string; teamId: string }) {
  const rows = useQuery(taskReportQuery(from, to, teamId));
  const projects = useQuery(projectsQuery);
  const tasks = useQuery(tasksQuery);
  const report = useMemo(
    () =>
      rows.data && projects.data && tasks.data
        ? groupByTask(rows.data, projects.data, tasks.data)
        : null,
    [rows.data, projects.data, tasks.data],
  );
  const error = rows.error ?? projects.error ?? tasks.error;

  if (error) {
    return (
      <p role="alert" className="text-sm text-warnink">
        Couldn't load the report: {error.message}
      </p>
    );
  }
  if (!report) return <p className="text-sm text-ink2">Loading…</p>;
  if (report.projects.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 rounded-xl border border-line bg-panel px-6 py-16 text-center">
        <p className="text-base font-semibold">No time logged</p>
        <p className="max-w-[380px] text-[13.5px] text-ink2">
          Nobody in this view has worked or flagged time on these dates. Try another team or range.
        </p>
      </div>
    );
  }

  const cell = "px-3 text-right font-mono text-[13px] whitespace-nowrap";
  return (
    <>
      <div className="overflow-hidden rounded-xl border border-line bg-panel">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] border-collapse text-[13.5px]">
            <caption className="sr-only">
              Worked and flagged time per project and task, {from} to {to}
            </caption>
            <thead className="bg-sunk text-left text-xs font-medium text-ink3">
              <tr className="h-11 border-b border-line">
                <th scope="col" className="px-5 font-medium">
                  Project and task
                </th>
                <th scope="col" className="px-3 text-right font-medium">
                  Worked
                </th>
                <th scope="col" className="px-3 text-right font-medium">
                  Flagged
                </th>
                <th scope="col" className="px-5 text-right font-medium">
                  People
                </th>
              </tr>
            </thead>
            {report.projects.map((p) => (
              <tbody key={p.projectId ?? ""} className="border-b border-line">
                <tr className="h-12">
                  <th scope="row" className="px-5 text-left font-semibold">
                    {p.name}
                  </th>
                  <td className={`${cell} font-semibold`}>{formatDuration(p.workedS)}</td>
                  <td className={cell}>{formatDuration(p.flaggedS)}</td>
                  <td className={`${cell} pr-5`}>{p.people}</td>
                </tr>
                {p.tasks.map((t) => (
                  <tr key={t.taskId ?? ""} className="h-11 text-ink2">
                    <th scope="row" className="pr-5 pl-10 text-left font-normal">
                      <span className="sr-only">{p.name} › </span>
                      {t.name}
                    </th>
                    <td className={cell}>{formatDuration(t.workedS)}</td>
                    <td className={cell}>{formatDuration(t.flaggedS)}</td>
                    <td className={`${cell} pr-5`}>{t.people}</td>
                  </tr>
                ))}
              </tbody>
            ))}
            <tfoot>
              <tr className="h-12 bg-sunk font-semibold">
                <th scope="row" className="px-5 text-left">
                  Total
                </th>
                <td className={cell}>{formatDuration(report.total.workedS)}</td>
                <td className={cell}>{formatDuration(report.total.flaggedS)}</td>
                <td className={`${cell} pr-5`}>{report.total.people}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>
      <p className="text-[12.5px] text-ink3">
        The same worked and flagged time as the report by person, split by project and task. Project
        time nobody tagged with a task is under No task; time without a project is Unassigned. A
        person who worked on several tasks counts once in each and once in the project.
      </p>
    </>
  );
}
