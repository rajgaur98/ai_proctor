// Signed-in tray popover (#37, EMP-01): clock in/out, break, pause, project and task
// (#268), the missed check-in reason and permission warnings. Status and timesheets come
// from the Rust core; this only displays them and sends commands.
import type {
  AgentStatus,
  CommandResult,
  MissedCheckin,
  ProjectRef,
  TaskRef,
} from "@ai-proctor/contracts";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { invoke } from "./ipc";
import {
  blankToNull,
  breakChoices,
  type ChipKind,
  canSaveMissReason,
  checkinOutcomeText,
  chipLabel,
  countdownAnnouncement,
  formatClock,
  formatCountdown,
  formatDay,
  formatDuration,
  liveWorkedSeconds,
  MISS_NOTE_MAX,
  type MissReasonKind,
  missReasons,
  PAUSE_REASON_MAX,
  type PermissionIssue,
  pauseAllowance,
  pauseMinutes,
  projectLabel,
  secondsSince,
  secondsUntil,
  taskChoices,
  trayView,
} from "./trayModel";
import "./tray.css";

/** Current time, refreshed every `intervalMs`. */
function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

/** Runs a command and keeps its busy flag and inline error (`CommandResult.error`). */
function useCommand() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async (call: () => Promise<CommandResult>): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      const result = await call();
      if (!result.ok) setError(result.error ?? "Something went wrong.");
      return result.ok;
    } catch (e) {
      setError(String(e));
      return false;
    } finally {
      setBusy(false);
    }
  }, []);
  const reset = useCallback(() => setError(null), []);
  return { run, busy, error, reset };
}

export function Tray({ status, receivedAt }: { status: AgentStatus; receivedAt: number }) {
  const view = trayView(status);
  // The pause countdown ticks every second; everything else is minutes, so 30 s is enough.
  const now = useNow(view.phase === "paused" ? 1000 : 30_000);

  return (
    <main className="tray">
      <div className="t-head">
        <Logo />
        <span className="t-name">AI Proctor</span>
        <span className="t-date">{formatDay(now)}</span>
      </div>
      <div className="t-body">
        {view.issues.map((issue) => (
          <PermissionBanner key={issue.kind} issue={issue} />
        ))}
        {view.accessibility && <AccessibilityBanner />}
        {view.notice === "review" && <NoticeReview />}
        {view.missed && <MissedCard missed={view.missed} />}
        {view.phase === "off_shift" && (
          <OffShift status={status} chip={view.chip} noticeRequired={view.notice === "required"} />
        )}
        {view.phase === "working" && (
          <Working status={status} chip={view.chip} receivedAt={receivedAt} now={now} />
        )}
        {view.phase === "paused" && <Paused status={status} chip={view.chip} now={now} />}
        {view.phase === "on_break" && <OnBreak status={status} chip={view.chip} now={now} />}
      </div>
      <Footer status={status} />
    </main>
  );
}

function Logo() {
  return (
    <span className="t-logo" aria-hidden="true">
      <span className="hand-v" />
      <span className="hand-h" />
    </span>
  );
}

function Chip({ kind }: { kind: ChipKind }) {
  return (
    <span className="t-chip">
      <span className={`dot dot-${kind}`} aria-hidden="true" />
      {chipLabel[kind]}
    </span>
  );
}

function InlineError({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p className="t-error" role="alert">
      {message}
    </p>
  );
}

function Figure({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <div className="t-label">{label}</div>
      <div className="t-figure">{children}</div>
    </div>
  );
}

function Allowance({ status }: { status: AgentStatus }) {
  const allowance = pauseAllowance(status.pause_used_today_s, status.pause_daily_cap_s);
  return (
    <div className="t-allowance">
      <div className="row">
        <span className="t-muted">Pause allowance</span>
        <span className="num">{allowance.text}</span>
      </div>
      <div className="bar" aria-hidden="true">
        <div className="fill" style={{ width: `${allowance.leftPercent}%` }} />
      </div>
    </div>
  );
}

