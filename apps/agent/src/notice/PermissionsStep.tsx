// Step 2 of the Onboarding design (#59; AGT-03): one card per permission with its live
// status, a stylised picture of the settings pane (HTML and CSS, no screenshots), the
// three instructions and the button that asks the OS and opens the right settings page.
import type { OnboardingState, PermissionKind } from "@ai-proctor/contracts";
import {
  needsRestart,
  type PermissionCard,
  permissionCards,
  permissionsHeading,
} from "./onboardingModel";

interface Props {
  state: OnboardingState;
  busy: PermissionKind | null;
  onRequest: (kind: PermissionKind) => void;
  onRestart: () => void;
}

export function PermissionsStep({ state, busy, onRequest, onRestart }: Props) {
  const cards = permissionCards(state);
  const hasOptional = cards.some((c) => c.optional);
  return (
    <>
      <header>
        <h1>{permissionsHeading(cards)}</h1>
        <p className="n-intro">
          {state.platform === "windows"
            ? "Windows asks nothing for the screen. AI Proctor only uses the camera during a check-in you pass."
            : "macOS asks once. AI Proctor only uses Screen Recording and Camera during a check-in you pass."}
          {hasOptional && " Accessibility is optional: you can skip it and carry on."}
        </p>
      </header>
      {needsRestart(state) && (
        <div className="n-warn" role="alert">
          <p>
            <strong>Screen Recording is on, but macOS applies it only to a fresh start.</strong>{" "}
            Quit and reopen AI Proctor, then it picks up here.
          </p>
          <button type="button" className="n-secondary" onClick={onRestart}>
            Quit and reopen AI Proctor
          </button>
        </div>
      )}
      <div className={`n-perms ${permsLayout(cards.length)}`}>
        {cards.map((card) => (
          <PermissionCardView
            key={card.kind}
            card={card}
            busy={busy === card.kind}
            onRequest={() => onRequest(card.kind)}
          />
        ))}
      </div>
    </>
  );
}

/** One card is centred, two sit side by side, three share the row. */
function permsLayout(count: number): string {
  if (count > 2) return "n-perms-three";
  return count === 1 ? "n-perms-one" : "";
}

function PermissionCardView({
  card,
  busy,
  onRequest,
}: {
  card: PermissionCard;
  busy: boolean;
  onRequest: () => void;
}) {
  return (
    <section className="n-perm" aria-labelledby={`perm-${card.kind}`}>
      <div className="n-perm-head">
        <h2 id={`perm-${card.kind}`}>
          {card.name}
          {card.optional && <span className="n-optional"> · Optional</span>}
        </h2>
        <span className="n-pill" aria-live="polite">
          <span className={card.on ? "n-dot n-dot-on" : "n-dot n-dot-off"} aria-hidden="true" />
          {card.status}
        </span>
      </div>
      <SettingsPicture card={card} />
      {card.note && <p className="n-perm-note">{card.note}</p>}
      <ol className="n-perm-steps">
        {card.steps.map((text) => (
          <li key={text}>{text}</li>
        ))}
      </ol>
      {card.cta ? (
        <button type="button" className="n-primary n-block" disabled={busy} onClick={onRequest}>
          {card.cta}
        </button>
      ) : (
        <button type="button" className="n-secondary n-block" disabled>
          {card.on ? "Granted" : card.status}
        </button>
      )}
    </section>
  );
}

/** The design's stylised settings pane: a sidebar with Privacy & Security picked and the app's switch. */
function SettingsPicture({ card }: { card: PermissionCard }) {
  return (
    <div className="n-pane" aria-hidden="true">
      <div className="n-pane-side">
        <span className="n-bar n-bar-70" />
        <span className="n-bar n-bar-55" />
        <span className="n-pane-pick">Privacy &amp; Security</span>
        <span className="n-bar n-bar-62" />
      </div>
      <div className="n-pane-main">
        <span className="n-pane-title">{card.pane}</span>
        <div className="n-pane-row">
          <span className="n-app" />
          <span>AI Proctor</span>
          <span className={card.on ? "n-switch n-switch-on" : "n-switch"}>
            <span className="n-knob" />
          </span>
        </div>
        <div className="n-pane-row n-pane-other">
          <span className="n-app n-app-other" />
          <span className="n-bar n-bar-40" />
        </div>
      </div>
    </div>
  );
}
