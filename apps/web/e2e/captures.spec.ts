import { readFileSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { agentFor } from "./agent";
import { timeAt } from "./helpers";

const org = "00000000-0000-4000-8000-000000000001";
const erinId = "00000000-0000-4000-8000-0000000000c1";
// A 1×1 WebP.
const webp = Buffer.from("UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA", "base64");

function env(key: string): string {
  const file = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
  return file.match(new RegExp(`^${key}=(.*)$`, "m"))?.[1]?.trim() ?? "";
}

test("a manager views a passed check-in's captures; missing files get a placeholder", async ({
  page,
}) => {
  const erin = await agentFor("erin@acme.test");
  await erin("clock_out", { reason: "manual" });
  await erin("clock_in", { reason: "manual" });
  const checkinId = crypto.randomUUID();
  const at = new Date(Date.now() - 5_000).toISOString();
  await erin(
    "checkin",
    {
      scheduled_at: at,
      shown_at: at,
      responded_at: at,
      outcome: "pass",
      response_ms: 3000,
      wrong_clicks: 0,
      object_keys: ["screen-1.webp", "screen-2.webp", "webcam.webp"],
      flags: [],
    },
    checkinId,
  );

  // Erin's agent uploads both displays (the webcam frame never arrives).
  const agent = createClient(env("VITE_SUPABASE_URL"), env("VITE_SUPABASE_ANON_KEY"), {
    auth: { persistSession: false },
  });
  await agent.auth.signInWithPassword({ email: "erin@acme.test", password: "password123" });
  for (const name of ["screen-1.webp", "screen-2.webp"]) {
    const path = `${org}/${erinId}/${at.slice(0, 10)}/${checkinId}/${name}`;
    const { error } = await agent.storage
      .from("captures")
      .upload(path, webp, { contentType: "image/webp" });
    expect(error).toBeNull();
  }

  await page.goto("/sign-in");
  await page.getByLabel("Work email").fill("manager@acme.test");
  await page.getByLabel("Password").fill("password123");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/team$/, { timeout: 15_000 });
  // A view is audit-logged (AUD-01), so selecting a check-in must not open its captures.
  let opens = 0;
  page.on("request", (r) => {
    if (r.url().includes("/functions/v1/capture-url") && r.method() === "POST") opens += 1;
  });
  await page.goto(`/team/${erinId}`);

  const list = page.getByRole("region", { name: "Check-ins" });
  // Other specs add check-ins on today: pick this one by the time it was shown.
  await list
    .getByRole("button", { name: /Passed/ })
    .filter({ has: page.locator(timeAt(at)) })
    .click();
  const details = page.getByRole("region", { name: /^Check-in · / });
  await expect(details).toContainText("Your view is logged and visible to Erin Employee");
  await expect(details).toContainText("Shown with the captures");
  expect(opens).toBe(0);
  await page.getByRole("button", { name: "View captures" }).click();

  const shot = page.getByRole("img", { name: "Display 1 at check-in" });
  await expect(shot).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => shot.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1);
  expect(await shot.getAttribute("src")).toMatch(/token=/);
  await expect(page.getByText("Webcam not uploaded yet")).toBeVisible();
  expect(opens).toBe(1);
  await expect(details).toContainText("Links expire in 5 minutes");
  // Two displays: the switch shows one at a time.
  await expect(shot).toBeVisible();
  await page
    .getByRole("group", { name: "Display" })
    .getByRole("button", { name: "Display 2" })
    .click();
  await expect(page.getByRole("img", { name: "Display 2 at check-in" })).toBeVisible();
  await expect(page.getByRole("img", { name: "Display 1 at check-in" })).toHaveCount(0);
  // Switching displays is not a new view.
  expect(opens).toBe(1);

  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);

  await erin("clock_out", { reason: "manual" });
});
