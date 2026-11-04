// DSH-11 (#308): the seat map is one canvas. It zooms (buttons, keys, Ctrl + scroll) and pans
// (keys, drag), finds a team or person, zooms to a picked or linked team instead of hiding the
// others, works from the keyboard, passes axe at each level of detail, honours reduced motion
// and remembers the viewer's zoom. Every team it makes is deleted again.
import { expect, type Locator, type Page, test } from "@playwright/test";
import {
  ERIN,
  expectNoA11yViolations,
  MANAGER_EMAIL,
  makeTeam,
  pressUntilFocused,
  removeTeam,
} from "./helpers";

const LUCAS = "00000000-0000-4000-8000-0000000000c2";

async function signIn(page: Page) {
  await page.goto("/sign-in");
  await page.getByLabel("Work email").fill(MANAGER_EMAIL);
  await page.getByLabel("Password").fill("password123");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/team$/, { timeout: 15_000 });
}

/** The canvas point in the middle of the map, as the map reports it once the view settles. */
async function center(map: Locator): Promise<{ x: number; y: number }> {
  const [x, y] = ((await map.getAttribute("data-center")) ?? "0,0").split(",").map(Number);
  return { x: x ?? 0, y: y ?? 0 };
}

/** Whether `inner` is on screen inside `outer`. */
async function inside(outer: Locator, inner: Locator): Promise<boolean> {
  const a = await outer.boundingBox();
  const b = await inner.boundingBox();
  if (!a || !b) return false;
  const cx = b.x + b.width / 2;
  const cy = b.y + b.height / 2;
  return cx > a.x && cx < a.x + a.width && cy > a.y && cy < a.y + a.height;
}

