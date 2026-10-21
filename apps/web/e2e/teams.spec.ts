// Teams (#66, ORG-08, ADM-02, #202): an admin creates a team, puts people in it and gives
// it its own check-in interval; the members' agents get it, and the live grid, reports
// and the export filter by it. Every team this spec makes is deleted again, so other
// specs see the org as they left it.
import { readFile } from "node:fs/promises";
import { expect, type Page, test } from "@playwright/test";
import { agentFor, clientFor } from "./agent";
import { ERIN, ERIN_EMAIL, expectNoA11yViolations, makeTeam, removeTeam } from "./helpers";

const ADMIN_EMAIL = "admin@acme.test";
const LUCAS = "00000000-0000-4000-8000-0000000000c2";

async function signIn(page: Page, email: string, landing: RegExp) {
  await page.goto("/sign-in");
  await page.getByLabel("Work email").fill(email);
  await page.getByLabel("Password").fill("password123");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(landing, { timeout: 15_000 });
}

/** The policy Erin's agent runs with, read the way the agent reads it. */
async function erinAgentPolicy(): Promise<Record<string, unknown>> {
  const erin = await clientFor(ERIN_EMAIL);
  const device = await erin.rpc("register_device", {
    platform: "macos",
    os_version: "26.7",
    agent_version: "0.1.0",
    hardware_hash: `e2e-teams-${Date.now()}`,
  });
  if (device.error) throw device.error;
  const config = await erin.rpc("agent_config", { p_device_id: device.data.device_id });
  if (config.error) throw config.error;
  return (config.data as { policy: Record<string, unknown> }).policy;
}

async function latestAudit(action: string) {
  const admin = await clientFor(ADMIN_EMAIL);
  const { data, error } = await admin
    .from("audit_log")
    .select("metadata")
    .eq("action", action)
    .order("at", { ascending: false })
    .limit(1)
    .single();
  if (error) throw error;
  return data.metadata as Record<string, unknown>;
}

/** Deletes the teams with this name, if a failed run left one behind. */
async function cleanUp(name: string) {
  const admin = await clientFor(ADMIN_EMAIL);
  const { data } = await admin.from("teams").select("id").eq("name", name);
  for (const t of data ?? []) await removeTeam(t.id);
}

