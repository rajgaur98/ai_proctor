import { readFileSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { DateTime } from "luxon";

const lucasId = "00000000-0000-4000-8000-0000000000c2";

function env(key: string): string {
  const file = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
  return file.match(new RegExp(`^${key}=(.*)$`, "m"))?.[1]?.trim() ?? "";
}

async function signIn(page: Page, email: string, landing: RegExp) {
  await page.goto("/sign-in");
  await page.getByLabel("Work email").fill(email);
  await page.getByLabel("Password").fill("password123");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(landing, { timeout: 15_000 });
}

async function expectNoA11yViolations(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
}

/** `times` audited location changes (Lucas moves state back and forth), made as the admin would. */
async function changeLucasLocation(times: number) {
  const admin = createClient(env("VITE_SUPABASE_URL"), env("VITE_SUPABASE_ANON_KEY"), {
    auth: { persistSession: false },
  });
  const { error: signInError } = await admin.auth.signInWithPassword({
    email: "admin@acme.test",
    password: "password123",
  });
  expect(signInError).toBeNull();
  const { data: lucas } = await admin
    .from("users")
    .select("full_name, role, manager_id, work_country, work_state, timezone")
    .eq("id", lucasId)
    .single();
  expect(lucas).not.toBeNull();
  const original = lucas?.work_state ?? "TX";
  const move = async (state: string) => {
    const { error } = await admin.rpc("update_member", {
      p_user_id: lucasId,
      p_full_name: lucas?.full_name ?? "",
      p_role: lucas?.role ?? "employee",
      p_manager_id: lucas?.manager_id as string,
      p_work_country: lucas?.work_country ?? "US",
      p_work_state: state,
      p_timezone: lucas?.timezone ?? "UTC",
    });
    expect(error).toBeNull();
  };
  let state = original;
  for (let i = 0; i < times; i++) {
    state = state === "OK" ? "TX" : "OK";
    await move(state);
  }
  if (state !== original) await move(original);
}

/** Ticks an action in the filter bar's menu, opening it if it's closed. */
async function pickAction(page: Page, label: string) {
  const box = page.getByRole("checkbox", { name: label });
  if (!(await box.isVisible())) await page.locator('form[aria-label="Filters"] summary').click();
  await box.check();
}

test("an admin filters the audit log, exports it, and the export is logged", async ({ page }) => {
  await changeLucasLocation(2);
  await signIn(page, "admin@acme.test", /\/team$/);
  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "Audit log" })
    .click();
  await expect(page).toHaveURL(/\/audit$/);
  await expect(page.getByRole("heading", { name: "Audit log" })).toBeVisible();
  const body = page.locator("tbody tr");
  await expect(body.first()).toBeVisible();
  await expectNoA11yViolations(page);

  // Filter by action and by day (the admin is on New York time).
  const today = DateTime.now().setZone("America/New_York").toISODate() ?? "";
  await pickAction(page, "Changed a work location");
  await expect(page.getByText("1 selected")).toBeVisible();
  await expectNoA11yViolations(page);
  await page.getByLabel("From", { exact: true }).fill(today);
  await page.getByLabel("To", { exact: true }).fill(today);
  await page.getByLabel("Target").selectOption({ label: "Lucas Martin" });
  // Settled once every row on screen is about Lucas.
  await expect
    .poll(async () => {
      const all = await body.count();
      return all >= 2 && (await body.filter({ hasNotText: "Lucas Martin" }).count()) === 0;
    })
    .toBe(true);
  const shown = await body.count();
  expect(shown).toBeGreaterThanOrEqual(2);
  for (const row of await body.all()) {
    await expect(row).toContainText("Ada Admin");
    await expect(row).toContainText("Lucas Martin");
    await expect(row).toContainText("US");
  }

  // A day with nothing in it.
  await page.getByLabel("From", { exact: true }).fill("2020-01-01");
  await page.getByLabel("To", { exact: true }).fill("2020-01-02");
  await expect(page.getByText("No entries match these filters.")).toBeVisible();
  await page.getByLabel("From", { exact: true }).fill(today);
  await page.getByLabel("To", { exact: true }).fill(today);
  await expect(body).toHaveCount(shown);

  // Export what's on screen.
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Export CSV" }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^audit-log-\d{4}-\d{2}-\d{2}-\d{4}\.csv$/);
  const csv = readFileSync(await download.path(), "utf8");
  const lines = csv.trimEnd().split("\r\n");
  expect(lines[0]).toBe("time,timezone,actor,actor_id,action,target,target_user_id,details");
  // The page shows at most 50 entries; the export has all of them (repeat runs add more).
  const exportedRows = lines.length - 1;
  expect(exportedRows).toBeGreaterThanOrEqual(shown);
  if (shown < 50) expect(exportedRows).toBe(shown);
  for (const line of lines.slice(1)) {
    expect(line).toContain("member.location_changed");
    expect(line).toContain("America/New_York");
    expect(line).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?-0[45]:00,/);
  }
  await expect(page.getByRole("status")).toContainText(`Exported ${exportedRows} entries`);

  // The export is a new entry, with its filters and row count.
  await page.getByRole("button", { name: "Clear filters" }).click();
  await pickAction(page, "Exported the audit log");
  const exported = body.first();
  await expect(exported).toContainText("Exported the audit log");
  await expect(exported).toContainText("Ada Admin");
  await expect(exported).toContainText(
    `${exportedRows} rows · actions: member.location_changed · target: Lucas Martin · from ${today} · to ${today}`,
  );
  await expectNoA11yViolations(page);
});

test("load more pages through the log", async ({ page }) => {
  await changeLucasLocation(52);
  await signIn(page, "admin@acme.test", /\/team$/);
  await page.goto("/audit");
  const body = page.locator("tbody tr");
  await expect(body).toHaveCount(50);
  await page.getByRole("button", { name: "Load more" }).click();
  await expect.poll(() => body.count()).toBeGreaterThan(50);
  await expect(page.getByText(/^\d+ entries shown/)).toBeVisible();
});

test("a manager can't open the audit log", async ({ page }) => {
  await signIn(page, "manager@acme.test", /\/team$/);
  await expect(
    page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Audit log" }),
  ).toHaveCount(0);
  await page.goto("/audit");
  await expect(page).toHaveURL(/\/team$/);

  // And the database says no even to a direct call.
  const manager = createClient(env("VITE_SUPABASE_URL"), env("VITE_SUPABASE_ANON_KEY"), {
    auth: { persistSession: false },
  });
  await manager.auth.signInWithPassword({ email: "manager@acme.test", password: "password123" });
  expect((await manager.rpc("search_audit_log")).error?.message).toBe("admin_only");
  expect((await manager.rpc("export_audit_log")).error?.message).toBe("admin_only");
  expect((await manager.from("audit_log").select("id")).data).toEqual([]);
});