function ProjectSelect({
  id,
  value,
  projects,
  onChange,
  disabled,
}: {
  id: string;
  value: string;
  projects: ProjectRef[];
  onChange: (projectId: string) => void;
  disabled?: boolean;
}) {
  return (
    <span className="t-select">
      <select id={id} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
        <option value="">No project</option>
        {projects.map((p) => (
          <option key={p.id} value={p.id}>
            {projectLabel(p)}
          </option>
        ))}
      </select>
    </span>
  );
}

function TaskSelect({
  id,
  value,
  tasks,
  onChange,
  disabled,
}: {
  id: string;
  value: string;
  tasks: TaskRef[];
  onChange: (taskId: string) => void;
  disabled?: boolean;
}) {
  return (
    <span className="t-select">
      <select id={id} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
        <option value="">No task</option>
        {tasks.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name}
          </option>
        ))}
      </select>
    </span>
  );
}

function PermissionBanner({ issue }: { issue: PermissionIssue }) {
  const open = useCommand();
  return (
    <div className="t-warn">
      <div className="msg">
        <span className="mark" aria-hidden="true">
          !
        </span>
        {issue.restricted ? (
          <p>
            <strong>{issue.label} is turned off by your device management.</strong> Your manager
            sees “Capture blocked”. Ask your IT admin to allow it.
          </p>
        ) : (
          <p>
            <strong>{issue.label} permission is off.</strong> Your manager sees “Capture blocked”.
          </p>
        )}
      </div>
      {!issue.restricted && (
        <button
          type="button"
          className="btn btn-warn"
          disabled={open.busy}
          onClick={() => open.run(() => invoke("show_onboarding", { step: 2 }))}
        >
          Fix
        </button>
      )}
      <InlineError message={open.error} />
    </div>
  );
}

/** Optional Accessibility (browser domains, #169): says what is lost, not "Capture blocked". */
function AccessibilityBanner() {
  const open = useCommand();
  return (
    <div className="t-warn">
      <div className="msg">
        <span className="mark" aria-hidden="true">
          !
        </span>
        <p>
          <strong>Accessibility is off.</strong> The websites you use in your browser aren’t
          recorded. This is optional.
        </p>
      </div>
      <button
        type="button"
        className="btn btn-warn"
        disabled={open.busy}
        onClick={() => open.run(() => invoke("show_onboarding", { step: 2 }))}
      >
        Set up
      </button>
      <InlineError message={open.error} />
    </div>
  );
}

function MissedCard({ missed }: { missed: MissedCheckin }) {
  const [kind, setKind] = useState<MissReasonKind | null>(null);
  const [note, setNote] = useState("");
  const save = useCommand();
  const ready = canSaveMissReason(kind, note);

  return (
    <section className="t-card t-missed" aria-labelledby="missed-title">
      <div>
        <h2 id="missed-title">You missed a check-in at {formatClock(missed.at)}</h2>
        <p className="t-small">
          A reason makes it clear on your timesheet. Your manager will see it.
        </p>
      </div>
      <fieldset className="t-picks">
        <legend>Add a reason</legend>
        <div className="wrap">
          {missReasons.map((r) => (
            <button
              key={r.kind}
              type="button"
              className="btn btn-pick"
              aria-pressed={kind === r.kind}
              onClick={() => setKind(kind === r.kind ? null : r.kind)}
            >
              {r.label}
            </button>
          ))}
        </div>
      </fieldset>
      <div className="t-field">
        <label htmlFor="miss-note">Note (optional)</label>
        <input
          id="miss-note"
          type="text"
          maxLength={MISS_NOTE_MAX}
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </div>
      <button
        type="button"
        className="btn btn-primary"
        disabled={!ready || save.busy}
        onClick={() =>
          save.run(() =>
            invoke("set_miss_reason", {
              checkin_id: missed.id,
              kind,
              note: blankToNull(note),
            }),
          )
        }
      >
        {save.busy ? "Saving…" : "Save reason"}
      </button>
      <InlineError message={save.error} />
    </section>
  );
}

/** AGT-05: a newer notice version is waiting; work carries on under the one acknowledged. */
function NoticeReview() {
  const open = useCommand();
  return (
    <section className="t-card t-note" aria-labelledby="notice-review-title">
      <strong id="notice-review-title">The monitoring notice changed</strong>
      <span>Review it. Until you do, what is collected stays as you acknowledged it.</span>
      <button
        type="button"
        className="btn btn-outline"
        disabled={open.busy}
        onClick={() => open.run(() => invoke("show_notice", {}))}
      >
        Review the notice
      </button>
      <InlineError message={open.error} />
    </section>
  );
}