test("the seat map zooms, pans, finds and follows a team, and works from the keyboard", async ({
  page,
}) => {
  const first = await makeTeam("Seats A", [ERIN]);
  const second = await makeTeam("Seats B", [LUCAS]);
  try {
    await page.setViewportSize({ width: 1280, height: 900 });
    await signIn(page);
    await page.getByRole("button", { name: "Seats" }).click();
    const map = page.getByRole("region", { name: "Seat map" });
    await expect(map).toBeVisible();
    const erin = page.getByRole("link", { name: /^Erin Employee, / });
    const lucas = page.getByRole("link", { name: /^Lucas Martin, / });
    await expect(erin).toHaveCount(1);
    await expect(lucas).toHaveCount(1);

    // Zoom: the buttons, then the keys.
    await page.getByRole("button", { name: "Zoom to 100%" }).click();
    await expect(map).toHaveAttribute("data-zoom", "100");
    await page.getByRole("button", { name: "Zoom in" }).click();
    await expect(map).toHaveAttribute("data-zoom", "125");
    await page.getByRole("button", { name: "Zoom out" }).click();
    await expect(map).toHaveAttribute("data-zoom", "100");
    await map.focus();
    await page.keyboard.press("+");
    await expect(map).toHaveAttribute("data-zoom", "125");
    await page.keyboard.press("-");
    await expect(map).toHaveAttribute("data-zoom", "100");

    // Pan: arrow keys on the map, then dragging.
    await expect.poll(async () => (await map.getAttribute("data-center")) ?? "").not.toBe("");
    const start = await center(map);
    await page.keyboard.press("ArrowLeft");
    await expect.poll(async () => (await center(map)).x).toBeLessThan(start.x - 30);
    const box = await map.boundingBox();
    if (!box) throw new Error("no map");
    const before = await center(map);
    await page.mouse.move(box.x + 40, box.y + 40);
    await page.mouse.down();
    await page.mouse.move(box.x + 140, box.y + 90, { steps: 5 });
    await page.mouse.up();
    // Dragging right moves the canvas right, so the middle of the screen is further left.
    await expect.poll(async () => (await center(map)).x).toBeLessThan(before.x - 60);
    // Ctrl + scroll zooms where the pointer is.
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.keyboard.down("Control");
    await page.mouse.wheel(0, -60);
    await page.keyboard.up("Control");
    await expect.poll(async () => Number(await map.getAttribute("data-zoom"))).toBeGreaterThan(100);

    // Each level of detail passes axe: blocks, dots, then chairs.
    await page.getByRole("button", { name: "Fit all" }).click();
    for (const [level, key] of [
      ["blocks", "-"],
      ["dots", "+"],
      ["chairs", "+"],
    ] as const) {
      await map.focus();
      for (let i = 0; i < 25 && (await map.getAttribute("data-detail")) !== level; i++) {
        await page.keyboard.press(key);
        await page.waitForTimeout(40);
      }
      await expect(map).toHaveAttribute("data-detail", level);
      await expectNoA11yViolations(page);
    }

    // The zoom is remembered for this viewer.
    await page.getByRole("button", { name: "Zoom to 100%" }).click();
    await page.getByRole("button", { name: "Zoom in" }).click();
    await expect(map).toHaveAttribute("data-zoom", "125");
    await page.waitForTimeout(600);
    await page.goto("/team");
    await expect(page.getByRole("region", { name: "Seat map" })).toHaveAttribute(
      "data-zoom",
      "125",
    );

    // Find a team: it zooms there and says so; nobody is hidden.
    const find = page.getByRole("searchbox", { name: "Find a team or person" });
    await find.fill(first.name);
    await expect(
      page.getByRole("status").filter({ hasText: `Showing ${first.name}` }),
    ).toBeVisible();
    await expect.poll(() => inside(map, erin)).toBe(true);
    await expect(lucas).toHaveCount(1);
    await expectNoA11yViolations(page);
    // Find a person.
    await find.fill("Lucas");
    await expect(
      page.getByRole("status").filter({ hasText: "Showing Lucas Martin" }),
    ).toBeVisible();
    await expect.poll(() => inside(map, lucas)).toBe(true);
    await find.fill("");

    // The team filter zooms to the team instead of hiding the others, and the address links to it.
    await page.getByRole("combobox", { name: /^Team/ }).selectOption(second.id);
    await expect(page).toHaveURL(new RegExp(`team=${second.id}`));
    await expect(
      page.getByRole("status").filter({ hasText: `Showing ${second.name}: 1 person` }),
    ).toBeVisible();
    await expect(erin).toHaveCount(1);
    await expect.poll(() => inside(map, lucas)).toBe(true);

    // A link to a team opens zoomed on it.
    await page.goto(`/team?team=${first.id}`);
    await expect(
      page.getByRole("status").filter({ hasText: `Showing ${first.name}: 1 person` }),
    ).toBeVisible();
    await expect
      .poll(() => inside(page.getByRole("region", { name: "Seat map" }), erin))
      .toBe(true);

    // Keyboard: Tab moves between tables (one stop each), arrows round a table, Enter opens the day.
    await page.getByRole("region", { name: "Seat map" }).focus();
    await pressUntilFocused(page, erin);
    await expect(page.getByRole("tooltip").filter({ hasText: "Erin Employee" })).toBeVisible();
    await page.keyboard.press("Tab");
    await expect(lucas).toBeFocused();
    await expect
      .poll(() => inside(page.getByRole("region", { name: "Seat map" }), lucas))
      .toBe(true);
    await page.keyboard.press("Shift+Tab");
    await expect(erin).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await expect(erin).toBeFocused();
    // Zooming from the keyboard keeps the focus where it is.
    await page.keyboard.press("-");
    await expect(erin).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(new RegExp(`/team/${ERIN}`));
  } finally {
    await removeTeam(first.id);
    await removeTeam(second.id);
  }
});

test("with reduced motion the seat map zooms in one step", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1280, height: 900 });
  await signIn(page);
  await page.getByRole("button", { name: "Seats" }).click();
  const map = page.getByRole("region", { name: "Seat map" });
  await page.getByRole("button", { name: "Zoom to 100%" }).click();
  await expect(map).toHaveAttribute("data-zoom", "100");
  // Every zoom level the map passes through on the way.
  await map.evaluate((el) => {
    const seen: string[] = [];
    (window as unknown as { zooms: string[] }).zooms = seen;
    new MutationObserver(() => seen.push(el.getAttribute("data-zoom") ?? "")).observe(el, {
      attributeFilter: ["data-zoom"],
    });
  });
  await page.getByRole("button", { name: "Zoom in" }).click();
  await expect(map).toHaveAttribute("data-zoom", "125");
  await page.waitForTimeout(400);
  expect(await page.evaluate(() => (window as unknown as { zooms: string[] }).zooms)).toEqual([
    "125",
  ]);
});

test("below laptop width the seats show as the list", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await signIn(page);
  await page.getByRole("button", { name: "Seats" }).click();
  await expect(page.getByRole("region", { name: "Seat map" })).toBeVisible();
  await page.setViewportSize({ width: 600, height: 900 });
  await expect(page.getByRole("region", { name: "Seat map" })).toHaveCount(0);
  await expect(page.getByRole("searchbox", { name: "Search people" })).toBeVisible();
});
