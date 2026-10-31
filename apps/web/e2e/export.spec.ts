import { readFile } from "node:fs/promises";
import { readXlsx, readZip, weekOf } from "@ai-proctor/core";
import { expect, type Page, test } from "@playwright/test";
import { DateTime } from "luxon";
import { clientFor } from "./agent";
import { ERIN, ERIN_EMAIL, expectNoA11yViolations, rebuildSegments, weekDays } from "./helpers";

const MANAGER_EMAIL = "manager@acme.test";
const ADMIN_EMAIL = "admin@acme.test";

async function signIn(page: Page, email: string, landing: RegExp) {
  await page.goto("/sign-in");
  await page.getByLabel("Work email").fill(email);
  await page.getByLabel("Password").fill("password123");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(landing, { timeout: 15_000 });
}

/** The newest export's audit metadata, as the admin. */
async function lastExport() {
  const admin = await clientFor(ADMIN_EMAIL);
  const { data, error } = await admin
    .from("audit_log")
    .select("metadata")
    .eq("action", "timesheet.exported")
    .order("at", { ascending: false })
    .limit(1)
    .single();
  if (error) throw error;
  return data.metadata as Record<string, unknown>;
}

/** Sets (or, with nulls, clears) the org's overtime thresholds as the admin. */
async function setOvertime(daily: number | null, weekly: number | null) {
  const admin = await clientFor(ADMIN_EMAIL);
  const { error } = await admin.rpc("update_policy", {
    p_policy: { overtime_daily_hours: daily, overtime_weekly_hours: weekly },
  });
  if (error) throw error;
}

const XLSX_PARTS = [
  "[Content_Types].xml",
  "_rels/.rels",
  "xl/workbook.xml",
  "xl/_rels/workbook.xml.rels",
  "xl/styles.xml",
  "xl/worksheets/sheet1.xml",
];

/** Export rows in the audit log, as the admin who may read it. */
async function exportsLogged() {
  const admin = await clientFor(ADMIN_EMAIL);
  const { count, error } = await admin
    .from("audit_log")
    .select("id", { count: "exact", head: true })
    .eq("action", "timesheet.exported");
  if (error) throw error;
  return count ?? 0;
}

