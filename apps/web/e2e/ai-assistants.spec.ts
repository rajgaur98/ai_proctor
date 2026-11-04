// AI assistant access (#307, API-07): an admin turns it on and off on Settings → API, and a
// person approves or (while it is off) can only cancel an assistant on the OAuth consent
// page that Supabase Auth's OAuth server sends them to. The assistant's side (registering,
// asking for authorization) is done here over HTTP, as an MCP client would. Each test sets
// the switch itself, so it passes alone and after any other spec.
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import { clientFor } from "./agent";
import { expectNoA11yViolations, MANAGER_EMAIL, pressUntilFocused } from "./helpers";

const backend = (() => {
  const file = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
  return file.match(/^VITE_SUPABASE_URL=(.*)$/m)?.[1]?.trim() ?? "";
})();
const CALLBACK = "http://localhost:9876/callback";

async function setAccess(enabled: boolean) {
  const admin = await clientFor("admin@acme.test");
  const { error } = await admin.rpc("set_ai_assistant_access", { p_enabled: enabled });
  if (error) throw error;
}

/** What an assistant does before the person sees anything: registers itself and asks
 * Auth to authorize it. Returns the dashboard path Auth sends the person to. */
async function assistantAsks(name: string): Promise<string> {
  const registered = await fetch(`${backend}/auth/v1/oauth/clients/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: name,
      redirect_uris: [CALLBACK],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  });
  expect(registered.status).toBe(201);
  const { client_id } = (await registered.json()) as { client_id: string };
  const verifier = randomBytes(32).toString("base64url");
  const q = new URLSearchParams({
    response_type: "code",
    client_id,
    redirect_uri: CALLBACK,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    state: "e2e",
    scope: "email",
  });
  const res = await fetch(`${backend}/auth/v1/oauth/authorize?${q}`, { redirect: "manual" });
  expect(res.status).toBe(302);
  const consent = new URL(res.headers.get("location") ?? "");
  expect(consent.pathname).toBe("/oauth/consent");
  return `${consent.pathname}${consent.search}`;
}

async function signIn(page: Page, email: string) {
  await page.getByLabel("Work email").fill(email);
  await page.getByLabel("Password").fill("password123");
  await page.getByRole("button", { name: "Sign in" }).click();
}

/** The assistant's redirect URI isn't a real server: answer it so the page can land. */
async function catchCallback(page: Page) {
  await page.route("http://localhost:9876/**", (route) =>
    route.fulfill({ status: 200, contentType: "text/plain", body: "assistant callback" }),
  );
}

test("an admin turns AI assistant access on and off", async ({ page }) => {
  await setAccess(false);
  await page.goto("/sign-in");
  await signIn(page, "admin@acme.test");
  await expect(page).toHaveURL(/\/team$/, { timeout: 15_000 });
  await page.getByRole("navigation").getByRole("link", { name: "API" }).click();
  const section = page.getByRole("region", { name: "AI assistants" });
  await expect(section).toBeVisible();
  const toggle = section.getByRole("checkbox", { name: "Allow AI assistant access" });
  await expect(toggle).not.toBeChecked();
  await expect(section.getByLabel("MCP server URL")).toHaveCount(0);
  await expectNoA11yViolations(page);

  // By keyboard: to the switch, Space asks first.
  await pressUntilFocused(page, toggle);
  await page.keyboard.press("Space");
  const confirm = page.getByRole("dialog", { name: "Turn on AI assistant access?" });
  await expect(confirm).toBeVisible();
  await expectNoA11yViolations(page);
  await pressUntilFocused(page, confirm.getByRole("button", { name: "Turn on" }));
  await page.keyboard.press("Enter");
  await expect(confirm).toBeHidden();
  await expect(toggle).toBeChecked();
  await expect(section.getByRole("status")).toContainText("AI assistant access is on.");
  await expect(section.getByLabel("MCP server URL")).toHaveValue(/\/functions\/v1\/mcp$/);
  await expectNoA11yViolations(page);

  // Cancel leaves it as it is; then off.
  await toggle.click();
  const off = page.getByRole("dialog", { name: "Turn off AI assistant access?" });
  await off.getByRole("button", { name: "Cancel" }).click();
  await expect(off).toBeHidden();
  await expect(toggle).toBeChecked();
  await toggle.click();
  await off.getByRole("button", { name: "Turn off" }).click();
  await expect(off).toBeHidden();
  await expect(toggle).not.toBeChecked();
  await expect(section.getByRole("status")).toContainText("AI assistant access is off.");
});

test("a person signs in and allows an assistant on the consent page", async ({ page }) => {
  await setAccess(true);
  const name = `E2E Claude ${Date.now()}`;
  const consent = await assistantAsks(name);
  await catchCallback(page);

  // Signed out: sign in first, then back to the consent page.
  await page.goto(consent);
  await expect(page).toHaveURL(/\/sign-in\?redirect=/);
  await signIn(page, MANAGER_EMAIL);
  await expect(page).toHaveURL(/\/oauth\/consent\?authorization_id=/, { timeout: 15_000 });
  await expect(page.getByRole("heading", { name: "Connect an AI assistant" })).toBeVisible();
  await expect(page.getByText(name)).toBeVisible();
  await expect(page.getByText(MANAGER_EMAIL)).toBeVisible();
  await expect(page.getByText("localhost:9876")).toBeVisible();
  await expect(page.getByText("It can only read. It can't change anything.")).toBeVisible();
  await expectNoA11yViolations(page);

  // By keyboard: Allow sends them back to the assistant with a code.
  await pressUntilFocused(page, page.getByRole("button", { name: "Allow" }));
  await page.keyboard.press("Enter");
  await page.waitForURL(/^http:\/\/localhost:9876\/callback\?code=[^&]+&state=e2e$/);
});

test("while access is off a person can only cancel", async ({ page }) => {
  await setAccess(false);
  const consent = await assistantAsks(`E2E ChatGPT ${Date.now()}`);
  await catchCallback(page);
  await page.goto(`/sign-in?redirect=${encodeURIComponent(consent)}`);
  await signIn(page, "erin@acme.test");
  await expect(page).toHaveURL(/\/oauth\/consent\?authorization_id=/, { timeout: 15_000 });
  await expect(page.getByRole("alert")).toContainText("AI assistant access is off for Acme Remote");
  await expect(page.getByRole("button", { name: "Allow" })).toHaveCount(0);
  await expectNoA11yViolations(page);
  await page.getByRole("button", { name: "Cancel" }).click();
  await page.waitForURL(/^http:\/\/localhost:9876\/callback\?error=access_denied/);
});
