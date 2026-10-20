// The onboarding window (#48, #59; AGT-03, AGT-04): the four steps of the Onboarding
// design in one window. 1 Notice (the org's monitoring notice), 2 Permissions, 3 Test
// capture, 4 Done. The Rust core decides everything that matters (what is acknowledged,
// which permissions are on, whether a capture worked); this only walks the steps and
// shows them. The core opens it at a step with `onboarding_open`: the first run, a new
// notice version, the tray's "Set up permissions…" or a permission warning's Fix.
import type {
  AgentStatus,
  NoticeContent,
  OnboardingState,
  PermissionKind,
} from "@ai-proctor/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke, listen } from "../ipc";
import { DoneStep } from "./DoneStep";
import { NoticeStep } from "./NoticeStep";
import { noticeFooter } from "./noticeModel";
import {
  type CapturePhase,
  canContinue,
  captureFailed,
  footerButtons,
  type Step,
  stepFooter,
  stepMarks,
  testCaptureShown,
  toStep,
} from "./onboardingModel";
import { PermissionsStep } from "./PermissionsStep";
import { TestCaptureStep } from "./TestCaptureStep";

/** How often the permission step looks again while the window is up. */
const POLL_MS = 1500;

export function OnboardingWindow() {
  const [step, setStep] = useState<Step>(1);
  // undefined: loading; null: the server hasn't sent a notice.
  const [notice, setNotice] = useState<NoticeContent | null | undefined>(undefined);
  const [state, setState] = useState<OnboardingState | null>(null);
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [capture, setCapture] = useState<CapturePhase>({ kind: "idle" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState<PermissionKind | null>(null);
  // The window is up: the permission step only polls then, not while it sits hidden.
  const [open, setOpen] = useState(false);
  // Only the latest test capture counts; an older one that returns late is dropped.
  const attempt = useRef(0);
  // The latest state, for `goTo`, which must not change with every poll.
  const latest = useRef<OnboardingState | null>(null);
  latest.current = state;

  const loadNotice = useCallback(() => {
    invoke("get_notice", {}).then(setNotice, (e: unknown) => setError(String(e)));
  }, []);
  const loadState = useCallback(() => {
    return invoke("onboarding_state", {}).then(
      (next) => {
        latest.current = next;
        setState(next);
        return next;
      },
      (e: unknown) => {
        setError(String(e));
        return null;
      },
    );
  }, []);

  const takeCapture = useCallback(() => {
    const mine = ++attempt.current;
    setCapture({ kind: "capturing" });
    setError(null);
    invoke("test_capture", {}).then(
      (result) => {
        if (attempt.current !== mine) return;
        setCapture({ kind: "done", result });
        loadState();
      },
      (e: unknown) => {
        if (attempt.current !== mine) return;
        setCapture({ kind: "failed", message: String(e) });
      },
    );
  }, [loadState]);

  /** Moves to a step. The test images live only on step 3: leaving drops them. */
  const goTo = useCallback(
    (target: Step) => {
      // Nothing to capture (screenshots and webcam both off): there is no Test capture step.
      const next = target === 3 && !testCaptureShown(latest.current) ? 2 : target;
      setError(null);
      setStep(next);
      if (next === 3) {
        takeCapture();
      } else {
        attempt.current++;
        setCapture({ kind: "idle" });
      }
      if (next === 2) loadState();
    },
    [takeCapture, loadState],
  );

  useEffect(() => {
    loadNotice();
    // A window that loads after the core opened it still starts at the right step.
    loadState().then((next) => {
      if (next) goTo(toStep(next.start_step));
    });
    invoke("get_status", {}).then(setStatus, (e: unknown) => setError(String(e)));
    // The core pushes a status whenever the notice or the shift moves.
    const stopStatus = listen("status_changed", (next) => {
      setStatus(next);
      loadNotice();
    });
    const stopOpen = listen("onboarding_open", ({ step: at }) => {
      setOpen(true);
      goTo(toStep(at));
    });
    // Closed: nothing from a test capture stays in the window.
    const stopClosed = listen("onboarding_closed", () => {
      setOpen(false);
      attempt.current++;
      setCapture({ kind: "idle" });
      setBusy(false);
      setAsking(null);
      setError(null);
    });
    const onFocus = () => {
      setOpen(true);
      loadState();
    };
    window.addEventListener("focus", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      for (const stop of [stopStatus, stopOpen, stopClosed]) stop.then((f) => f());
    };
  }, [loadNotice, loadState, goTo]);

  // Live permission status on step 2.
  useEffect(() => {
    if (step !== 2 || !open) return;
    const id = window.setInterval(loadState, POLL_MS);
    return () => window.clearInterval(id);
  }, [step, open, loadState]);

  async function run(work: () => Promise<{ ok: boolean; error: string | null }>) {
    setBusy(true);
    setError(null);
    try {
      const result = await work();
      if (!result.ok) setError(result.error ?? "Something went wrong.");
      return result.ok;
    } catch (e) {
      setError(String(e));
      return false;
    } finally {
      setBusy(false);
    }
  }

  const close = () => invoke("close_onboarding", {});

  async function acknowledge(version: number) {
    const ok = await run(() => invoke("acknowledge_notice", { version }));
    if (!ok) {
      loadNotice();
      return;
    }
    const next = await loadState();
    // A device that already finished onboarding only needed the new notice read.
    if (next?.completed) await close();
    else goTo(2);
  }

  async function request(kind: PermissionKind) {
    setAsking(kind);
    setError(null);
    try {
      const result = await invoke("request_permission", { kind });
      if (!result.ok) setError(result.error ?? "Couldn't open the settings.");
    } catch (e) {
      setError(String(e));
    } finally {
      setAsking(null);
      loadState();
    }
  }

  async function restart() {
    await run(() => invoke("restart_app", {}));
  }

  const working = status !== null && status.shift !== "off_shift";
  const acknowledged = notice?.acknowledged === true;
  const buttons = footerButtons(step, { acknowledged, capture, working });

  /** "Looks good": remembered on this device, then the last step. */
  async function finish() {
    if (await run(() => invoke("finish_onboarding", {}))) goTo(4);
  }

  /** "Clock in now" goes through the same path as the tray, so the notice gate applies. */
  async function clockIn() {
    if (await run(() => invoke("clock_in", { project_id: null }))) await close();
  }

  function primary() {
    switch (step) {
      case 1:
        if (acknowledged || !notice) goTo(2);
        else acknowledge(notice.version);
        break;
      case 2:
        // With nothing to capture the test step is skipped: the person is done.
        if (testCaptureShown(state)) goTo(3);
        else finish();
        break;
      case 3:
        if (captureFailed(capture)) goTo(2);
        else finish();
        break;
      case 4:
        if (working) close();
        else clockIn();
        break;
    }
  }

  function secondary() {
    switch (step) {
      case 2:
        goTo(1);
        break;
      case 3:
        takeCapture();
        break;
      case 4:
        close();
        break;
    }
  }

  const capturing = capture.kind === "capturing";
  const withCapture = testCaptureShown(state);
  const primaryDisabled =
    busy ||
    (step === 2 && !canContinue(state)) ||
    (step === 3 && capturing) ||
    (step === 1 && notice === undefined);
  const footerNote =
    step === 1 && notice
      ? `${stepFooter(step, withCapture)} · ${noticeFooter(notice).text}`
      : stepFooter(step, withCapture);

  return (
    <main className="notice">
      <nav className="n-steps" aria-label="Setup progress">
        <ol>
          {stepMarks(step, withCapture).map((mark) => (
            <li
              key={mark.step}
              className={`n-step n-step-${mark.state}`}
              aria-current={mark.state === "current" ? "step" : undefined}
            >
              <span className="n-step-circle">{mark.mark}</span>
              <span className="n-step-name">{mark.name}</span>
            </li>
          ))}
        </ol>
      </nav>
      <div className="n-body">
        {step === 1 && <NoticeStep content={notice} />}
        {step === 2 &&
          (state ? (
            <PermissionsStep state={state} busy={asking} onRequest={request} onRestart={restart} />
          ) : (
            <p className="n-state">{error ? `Couldn't load: ${error}` : "Loading…"}</p>
          ))}
        {step === 3 && state && (
          <TestCaptureStep state={state} phase={capture} onRestart={restart} />
        )}
        {step === 4 && <DoneStep platform={state?.platform ?? "macos"} />}
      </div>
      <footer className="n-foot">
        <span className="n-version">{footerNote}</span>
        {error && (
          <p className="n-error" role="alert">
            {error}
          </p>
        )}
        {buttons.secondary && (
          <button
            type="button"
            className="n-secondary"
            disabled={busy || (step === 3 && capturing)}
            onClick={secondary}
          >
            {buttons.secondary}
          </button>
        )}
        <button type="button" className="n-primary" disabled={primaryDisabled} onClick={primary}>
          {busy && step === 1 ? "Saving…" : buttons.primary}
        </button>
      </footer>
    </main>
  );
}
