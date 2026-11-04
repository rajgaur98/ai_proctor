// DSH-11 (#308): the seat map with thousands of people. Runs only from
// scripts/it-seat-map-scale.sh, which seeds SEAT_MAP_SCALE synthetic people reporting to Max
// Manager (in teams of 3 to 130), runs this and removes them. Checks the team page's reads
// (a page per thousand people, nothing twice), that only what's on screen is in the DOM, the
// frame rate while panning and zooming at each level of detail, and that live status updates
// change chairs without a new layout. Prints what it measured.
import { execFileSync } from "node:child_process";
import { expect, type Page, test } from "@playwright/test";
import { MANAGER_EMAIL } from "./helpers";

const PEOPLE = Number(process.env.SEAT_MAP_SCALE ?? 0);
test.skip(!PEOPLE, "needs the scale seed: scripts/it-seat-map-scale.sh");

/** Runs SQL against this stack's database (DB_URL comes from scripts/stack.sh run). */
function sql(query: string) {
  execFileSync("psql", [process.env.DB_URL ?? "", "-X", "-q", "-c", query]);
}

interface Timing {
  frames: number;
  fps: number;
  p50: number;
  p95: number;
  worst: number;
}

/**
 * Drives the map for `frames` animation frames, sending one wheel event per frame (a pan, or
 * a Ctrl + wheel zoom), and returns the frame intervals in milliseconds.
 */
async function drive(
  page: Page,
  frames: number,
  move: "pan" | "zoom-in" | "zoom-out",
): Promise<Timing> {
  const gaps = await page.evaluate(
    ([frames, move]) =>
      new Promise<number[]>((done) => {
        const map = document.querySelector('section[aria-label="Seat map"]') as HTMLElement;
        const box = map.getBoundingClientRect();
        const gaps: number[] = [];
        let last = performance.now();
        let n = 0;
        const step = (t: number) => {
          gaps.push(t - last);
          last = t;
          const zoom = move !== "pan";
          map.dispatchEvent(
            new WheelEvent("wheel", {
              bubbles: true,
              cancelable: true,
              clientX: box.left + box.width / 2,
              clientY: box.top + box.height / 2,
              deltaX: zoom ? 0 : 6 * Math.sin(n / 9),
              // About ×3.3 in over 120 frames (blocks to dots), ×1/11 out over 240.
              deltaY: zoom ? (move === "zoom-in" ? -1 : 1) : 9 * Math.cos(n / 13),
              ctrlKey: zoom,
            }),
          );
          if (++n < frames) requestAnimationFrame(step);
          else done(gaps.slice(2));
        };
        requestAnimationFrame(step);
      }),
    [frames, move] as const,
  );
  const sorted = [...gaps].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  const total = gaps.reduce((a, b) => a + b, 0);
  return {
    frames: gaps.length,
    fps: Math.round((gaps.length * 1000) / total),
    p50: Math.round(at(0.5) * 10) / 10,
    p95: Math.round(at(0.95) * 10) / 10,
    worst: Math.round((sorted.at(-1) ?? 0) * 10) / 10,
  };
}

