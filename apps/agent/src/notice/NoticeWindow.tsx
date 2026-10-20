// The monitoring notice (#48; AGT-04, AGT-05): step 1 of the Onboarding design. Shown
// after sign-in until the person acknowledges, and again when the org publishes a new
// version. The text comes from the Rust core; "I've read this" sends the version on
// screen, and the core refuses it if a newer one has arrived meanwhile.
import type { NoticeContent } from "@ai-proctor/contracts";
import { useCallback, useEffect, useState } from "react";
import { invoke, listen } from "../ipc";
import { noticeFooter, noticeIntro, noticeRows } from "./noticeModel";

export function NoticeWindow() {
  // undefined: loading; null: the server hasn't sent a notice.
  const [content, setContent] = useState<NoticeContent | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    invoke("get_notice", {}).then(setContent, (e: unknown) => setError(String(e)));
  }, []);

  useEffect(() => {
    load();
    // The core pushes a status whenever the notice moves (a new version, an acknowledgement).
    const unlisten = listen("status_changed", load);
    return () => {
      unlisten.then((stop) => stop());
    };
  }, [load]);

  async function acknowledge(version: number) {
    setBusy(true);
    setError(null);
    try {
      const result = await invoke("acknowledge_notice", { version });
      if (!result.ok) {
        setError(result.error ?? "Something went wrong.");
        load();
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  if (content === undefined) {
    return (
      <main className="notice">
        <p className="n-state">{error ? `Couldn't load the notice: ${error}` : "Loading…"}</p>
      </main>
    );
  }
  if (content === null) {
    return (
      <main className="notice">
        <p className="n-state">There is no notice to review yet.</p>
      </main>
    );
  }

  const footer = noticeFooter(content);
  return (
    <main className="notice">
      <div className="n-body">
        <header>
          <h1>Monitoring notice</h1>
          <p className="n-intro">{noticeIntro(content.body)}</p>
        </header>
        <dl className="n-table">
          {noticeRows(content.body).map((row) => (
            <div className="n-row" key={row.key}>
              <dt>{row.label}</dt>
              <dd>{row.text}</dd>
            </div>
          ))}
        </dl>
      </div>
      <footer className="n-foot">
        <span className="n-version">{footer.text}</span>
        {error && (
          <p className="n-error" role="alert">
            {error}
          </p>
        )}
        {footer.canAcknowledge && (
          <button
            type="button"
            className="n-primary"
            disabled={busy}
            onClick={() => acknowledge(content.version)}
          >
            {busy ? "Saving…" : "I’ve read this"}
          </button>
        )}
      </footer>
    </main>
  );
}