/** AGT-04: nothing is collected, and nobody clocks in, before the first acknowledgement. */
function NoticeRequired() {
  const open = useCommand();
  return (
    <>
      <div className="t-card t-note">
        <strong>Review the monitoring notice</strong>
        <span>
          Read what AI Proctor collects and acknowledge it. Nothing is collected before that, and
          you can't clock in yet.
        </span>
      </div>
      <button
        type="button"
        className="btn btn-primary btn-big"
        disabled={open.busy}
        onClick={() => open.run(() => invoke("show_notice", {}))}
      >
        Review the monitoring notice
      </button>
      <InlineError message={open.error} />
    </>
  );
}

function OffShift({
  status,
  chip,
  noticeRequired,
}: {
  status: AgentStatus;
  chip: ChipKind;
  noticeRequired: boolean;
}) {
  const [projectId, setProjectId] = useState(status.project?.id ?? "");
  const clockIn = useCommand();

  return (
    <>
      <div className="t-row-between">
        <Chip kind={chip} />
      </div>
      <div>
        <div className="t-title">Not clocked in</div>
        <p className="t-sub">Nothing is collected while you're off shift.</p>
      </div>
      {noticeRequired ? (
        <NoticeRequired />
      ) : (
        <>
          <div className="t-field">
            <label htmlFor="clock-in-project">
              Project <span className="t-faint">(optional)</span>
            </label>
            <ProjectSelect
              id="clock-in-project"
              value={projectId}
              projects={status.projects}
              onChange={setProjectId}
              disabled={clockIn.busy}
            />
          </div>
          <button
            type="button"
            className="btn btn-primary btn-big"
            disabled={clockIn.busy}
            onClick={() => clockIn.run(() => invoke("clock_in", { project_id: projectId || null }))}
          >
            {clockIn.busy ? "Clocking in…" : "Clock in"}
          </button>
          <InlineError message={clockIn.error} />
        </>
      )}
    </>
  );
}

function Working({
  status,
  chip,
  receivedAt,
  now,
}: {
  status: AgentStatus;
  chip: ChipKind;
  receivedAt: number;
  now: number;
}) {
  const [sheet, setSheet] = useState<"break" | "pause" | null>(null);
  const clockOut = useCommand();
  const worked = liveWorkedSeconds(status.worked_today_s, receivedAt, now, true);

  return (
    <>
      <div className="t-row-between">
        <Chip kind={chip} />
        {status.clocked_in_at && (
          <span className="t-meta">Clocked in {formatClock(status.clocked_in_at)}</span>
        )}
      </div>
      <Figure label="Time today">{formatDuration(worked)}</Figure>
      <InfoRows status={status} />
      {sheet === "break" ? (
        <BreakSheet onCancel={() => setSheet(null)} />
      ) : sheet === "pause" ? (
        <PauseSheet onCancel={() => setSheet(null)} />
      ) : (
        <div className="t-grid2">
          <button type="button" className="btn btn-outline" onClick={() => setSheet("break")}>
            Break
          </button>
          <button type="button" className="btn btn-outline" onClick={() => setSheet("pause")}>
            Pause
          </button>
        </div>
      )}
      <Allowance status={status} />
      <div className="t-bottom">
        <button
          type="button"
          className="btn btn-quiet"
          disabled={clockOut.busy}
          onClick={() => clockOut.run(() => invoke("clock_out", {}))}
        >
          {clockOut.busy ? "Clocking out…" : "Clock out"}
        </button>
        <InlineError message={clockOut.error} />
      </div>
    </>
  );
}