test("the seat map stays smooth with thousands of people", async ({ page }) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/sign-in");
  await page.getByLabel("Work email").fill(MANAGER_EMAIL);
  await page.getByLabel("Password").fill("password123");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/team$/, { timeout: 15_000 });
  await page.getByRole("button", { name: "Seats" }).click();

  // The team page's reads, from a fresh load: a page of the team per thousand people, once each.
  const reads: string[] = [];
  let counting = true;
  const teamMs: number[] = [];
  page.on("requestfinished", (r) => {
    if (r.url().includes("/rest/v1/team_live")) teamMs.push(Math.round(r.timing().responseEnd));
  });
  page.on("request", (r) => {
    const url = new URL(r.url());
    if (counting && url.pathname.startsWith("/rest/v1/")) {
      reads.push(`${r.method()} ${url.pathname}${url.search}`);
    }
  });
  const loadStart = Date.now();
  await page.reload();
  const map = page.getByRole("region", { name: "Seat map" });
  await expect(map).toBeVisible({ timeout: 60_000 });
  const loadMs = Date.now() - loadStart;
  await page.waitForLoadState("networkidle");
  counting = false;
  // Everyone Max can see: the synthetic people and the seed's few.
  const teamReads = reads.filter((r) => r.includes("/rest/v1/team_live"));
  expect(teamReads.length).toBeGreaterThanOrEqual(Math.ceil(PEOPLE / 1000));
  expect(teamReads.length).toBeLessThanOrEqual(Math.ceil((PEOPLE + 50) / 1000));
  expect(reads.filter((r, i) => reads.indexOf(r) !== i)).toEqual([]);

  // Everyone fits; zoomed out, each table is one stop in the DOM, not a chair per person.
  await page.getByRole("button", { name: "Fit all" }).click();
  await expect(map).toHaveAttribute("data-detail", "blocks");
  const domNodes = await map.evaluate((el) => el.querySelectorAll("*").length);
  const tables = await map.locator("li[data-table]").count();
  expect(domNodes).toBeLessThan(PEOPLE / 2);
  await expect(map.getByRole("link")).toHaveCount(0);

  // From the keyboard each table is one stop; Enter zooms in and moves into its chairs.
  await map.focus();
  await page.keyboard.press("Tab");
  await expect(
    page.getByRole("button", { name: /^Seat scale 001: \d+ people, \d+ active\. Press Enter/ }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("link", { name: /^Seat Person 0001, / })).toBeFocused();
  await expect(map).toHaveAttribute("data-detail", "chairs");
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("link", { name: /^Seat Person 0002, / })).toBeFocused();
  // Zoomed in on a big org, the minimap shows where the view is.
  await expect(map.locator("canvas").nth(1)).toBeVisible();
  await page.getByRole("button", { name: "Fit all" }).click();
  await expect(map).toHaveAttribute("data-detail", "blocks");

  const timings: Record<string, Timing> = {};
  timings["pan, blocks"] = await drive(page, 180, "pan");
  timings["zoom in, blocks to dots"] = await drive(page, 120, "zoom-in");
  await expect(map).toHaveAttribute("data-detail", "dots");
  timings["pan, dots"] = await drive(page, 180, "pan");
  for (let i = 0; i < 20 && (await map.getAttribute("data-detail")) !== "chairs"; i++) {
    await map.focus();
    await page.keyboard.press("+");
    await page.waitForTimeout(260);
  }
  await expect(map).toHaveAttribute("data-detail", "chairs");
  timings["pan, chairs"] = await drive(page, 180, "pan");
  timings["zoom out, chairs to blocks"] = await drive(page, 240, "zoom-out");
  await expect(map).toHaveAttribute("data-detail", "blocks");

  // Zoomed in, only the chairs on screen are links.
  await page.getByRole("searchbox", { name: "Find a team or person" }).fill("Seat Person 0002");
  const person = page.getByRole("link", { name: /^Seat Person 0002, / });
  await expect(person).toBeVisible();
  const links = await map.getByRole("link").count();
  expect(links).toBeLessThan(400);

  // Live status updates change the chair, not the layout.
  const version = await map.getAttribute("data-layout-version");
  await expect(person).toHaveAccessibleName(/, Active since /);
  sql(`update public.presence p set status = 'on_break', since = now()
       from public.users u where u.id = p.user_id and u.email = 'seat2@seat-scale.test'`);
  sql(`update public.presence p set status = case when p.status = 'active' then 'away'::public.presence_status else 'active' end, since = now()
       from public.users u where u.id = p.user_id and u.email like 'seat1__@seat-scale.test'`);
  await expect(person).toHaveAccessibleName(/, On break since /, { timeout: 15_000 });
  await page.waitForTimeout(1500);
  await expect(map).toHaveAttribute("data-layout-version", version ?? "");
  timings["pan, chairs, after live updates"] = await drive(page, 120, "pan");

  console.log(
    JSON.stringify(
      {
        people: PEOPLE,
        tables,
        loadMs,
        teamMs,
        teamReads: teamReads.length,
        reads: reads.length,
        domNodes,
        links,
        timings,
      },
      null,
      2,
    ),
  );
  // About 60 fps (DSH-11): most frames on time, allowing for a busy test machine.
  for (const [what, t] of Object.entries(timings)) {
    expect(t.p50, what).toBeLessThan(20);
    expect(t.fps, what).toBeGreaterThan(45);
  }
});
