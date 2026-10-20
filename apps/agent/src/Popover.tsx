// Tray popover: sign-in (#16) here, the signed-in view (#37) in Tray.tsx.
import type { AgentStatus } from "@ai-proctor/contracts";
import { type FormEvent, useEffect, useState } from "react";
import { invoke, listen } from "./ipc";
import { Tray } from "./Tray";

/** The last status from the core and when it arrived, so the tray can tick time locally. */
interface Snapshot {
  status: AgentStatus;
  receivedAt: number;
}

export function Popover() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const accept = (status: AgentStatus) => setSnapshot({ status, receivedAt: Date.now() });
    invoke("get_status", {}).then(accept, (e: unknown) => setError(String(e)));
    const unlisten = listen("status_changed", accept);
    return () => {
      unlisten.then((stop) => stop());
    };
  }, []);

  if (error) return <main className="popover">Couldn't load status: {error}</main>;
  if (!snapshot) return <main className="popover">Loading…</main>;
  const { status, receivedAt } = snapshot;
  if (!status.signed_in) return <SignIn version={status.agent_version} />;
  return <Tray status={status} receivedAt={receivedAt} />;
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