/** Project (with Switch), its task when it has tasks (#268), and the last check-in. */
function InfoRows({ status }: { status: AgentStatus }) {
  const [switching, setSwitching] = useState(false);
  const change = useCommand();
  const last = status.last_checkin;

  async function switchTo(projectId: string) {
    if (await change.run(() => invoke("switch_project", { project_id: projectId || null }))) {
      setSwitching(false);
    }
  }

  return (
    <div className="t-card t-info">
      <div className="line">
        {switching ? (
          <>
            <label className="key" htmlFor="switch-project">
              Project
            </label>
            <ProjectSelect
              id="switch-project"
              value={status.project?.id ?? ""}
              projects={status.projects}
              onChange={switchTo}
              disabled={change.busy}
            />
            <button
              type="button"
              className="btn btn-text"
              onClick={() => {
                setSwitching(false);
                change.reset();
              }}
            >
              Cancel
            </button>
          </>
        ) : (
          <>
            <span className="key">Project</span>
            <span className="val">
              {status.project ? projectLabel(status.project) : "No project"}
            </span>
            <button type="button" className="btn btn-text" onClick={() => setSwitching(true)}>
              Switch
            </button>
          </>
        )}
      </div>
      {change.error && (
        <div className="line">
          <InlineError message={change.error} />
        </div>
      )}
      {/* #268 (PRJ-05): only when the current project has tasks. */}
      {!switching && taskChoices(status).length > 0 && <TaskLine status={status} />}
      {last && (
        <div className="line">
          <span className="key">Last check-in</span>
          <span className="mono">{formatClock(last.at)}</span>
          <span className="t-muted">· {checkinOutcomeText(last.outcome)}</span>
        </div>
      )}
    </div>
  );
}

/** The current project's task, with Change: same project, new task (#268, PRJ-05). */
function TaskLine({ status }: { status: AgentStatus }) {
  const [changing, setChanging] = useState(false);
  const change = useCommand();

  async function changeTo(taskId: string) {
    if (await change.run(() => invoke("switch_task", { task_id: taskId || null }))) {
      setChanging(false);
    }
  }

  return (
    <>
      <div className="line">
        {changing ? (
          <>
            <label className="key" htmlFor="switch-task">
              Task
            </label>
            <TaskSelect
              id="switch-task"
              value={status.task?.id ?? ""}
              tasks={taskChoices(status)}
              onChange={changeTo}
              disabled={change.busy}
            />
            <button
              type="button"
              className="btn btn-text"
              onClick={() => {
                setChanging(false);
                change.reset();
              }}
            >
              Cancel
            </button>
          </>
        ) : (
          <>
            <span className="key">Task</span>
            <span className="val">{status.task ? status.task.name : "No task"}</span>
            <button type="button" className="btn btn-text" onClick={() => setChanging(true)}>
              Change
            </button>
          </>
        )}
      </div>
      {change.error && (
        <div className="line">
          <InlineError message={change.error} />
        </div>
      )}
    </>
  );
}

function BreakSheet({ onCancel }: { onCancel: () => void }) {
  const start = useCommand();
  return (
    <section className="t-sheet" aria-labelledby="break-title">
      <h2 id="break-title">Start a break</h2>
      <div className="t-grid2">
        {breakChoices.map((c) => (
          <button
            key={c.label}
            type="button"
            className="btn btn-outline"
            disabled={start.busy}
            onClick={() => start.run(() => invoke("break_start", { planned_min: c.planned_min }))}
          >
            {c.label}
          </button>
        ))}
      </div>
      <InlineError message={start.error} />
      <button type="button" className="btn btn-text" onClick={onCancel}>
        Cancel
      </button>
    </section>
  );
}

function PauseSheet({ onCancel }: { onCancel: () => void }) {
  const [reason, setReason] = useState("");
  const start = useCommand();
  return (
    <section className="t-sheet" aria-labelledby="pause-title">
      <h2 id="pause-title">Pause for</h2>
      <div className="t-grid3">
        {pauseMinutes.map((minutes) => (
          <button
            key={minutes}
            type="button"
            className="btn btn-outline"
            disabled={start.busy}
            onClick={() =>
              start.run(() => invoke("pause_start", { minutes, reason: blankToNull(reason) }))
            }
          >
            {minutes} min
          </button>
        ))}
      </div>
      <div className="t-field">
        <label htmlFor="pause-reason">Private note (only you see it)</label>
        <input
          id="pause-reason"
          type="text"
          maxLength={PAUSE_REASON_MAX}
          placeholder="Optional"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </div>
      <InlineError message={start.error} />
      <button type="button" className="btn btn-text" onClick={onCancel}>
        Cancel
      </button>
    </section>
  );
}

