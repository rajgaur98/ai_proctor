// The check-in card (#20). Shows what the Rust core sends and reports clicks; the
// core judges them. The window never takes keyboard focus (NSPanel, spike #11),
// and nothing here is reachable from the keyboard either (CHK-11).
import type { CardChallenge, CardClickResult } from "@ai-proctor/contracts";
import { type MouseEvent, useEffect, useState } from "react";
import { invoke, listen } from "../ipc";

export function CheckInCard() {
  const [card, setCard] = useState<CardChallenge | null>(null);
  const [left, setLeft] = useState(0);
  const [result, setResult] = useState<CardClickResult | null>(null);

  useEffect(() => {
    const unlisten = listen("card_challenge", (next) => {
      setCard((previous) => {
        if (previous?.card_id !== next.card_id) {
          setResult(null);
          if (next.sound) chime();
        }
        return next;
      });
      setLeft(next.remaining_s);
    });
    // Keys never reach a non-key panel; if one ever does, it does nothing.
    const swallow = (e: KeyboardEvent) => e.preventDefault();
    window.addEventListener("keydown", swallow, true);
    return () => {
      unlisten.then((stop) => stop());
      window.removeEventListener("keydown", swallow, true);
    };
  }, []);

  useEffect(() => {
    if (!card || result) return;
    const timer = setInterval(() => setLeft((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(timer);
  }, [card, result]);

  if (!card) return <main className="card" />;

  async function click(value: number, e: MouseEvent) {
    if (!card || result) return;
    const reply = await invoke("card_click", {
      card_id: card.card_id,
      value,
      trusted: e.isTrusted,
    });
    if (reply === "pass" || reply === "failed") setResult(reply);
  }

  if (result) {
    return (
      <main className="card done">
        <p className="ask">{result === "pass" ? "Thanks, you're checked in" : "Check-in failed"}</p>
      </main>
    );
  }

  return (
    <main className="card">
      <header>
        <span>Check-in</span>
        <span className="left" role="timer" aria-label={`${left} seconds left`}>
          {formatLeft(left)}
        </span>
      </header>
      <p className="ask">Click {card.target}</p>
      <div className="options">
        {card.options.map((n) => (
          <button
            key={`${card.card_id}-${card.wrong_clicks}-${n}`}
            type="button"
            tabIndex={-1}
            onMouseDown={(e) => e.preventDefault()}
            onClick={(e) => click(n, e)}
          >
            {n}
          </button>
        ))}
      </div>
      <footer>
        <span className="note" role="status">
          {card.wrong_clicks > 0 ? "Wrong number. Try again." : (card.project ?? "No project")}
        </span>
        <button
          type="button"
          className="link"
          tabIndex={-1}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => invoke("card_switch_project", {})}
        >
          Switch project
        </button>
      </footer>
    </main>
  );
}

function formatLeft(s: number): string {
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** A short two-note chime (CHK-22 optional sound). */
function chime() {
  try {
    const audio = new AudioContext();
    for (const [i, hz] of [660, 880].entries()) {
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      const at = audio.currentTime + i * 0.15;
      osc.frequency.value = hz;
      gain.gain.setValueAtTime(0.15, at);
      gain.gain.exponentialRampToValueAtTime(0.001, at + 0.14);
      osc.connect(gain).connect(audio.destination);
      osc.start(at);
      osc.stop(at + 0.15);
    }
  } catch {
    // No audio device: the card still shows.
  }
}
