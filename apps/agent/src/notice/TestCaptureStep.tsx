// Step 3 of the Onboarding design (#59; AGT-03): one real capture through the check-in
// pipeline, shown here and nowhere else. The images are data URLs held in this window's
// state: never uploaded, never stored, dropped when the window closes.
import type { OnboardingState } from "@ai-proctor/contracts";
import { type CapturePhase, captureProblems, screenCaption } from "./onboardingModel";

export function TestCaptureStep({
  state,
  phase,
  onRestart,
}: {
  state: OnboardingState;
  phase: CapturePhase;
  onRestart: () => void;
}) {
  const problems = captureProblems(phase, state.platform, state.screenshots);
  const result = phase.kind === "done" ? phase.result : null;
  const screen = result?.screens[0] ?? null;
  return (
    <>
      <header>
        <h1>Test capture</h1>
        <p className="n-intro">This is what your manager sees on a check-in.</p>
      </header>
      <div
        className={state.screenshots && state.camera_required ? "n-shots" : "n-shots n-shots-one"}
      >
        {state.screenshots && (
          <figure className="n-shot">
            <Preview
              src={screen}
              alt="Your screen, as captured"
              label="screenshot · display 1"
              tall
              capturing={phase.kind === "capturing"}
            />
            <figcaption>{screenCaption(result?.screens.length ?? 1)}</figcaption>
          </figure>
        )}
        {state.camera_required && (
          <figure className="n-shot">
            <Preview
              src={result?.webcam ?? null}
              alt="Your webcam frame, as captured"
              label="webcam frame"
              capturing={phase.kind === "capturing"}
            />
            <figcaption>Webcam · one still frame</figcaption>
          </figure>
        )}
      </div>
      {problems.length > 0 && (
        <div className="n-warn" role="alert">
          {problems.map((text) => (
            <p key={text}>{text}</p>
          ))}
          {result?.restart_needed && (
            <button type="button" className="n-secondary" onClick={onRestart}>
              Quit and reopen AI Proctor
            </button>
          )}
        </div>
      )}
      <div className="n-info">
        <span className="n-i" aria-hidden="true">
          i
        </span>
        <span>
          Only shown here. Not uploaded, not saved, and gone when you close this window. Real
          captures happen only when you pass a check-in, and every one appears in My data.
        </span>
      </div>
    </>
  );
}

function Preview({
  src,
  alt,
  label,
  tall,
  capturing,
}: {
  src: string | null;
  alt: string;
  label: string;
  tall?: boolean;
  capturing: boolean;
}) {
  const size = tall ? "n-preview n-preview-tall" : "n-preview";
  if (src) return <img className={size} src={src} alt={alt} />;
  return (
    <div className={`${size} n-preview-empty`} role="img" aria-label={alt}>
      <span>{capturing ? "Taking it…" : label}</span>
    </div>
  );
}
