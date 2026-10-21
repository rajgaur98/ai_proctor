// CHK-15: a card's size and style vary a little from card to card, so an auto-clicker
// can't find the buttons by matching a saved picture. The core picks the look within the
// design's limits (`CardLook` in agent_core::checkin) and sizes the window; this turns
// the rest into the CSS variables card.css reads.
import type { CardLook } from "@ai-proctor/contracts";
import type { CSSProperties } from "react";

/** The design's button fills a card picks from; all keep the accent numbers readable. */
export const TINTS = ["var(--bg)", "var(--sunk)", "var(--accsoft)"] as const;

export function lookStyle(look: CardLook): CSSProperties {
  return {
    "--card-radius": `${look.radius}px`,
    "--card-padding": `${look.padding}px`,
    "--card-gap": `${look.gap}px`,
    "--button-height": `${look.button_height}px`,
    "--digit-size": `${look.digit_size}px`,
    "--button-fill": TINTS[look.tint] ?? TINTS[0],
  } as CSSProperties;
}
