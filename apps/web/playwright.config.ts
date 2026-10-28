import { defineConfig, devices } from "@playwright/test";
import { E2E_ORIGIN } from "./e2e/support/env.ts";

// `bun run test:e2e` (repo root) builds the SPA, then runs this. globalSetup starts an isolated
// `wrangler dev` (own config, own local D1, SPA served from apps/web/dist) and tees its output
// to a log file, which is where dev emails (invite links, email codes) are read from.
// The specs are ordered journeys that share that one server and its database: run them together.
// Set PW_CHROMIUM_EXECUTABLE to use a Chromium that `playwright install` did not download.
export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.spec.ts",
  globalSetup: "./e2e/support/global-setup.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: E2E_ORIGIN,
    trace: process.env.CI ? "retain-on-failure" : "off",
    screenshot: "only-on-failure",
    actionTimeout: 20_000,
    navigationTimeout: 30_000,
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: { executablePath: process.env.PW_CHROMIUM_EXECUTABLE || undefined },
      },
    },
  ],
});
