import { readFileSync } from "node:fs";
import { SECURITY_HEADERS } from "@pm/shared";
import { ADMIN } from "./support/accounts.ts";
import { E2E_LOG } from "./support/env.ts";
import { expect, test } from "./support/fixtures.ts";
import { TOTP_SECRET } from "./support/totp.ts";
import { openAccountMenu, signIn } from "./support/ui.ts";

const ALLOWED_LOCAL_STORAGE_KEYS = ["pm.theme", "pm.generator.options.v1"];
const SESSION_COOKIE = "pm_session"; // development name; production uses __Host-pm_session
const SECRET_ITEM_PASSWORD = "smoke-test-secret-password-9931";

// Journey 5: the auto-use `monitor` fixture fails every test in this suite on a CSP violation or an
// uncaught page error. This spec additionally walks the whole app so most screens are covered, and
// checks the cookie, browser storage, response headers and the server log.
test("security smoke: cookie, storage, headers, CSP and logs", async ({ page, context }) => {
  // Headers: the same CSP and friends on the HTML, a static asset and an API response.
  const html = await page.request.get("/login");
  const scriptSrc = /src="(\/assets\/[^"]+\.js)"/.exec(await html.text())?.[1];
  expect(scriptSrc, "bundle referenced by index.html").toBeTruthy();
  const asset = await page.request.get(scriptSrc ?? "/");
  const api = await page.request.get("/api/health");
  for (const response of [html, asset, api]) {
    expect(response.ok()).toBe(true);
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      expect(response.headers()[name.toLowerCase()], `${name} on ${response.url()}`).toBe(value);
    }
  }

  await signIn(page, ADMIN);

  // Walk the app: item with a secret and a TOTP key, generator, settings tabs, admin tabs, theme.
  await page.getByRole("link", { name: "New item" }).click();
  await page.getByLabel("Name", { exact: true }).fill("Smoke item");
  await page.getByLabel("Password", { exact: true }).fill(SECRET_ITEM_PASSWORD);
  await page.getByLabel("Authenticator key").fill(TOTP_SECRET);
  await page.getByRole("button", { name: "Create item" }).click();
  await expect(page.getByRole("article", { name: "Smoke item" })).toBeVisible();

  await page.getByRole("link", { name: "Generator", exact: true }).click();
  await expect(page.getByTestId("generator-output")).toBeVisible();
  await page.getByText("Passphrase", { exact: true }).click();
  await expect(page.getByLabel("Include a number")).toBeVisible();

  await openAccountMenu(page, "Settings");
  const settingsNav = page.getByRole("navigation", { name: "Settings sections" });
  for (const tab of ["Sessions", "Activity", "Preferences", "Danger zone", "Security"]) {
    await settingsNav.getByRole("link", { name: tab }).click();
    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  }
  await settingsNav.getByRole("link", { name: "Preferences" }).click();
  await page.getByLabel("Dark").check();
  await expect(page.locator("html")).toHaveClass(/dark/);

  await openAccountMenu(page, "Admin");
  await page
    .getByRole("navigation", { name: "Admin sections" })
    .getByRole("link", { name: "Users" })
    .click();
  await expect(page.getByRole("cell", { name: new RegExp(`^${ADMIN.email}`) })).toBeVisible();

  // The session cookie is HttpOnly and invisible to scripts.
  const cookies = await context.cookies();
  const session = cookies.find((c) => c.name === SESSION_COOKIE);
  expect(session, "session cookie").toBeTruthy();
  expect(session?.httpOnly).toBe(true);
  expect(session?.sameSite).toBe("Strict");
  expect(session?.path).toBe("/");
  expect(await page.evaluate(() => document.cookie)).toBe("");

  // Nothing sensitive in browser storage: only the two preference keys, and no secrets in them.
  const storage = await page.evaluate(async () => ({
    local: Object.fromEntries(Object.entries(localStorage)),
    sessionKeys: Object.keys(sessionStorage),
    databases: (await indexedDB.databases()).map((db) => db.name),
  }));
  expect(Object.keys(storage.local).every((k) => ALLOWED_LOCAL_STORAGE_KEYS.includes(k))).toBe(
    true,
  );
  expect(storage.sessionKeys).toEqual([]);
  expect(storage.databases).toEqual([]);
  const stored = JSON.stringify(storage.local);
  for (const secret of [ADMIN.password, SECRET_ITEM_PASSWORD, TOTP_SECRET]) {
    expect(stored).not.toContain(secret);
  }

  // The server never saw (or logged) any of the plaintext secrets.
  const log = readFileSync(E2E_LOG, "utf8");
  for (const secret of [ADMIN.password, SECRET_ITEM_PASSWORD, TOTP_SECRET]) {
    expect(log).not.toContain(secret);
  }
});