test("a manager exports the week as CSV from the Timesheets tab, and it is audit-logged", async ({
  page,
}) => {
  const before = await exportsLogged();
  await signIn(page, MANAGER_EMAIL, /\/team$/);
  await page.goto("/timesheets");
  await expect(page.getByRole("heading", { name: "Timesheets" })).toBeVisible();
  await expectNoA11yViolations(page);

  await page.getByRole("button", { name: "Export", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Export timesheets" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("Employee")).toBeVisible();
  await expect(dialog.getByLabel("Approval status")).toBeVisible();
  await expectNoA11yViolations(page);

  // The dialog opens on the week the tab shows.
  const from = await dialog.getByLabel("From", { exact: true }).inputValue();
  const to = await dialog.getByLabel("To", { exact: true }).inputValue();
  expect(from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  await dialog.getByLabel("View").selectOption("project");

  const download = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "Download CSV" }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe(`timesheet-project-${from}_${to}.csv`);
  const text = await readFile((await file.path()) ?? "", "utf8");
  const lines = text.replace(/^﻿/, "").split("\r\n");
  expect(lines[0]).toContain(
    "Employee,Email,Client,Project,Task,Billable,Worked (h),Worked (H:MM)",
  );
  expect(lines[0]).toMatch(/Status,Approver$/);
  // Header, the people's rows, then the Total row; nothing after the last CRLF.
  expect(lines.at(-1)).toBe("");
  expect(lines.at(-2)).toMatch(/^Total,/);
  await expect(dialog).not.toBeVisible();

  await expect.poll(exportsLogged).toBe(before + 1);
  expect((await lastExport()).format).toBe("csv");
});

test("a manager downloads the same view as XLSX; it is a workbook and the format is audit-logged", async ({
  page,
}) => {
  const before = await exportsLogged();
  await signIn(page, MANAGER_EMAIL, /\/team$/);
  await page.goto("/timesheets");
  await page.getByRole("button", { name: "Export", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Export timesheets" });
  const format = dialog.getByRole("radiogroup", { name: "Format" });
  await expect(format.getByLabel("CSV")).toBeChecked();
  await format.getByText("XLSX").click();
  await expect(format.getByLabel("XLSX")).toBeChecked();
  await expect(dialog).toContainText("overtime thresholds");
  await expectNoA11yViolations(page);
  const from = await dialog.getByLabel("From", { exact: true }).inputValue();
  const to = await dialog.getByLabel("To", { exact: true }).inputValue();
  await dialog.getByLabel("View").selectOption("project");

  const download = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "Download XLSX" }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe(`timesheet-project-${from}_${to}.xlsx`);
  const bytes = new Uint8Array(await readFile((await file.path()) ?? ""));
  // A ZIP whose every CRC checks out, with the workbook's parts.
  expect(readZip(bytes).map((e) => e.name)).toEqual(XLSX_PARTS);
  const [sheet] = readXlsx(bytes);
  expect(sheet?.name).toBe("Per project");
  expect(sheet?.rows[0]?.slice(0, 8).map((c) => c.value)).toEqual([
    "Employee",
    "Email",
    "Client",
    "Project",
    "Task",
    "Billable",
    "Worked (h)",
    "Worked (H:MM)",
  ]);
  expect(sheet?.rows.at(-1)?.[0]?.value).toBe("Total");
  await expect(dialog).not.toBeVisible();

  await expect.poll(exportsLogged).toBe(before + 1);
  expect((await lastExport()).format).toBe("xlsx");
});

test("overtime thresholds set on the policy page highlight the day and week, on the timesheet and in the XLSX", async ({
  page,
}) => {
  // The timesheet page and the export each rebuild or read a past week; give it room.
  test.setTimeout(90_000);
  // A past day with nothing on it, picked per run (the local database keeps earlier runs):
  // Erin asks for 9 h 30 min there and her manager approves it.
  const erin = await clientFor(ERIN_EMAIL);
  const manager = await clientFor(MANAGER_EMAIL);
  let day = "";
  for (let i = 0; i < 50 && !day; i++) {
    const candidate =
      DateTime.now()
        .minus({ days: 200 + ((Date.now() + i * 7) % 150) })
        .toISODate() ?? "";
    const { count, error } = await manager
      .from("time_segments")
      .select("id", { count: "exact", head: true })
      .eq("user_id", ERIN)
      .gte("day", weekOf(candidate, "monday"))
      .lte("day", weekDays(weekOf(candidate, "monday")).at(-1) ?? candidate);
    if (error) throw error;
    if (count === 0) day = candidate;
  }
  expect(day).not.toBe("");
  const week = weekOf(day, "monday");
  const at = (time: string) =>
    DateTime.fromISO(`${day}T${time}`, { zone: "America/Los_Angeles" }).toUTC().toISO() ?? "";
  const requested = await erin.rpc("request_manual_entry", {
    p_start_at: at("08:30"),
    p_end_at: at("18:00"),
    p_project_id: null as unknown as string,
    p_reason: `Overtime e2e ${Date.now()}`,
  });
  if (requested.error) throw requested.error;
  const decided = await manager.rpc("decide_manual_entry", {
    p_id: requested.data,
    p_approve: true,
  });
  if (decided.error) throw decided.error;
  await rebuildSegments(ERIN, [day], manager);

  try {
    // The admin sets 8 h a day and 9 h a week.
    await signIn(page, ADMIN_EMAIL, /\/team$/);
    await page.goto("/policy");
    await page.getByLabel("Daily threshold").fill("8");
    await page.getByLabel("Weekly threshold").fill("9");
    await expectNoA11yViolations(page);
    await page.getByRole("button", { name: "Save policy" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Saved" })).toContainText(
      "Saved 2 settings",
      { timeout: 15_000 },
    );
    await page.getByLabel("Account menu for Ada Admin").click();
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page).toHaveURL(/\/sign-in$/);

    // The manager sees Erin's day and week highlighted on her timesheet.
    await signIn(page, MANAGER_EMAIL, /\/team$/);
    await page.goto(`/timesheets/${ERIN}?week=${week}`);
    await expect(page.getByText("over the 8 h daily overtime threshold")).toHaveCount(1, {
      timeout: 20_000,
    });
    // The week appears twice: in the heading line and the table's total.
    await expect(page.getByText("over the 9 h weekly overtime threshold")).toHaveCount(2);
    await expect(
      page.getByText(/Highlighted: worked time above the overtime threshold/),
    ).toContainText("8 h a day, 9 h a week");
    await expectNoA11yViolations(page);

    // The XLSX of that week: the day's Worked cells and the week's total are filled.
    await page.goto("/timesheets");
    await page.getByRole("button", { name: "Export", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Export timesheets" });
    await dialog.getByLabel("From", { exact: true }).fill(week);
    await dialog.getByLabel("To", { exact: true }).fill(weekDays(week).at(-1) ?? week);
    await dialog.getByLabel("Employee").selectOption({ label: "Erin Employee" });
    await dialog.getByRole("radiogroup", { name: "Format" }).getByText("XLSX").click();
    const download = page.waitForEvent("download");
    await dialog.getByRole("button", { name: "Download XLSX" }).click();
    const bytes = new Uint8Array(await readFile((await (await download).path()) ?? ""));
    const [perDay, weekly] = readXlsx(bytes);
    expect([perDay?.name, weekly?.name]).toEqual(["Per day", "Weekly totals"]);
    const header = (perDay?.rows[0] ?? []).map((c) => c.value);
    const row = perDay?.rows.find((r) => r[header.indexOf("Date")]?.value === day);
    expect(row?.[header.indexOf("Worked (h)")]).toMatchObject({
      value: 9.5,
      style: { highlight: true },
    });
    expect(row?.[header.indexOf("Worked (H:MM)")]).toMatchObject({
      value: "9:30",
      style: { highlight: true },
    });
    expect(row?.[header.indexOf("Flagged (h)")]?.style.highlight).toBe(false);
    expect(weekly?.rows[1]?.map((c) => c.value)).toEqual([
      "Erin Employee",
      ERIN_EMAIL,
      week,
      9.5,
      "9:30",
    ]);
    expect(weekly?.rows[1]?.[3]?.style.highlight).toBe(true);
  } finally {
    await setOvertime(null, null);
  }
});

test("a range that ends before it starts is explained and nothing is exported", async ({
  page,
}) => {
  const before = await exportsLogged();
  await signIn(page, MANAGER_EMAIL, /\/team$/);
  await page.goto("/timesheets");
  await page.getByRole("button", { name: "Export", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Export timesheets" });
  await dialog.getByLabel("From", { exact: true }).fill("2026-03-22");
  await dialog.getByLabel("To", { exact: true }).fill("2026-03-16");
  await dialog.getByRole("button", { name: "Download CSV" }).click();
  await expect(dialog.getByRole("alert")).toContainText("same or later");
  await expectNoA11yViolations(page);
  expect(await exportsLogged()).toBe(before);
});

test("an employee downloads a week of their own time as CSV from My timesheet", async ({
  page,
}) => {
  const before = await exportsLogged();
  await signIn(page, "erin@acme.test", /\/me$/);
  await page.goto("/my-timesheet");
  await expect(page.getByRole("heading", { name: "My timesheet" })).toBeVisible();
  await expectNoA11yViolations(page);

  await expect(page.getByRole("button", { name: /^Download .* as XLSX$/ }).first()).toBeVisible();
  const download = page.waitForEvent("download");
  await page
    .getByRole("button", { name: /^Download .* as CSV$/ })
    .first()
    .click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/\.csv$/);
  const csv = await readFile((await file.path()) ?? "", "utf8");
  // The daily view's header; only her own rows (the week may have none on a fresh database).
  expect(csv.replace(/^\uFEFF/, "").split("\r\n")[0]).toMatch(/^Employee,Email,Date,/);
  expect(csv).not.toContain("Lucas Martin");
  expect(await exportsLogged()).toBe(before + 1);
});
