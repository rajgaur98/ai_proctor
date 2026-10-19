import { readFileSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { agentFor } from "./agent";

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
      object_keys: ["screen-1.webp", "webcam.webp"],
      flags: [],
    },
    checkinId,
  );

  // Erin's agent uploads the screenshot (the webcam frame never arrives).
  const agent = createClient(env("VITE_SUPABASE_URL"), env("VITE_SUPABASE_ANON_KEY"), {
    auth: { persistSession: false },
  });
  await agent.auth.signInWithPassword({ email: "erin@acme.test", password: "password123" });
  const path = `${org}/${erinId}/${at.slice(0, 10)}/${checkinId}/screen-1.webp`;
  const { error } = await agent.storage
    .from("captures")
    .upload(path, webp, { contentType: "image/webp" });
  expect(error).toBeNull();

  await page.goto("/sign-in");
  await page.getByLabel("Work email").fill("manager@acme.test");
  await page.getByLabel("Password").fill("password123");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/team$/, { timeout: 15_000 });
  await page.goto(`/team/${erinId}`);

  const list = page.getByRole("list").filter({ hasText: "Passed check-in" });
  await list
    .getByRole("button", { name: /Passed check-in/ })
    .filter({ hasText: "in 3 s" })
    .last()
    .click();
  await page.getByRole("button", { name: "View captures" }).click();

  const shot = page.getByRole("img", { name: "Screen 1 at check-in" });
  await expect(shot).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => shot.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1);
  expect(await shot.getAttribute("src")).toMatch(/token=/);
  await expect(page.getByText("Webcam not uploaded yet")).toBeVisible();
  await expect(page.getByText("This view is recorded in the audit log")).toBeVisible();

  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);

  await erin("clock_out", { reason: "manual" });
});