function Paused({ status, chip, now }: { status: AgentStatus; chip: ChipKind; now: number }) {
  const resume = useCommand();
  const extend = useCommand();
  const left = secondsUntil(status.pause_ends_at, now);
  const since = secondsSince(status.phase_started_at, now);
  const worked = formatDuration(status.worked_today_s);

  return (
    <>
      <div className="t-row-between">
        <Chip kind={chip} />
        {status.pause_planned_min !== null && (
          <span className="t-meta">{status.pause_planned_min} min pause</span>
        )}
      </div>
      <Figure label="Paused">
        {left !== null ? (
          <>
            <span aria-hidden="true">{formatCountdown(left)}</span>{" "}
            <span className="t-unit" aria-hidden="true">
              left
            </span>
            {/* Changes once a minute, so a screen reader isn't told every second. */}
            <span className="sr-only" aria-live="polite">
              {countdownAnnouncement(left)}
            </span>
          </>
        ) : (
          formatDuration(since ?? 0)
        )}
      </Figure>
      <div className="t-card t-note">
        <strong>Nothing is being collected</strong>
        <span>
          No check-ins, screenshots or activity until you resume. Time today stays at {worked}.
        </span>
      </div>
      <button
        type="button"
        className="btn btn-primary btn-big"
        disabled={resume.busy}
        onClick={() => resume.run(() => invoke("pause_end", {}))}
      >
        Resume
      </button>
      <InlineError message={resume.error} />
      <div className="t-extend">
        <span className="t-muted">Extend</span>
        <div className="t-grid3">
          {pauseMinutes.map((minutes) => (
            <button
              key={minutes}
              type="button"
              className="btn btn-outline btn-small"
              disabled={extend.busy}
              aria-label={`Extend the pause by ${minutes} minutes`}
              onClick={() => extend.run(() => invoke("pause_start", { minutes, reason: null }))}
            >
              +{minutes} min
            </button>
          ))}
        </div>
        <InlineError message={extend.error} />
      </div>
      <Allowance status={status} />
      <p className="t-bottom t-hint">You'll be set back to Active when the pause ends.</p>
    </>
  );
}

function OnBreak({ status, chip, now }: { status: AgentStatus; chip: ChipKind; now: number }) {
  const end = useCommand();
  const elapsed = secondsSince(status.phase_started_at, now);

  return (
    <>
      <div className="t-row-between">
        <Chip kind={chip} />
        {status.phase_started_at && (
          <span className="t-meta">Started {formatClock(status.phase_started_at)}</span>
        )}
      </div>
      <Figure label="On break">{formatDuration(elapsed ?? 0)}</Figure>
      <div className="t-card t-note">
        <strong>Nothing is being collected on break</strong>
        <span>Breaks aren't counted as worked time.</span>
      </div>
      <button
        type="button"
        className="btn btn-primary btn-big"
        disabled={end.busy}
        onClick={() => end.run(() => invoke("break_end", {}))}
      >
        End break
      </button>
      <InlineError message={end.error} />
      <div className="t-bottom t-total">
        <span>Time today</span>
        <span className="mono">{formatDuration(status.worked_today_s)}</span>
      </div>
    </>
  );
}

function Footer({ status }: { status: AgentStatus }) {
  const cmd = useCommand();
  return (
    <div className="t-foot">
      <button
        type="button"
        className="btn btn-text"
        onClick={() => cmd.run(() => invoke("open_link", { target: "my_data" }))}
      >
        My data
      </button>
      <button
        type="button"
        className="btn btn-text"
        onClick={() => cmd.run(() => invoke("open_link", { target: "notice" }))}
      >
        Monitoring notice
      </button>
      <span className="account">
        <span
          className="email"
          title={`${status.account_email ?? "Signed in"} · v${status.agent_version}`}
        >
          {status.account_email ?? "Signed in"}
        </span>
        <button
          type="button"
          className="btn btn-quiet-small"
          disabled={cmd.busy}
          onClick={() => cmd.run(() => invoke("sign_out", {}))}
        >
          Sign out
        </button>
      </span>
      {cmd.error && (
        <p className="t-error foot-error" role="alert">
          {cmd.error}
        </p>
      )}
    </div>
  );
}
