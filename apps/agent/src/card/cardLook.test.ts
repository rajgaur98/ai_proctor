import { describe, expect, it } from "vitest";
import { lookStyle } from "./cardLook";

const look = {
  width: 352,
  height: 226,
  radius: 9,
  padding: 18,
  gap: 15,
  button_height: 58,
  digit_size: 27,
  tint: 2,
};

describe("card look (CHK-15)", () => {
  it("turns the core's look into the card's CSS variables", () => {
    expect(lookStyle(look)).toEqual({
      "--card-radius": "9px",
      "--card-padding": "18px",
      "--card-gap": "15px",
      "--button-height": "58px",
      "--digit-size": "27px",
      "--button-fill": "var(--accsoft)",
    });
  });

  it("only ever uses the design's fills", () => {
    expect(lookStyle({ ...look, tint: 0 })["--button-fill" as never]).toBe("var(--bg)");
    expect(lookStyle({ ...look, tint: 1 })["--button-fill" as never]).toBe("var(--sunk)");
    expect(lookStyle({ ...look, tint: 7 })["--button-fill" as never]).toBe("var(--bg)");
  });
});
