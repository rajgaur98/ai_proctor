// Step 4 of the Onboarding design (#59): "You're set."
import type { OnboardingPlatform } from "@ai-proctor/contracts";
import { trayName } from "./onboardingModel";

export function DoneStep({ platform }: { platform: OnboardingPlatform }) {
  return (
    <div className="n-done">
      <span className="n-check" aria-hidden="true" />
      <div>
        <h1>You're set.</h1>
        <p className="n-done-sub">Clock in when you start work.</p>
      </div>
      <div className="n-menubar" aria-hidden="true">
        <span className="n-bar n-bar-26" />
        <span className="n-bar n-bar-18" />
        <span className="n-menubar-icon" />
        <span className="n-menubar-time">Tue 09:01</span>
      </div>
      <p className="n-done-note">AI Proctor lives in your {trayName(platform)}.</p>
    </div>
  );
}
