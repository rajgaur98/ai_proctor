import { defineConfig } from "@playwright/test";

// Smoke test against a local Supabase (`pnpm db:start`) and the Vite dev server.
// Locally it drives the installed Chrome; CI installs Playwright's Chromium.
export default defineConfig({
  testDir: "e2e",
  timeout: 30_000,
  // Tests share the seed users (one clocks Erin in while another clocks her out).
  workers: 1,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: "http://localhost:5173",
    ...(process.env.CI ? {} : { channel: "chrome" }),
  },
  webServer: {
    command: "pnpm dev",
    url: "http://localhost:5173",
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
