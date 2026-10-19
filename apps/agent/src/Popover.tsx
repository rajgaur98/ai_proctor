// Tray popover skeleton (#15) with sign-in (#16). The full popover (clock, break,
// pause, project) is #37.
import type { AgentStatus, PermissionState, ShiftState } from "@ai-proctor/contracts";
import { type FormEvent, useEffect, useState } from "react";
import { invoke, listen } from "./ipc";

const shiftLabel: Record<ShiftState, string> = {
  off_shift: "Off shift",
  working: "Working",
  on_break: "On break",
  paused: "Paused",
};

const permissionLabel: Record<PermissionState, string> = {
  granted: "Allowed",
  denied: "Blocked",
  not_determined: "Not set up",
  restricted: "Restricted",
  unsupported: "Not available yet",
};

export function Popover() {
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    invoke("get_status", {}).then(setStatus, (e: unknown) => setError(String(e)));
    const unlisten = listen("status_changed", setStatus);
    return () => {
      unlisten.then((stop) => stop());
    };
  }, []);

  if (error) return <main className="popover">Couldn't load status: {error}</main>;
  if (!status) return <main className="popover">Loading…</main>;
  if (!status.signed_in) return <SignIn version={status.agent_version} />;

  return (
    <main className="popover">
      <header>
        <span className="title">AI Proctor</span>
        <span className="status">{shiftLabel[status.shift]}</span>
      </header>
      <section>
        <h2>Permissions</h2>
        <dl>
          <dt>Screen recording</dt>
          <dd>{permissionLabel[status.permissions.screen]}</dd>
          <dt>Camera</dt>
          <dd>{permissionLabel[status.permissions.camera]}</dd>
        </dl>
      </section>
      <footer className="account">
        <span>
          {status.account_email ?? "Signed in"} · v{status.agent_version}
        </span>
        <SignOut />
      </footer>
    </main>
  );
}

// Magic link (#16): the email opens aiproctor://auth on this computer, which
// signs the agent in; status_changed then swaps this view out.
function SignIn({ version }: { version: string }) {
  const [email, setEmail] = useState("");
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send(e: FormEvent) {
    e.preventDefault();
    setSending(true);
    setError(null);
    try {
      const result = await invoke("sign_in_start", { email });
      if (result.ok) setSentTo(email.trim());
      else setError(result.error);
    } catch (e) {
      setError(String(e));
    } finally {
      setSending(false);
    }
  }

  return (
    <main className="popover">
      <header>
        <span className="title">AI Proctor</span>
      </header>
      {sentTo ? (
        <section className="sign-in">
          <h2>Check your email</h2>
          <p>
            We sent a sign-in link to <strong>{sentTo}</strong>. Open it on this computer.
          </p>
          <button type="button" className="link" onClick={() => setSentTo(null)}>
            Use a different email
          </button>
        </section>
      ) : (
        <form className="sign-in" onSubmit={send}>
          <h2>Sign in</h2>
          <label htmlFor="email">Work email</label>
          <input
            id="email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <button type="submit" disabled={sending}>
            {sending ? "Sending…" : "Email me a sign-in link"}
          </button>
        </form>
      )}
      <footer>v{version}</footer>
    </main>
  );
}

function SignOut() {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className="link"
      disabled={busy}
      onClick={() => {
        setBusy(true);
        invoke("sign_out", {}).finally(() => setBusy(false));
      }}
    >
      Sign out
    </button>
  );
}