test("an admin creates a team with its own check-in interval; agents, the live grid, reports and the export follow it", async ({
  page,
}) => {
  const name = `Support ${Date.now()}`;
  // Another team, with nobody in it, to filter down to no one.
  const empty = await makeTeam("Empty", []);
  const erin = await agentFor(ERIN_EMAIL);
  try {
    await signIn(page, ADMIN_EMAIL, /\/team$/);
    await page
      .getByRole("navigation", { name: "Main" })
      .getByRole("link", { name: "Teams" })
      .click();
    await expect(page.getByRole("heading", { name: "Teams", level: 1 })).toBeVisible();
    await expectNoA11yViolations(page);

    // Create it: name, two people, and an interval and idle threshold of its own.
    await page.getByRole("button", { name: "New team" }).click();
    const dialog = page.getByRole("dialog", { name: "New team" });
    await dialog.getByLabel("Team name").fill(name);
    await dialog.getByRole("checkbox", { name: /^Erin Employee/ }).check();
    await dialog.getByRole("checkbox", { name: /^Lucas Martin/ }).check();
    await expect(
      dialog.getByText(/Check-in interval follows the org: every \d+ to \d+ min/),
    ).toBeVisible();
    await dialog.getByRole("checkbox", { name: "Override check-in interval" }).check();
    await dialog.getByRole("spinbutton", { name: "Shortest interval" }).fill("15");
    await dialog.getByRole("spinbutton", { name: "Longest interval" }).fill("10");
    await expect(dialog.getByText("Must be at least the shortest interval")).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Save team" })).toBeDisabled();
    await dialog.getByRole("spinbutton", { name: "Longest interval" }).fill("30");
    await dialog.getByRole("checkbox", { name: "Override idle threshold" }).check();
    await dialog.getByRole("spinbutton", { name: "Idle threshold" }).fill("3");
    await expectNoA11yViolations(page);
    await dialog.getByRole("button", { name: "Save team" }).click();
    await expect(dialog).not.toBeVisible();

    const row = page.getByRole("row").filter({ hasText: name });
    await expect(row.getByRole("cell").nth(1)).toHaveText("2");
    await expect(row).toContainText("Check-ins every 15 to 30 min · Idle after 3 min");

    // Erin's agent runs with the team's interval and the org's response window.
    const policy = await erinAgentPolicy();
    expect(policy.checkin_min_interval_min).toBe(15);
    expect(policy.checkin_max_interval_min).toBe(30);
    expect(policy.idle_threshold_min).toBe(3);
    const changed = await latestAudit("team.policy_changed");
    expect(changed.name).toBe(name);
    expect(Object.keys(changed.changed as object).sort()).toEqual([
      "checkin_max_interval_min",
      "checkin_min_interval_min",
      "idle_threshold_min",
    ]);

    const teamId = (
      await (await clientFor(ADMIN_EMAIL)).from("teams").select("id").eq("name", name).single()
    ).data?.id;

    // People shows each person's team.
    await page.goto("/people");
    await expect(
      page.getByRole("row").filter({ hasText: "Erin Employee" }).getByRole("cell", { name }),
    ).toBeVisible();

    // The live grid filters by team (DSH-02).
    await erin("clock_out", { reason: "manual" });
    await erin("clock_in", { reason: "manual" });
    await page.goto("/team");
    const erinRow = page.getByRole("row").filter({ hasText: "Erin Employee" });
    await expect(erinRow).toBeVisible({ timeout: 10_000 });
    const teamFilter = page.getByRole("combobox", { name: /^Team/ });
    await teamFilter.selectOption({ label: name });
    await expect(erinRow).toBeVisible();
    await teamFilter.selectOption({ label: empty.name });
    await expect(page.getByText("No one matches these filters.")).toBeVisible();
    await expectNoA11yViolations(page);

    // Reports filter by team (DSH-07, #202): Erin and Lucas, not Max.
    await page.goto("/reports");
    await page.getByLabel("Team", { exact: true }).selectOption({ label: name });
    await expect(page.getByRole("rowheader", { name: "Erin Employee" })).toBeVisible();
    await expect(page.getByRole("rowheader", { name: "Lucas Martin" })).toBeVisible();
    await expect(page.getByRole("rowheader", { name: "Max Manager" })).toHaveCount(0);

    // So does the export (TS-20, #202), and its audit row says which team.
    await page.goto("/timesheets");
    await page.getByRole("button", { name: "Export", exact: true }).click();
    const exportDialog = page.getByRole("dialog", { name: "Export timesheets" });
    await exportDialog.getByLabel("Team").selectOption({ label: name });
    await exportDialog.getByLabel("View").selectOption("segments");
    const download = page.waitForEvent("download");
    await exportDialog.getByRole("button", { name: "Download CSV" }).click();
    const text = await readFile((await (await download).path()) ?? "", "utf8");
    expect(text).not.toContain("Max Manager");
    await expect.poll(async () => (await latestAudit("timesheet.exported")).team_id).toBe(teamId);

    // Back to the org's interval: the override is turned off, then the team is deleted.
    await page.goto("/teams");
    await page.getByRole("button", { name: `Edit ${name}` }).click();
    const edit = page.getByRole("dialog", { name: `Edit ${name}` });
    await edit.getByRole("checkbox", { name: "Override idle threshold" }).uncheck();
    await edit.getByRole("button", { name: "Save team" }).click();
    await expect(row).toContainText("Check-ins every 15 to 30 min");
    await expect(row).not.toContainText("Idle after");
    expect((await erinAgentPolicy()).idle_threshold_min).not.toBe(3);

    await page.getByRole("button", { name: `Edit ${name}` }).click();
    await edit.getByRole("button", { name: "Delete", exact: true }).click();
    await edit
      .getByRole("alertdialog", { name: "Delete team" })
      .getByRole("button", { name: "Delete team" })
      .click();
    await expect(row).toHaveCount(0);
    expect((await erinAgentPolicy()).checkin_min_interval_min).not.toBe(15);
    expect((await latestAudit("team.deleted")).name).toBe(name);
  } finally {
    await erin("clock_out", { reason: "manual" });
    await cleanUp(name);
    await removeTeam(empty.id);
  }
});

test("a manager reads his reports' teams but cannot change them", async ({ page }) => {
  const team = await makeTeam("Readonly", [ERIN, LUCAS]);
  try {
    const manager = await clientFor("manager@acme.test");
    const { data } = await manager.from("teams").select("name").eq("id", team.id);
    expect(data?.map((t) => t.name)).toEqual([team.name]);
    const { error } = await manager.rpc("set_team_policy", {
      p_team_id: team.id,
      p_policy: { checkin_response_s: 60 },
    });
    expect(error?.message).toBe("admin_only");

    // No Teams page for managers.
    await signIn(page, "manager@acme.test", /\/team$/);
    await expect(
      page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Teams" }),
    ).toHaveCount(0);
    await page.goto("/teams");
    await expect(page).toHaveURL(/\/team$/);
  } finally {
    await removeTeam(team.id);
  }
});
