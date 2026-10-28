import { defineConfig, devices } from "@playwright/test";

// Not run in CI yet. Start with `bun run test:e2e` from apps/web; the dev servers
// (Vite on 5173 + wrangler dev on 8787) are started automatically.
// Set PW_CHROMIUM_EXECUTABLE to use a Chromium that `playwright install` did not download.
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  reporter: "list",
  use: { baseURL: "http://localhost:5173", trace: "on-first-retry" },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: { executablePath: process.env.PW_CHROMIUM_EXECUTABLE || undefined },
      },
    },
  ],
  webServer: {
    command: "bun run dev",
    cwd: "../..",
    url: "http://localhost:5173",
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
