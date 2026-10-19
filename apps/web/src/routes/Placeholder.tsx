import { useRouteContext } from "@tanstack/react-router";
import { Time } from "../lib/time";

/** Pages that land in later issues; the shell, routing and access already work. */
export function Placeholder({ title, issue }: { title: string; issue: number }) {
  const { profile } = useRouteContext({ from: "/_app" });
  return (
    <section className="flex flex-col gap-2">
      <h1 className="text-2xl font-semibold tracking-[-0.025em]">{title}</h1>
      <p className="text-sm text-ink2">
        Built in #{issue}. Signed in as {profile.fullName} ({profile.role}) at{" "}
        <Time iso={new Date().toISOString()} employeeZone={profile.timezone} />.
      </p>
    </section>
  );
}
