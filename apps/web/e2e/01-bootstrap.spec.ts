import { ADMIN, BOB } from "./support/accounts.ts";
import { emailMark, waitForEmail } from "./support/emails.ts";
import { expect, test } from "./support/fixtures.ts";
import { acceptInvite, expectInVault, inviteUser, vaultLink } from "./support/ui.ts";

// Journey 1 (PLAN.md section 16, Phase 6): admin bootstrap, then an invite for a second user.
// Later specs sign in as these two accounts, so this file must run first (files run in name order).
test("admin bootstrap and invite", async ({ page, newUser }) => {
  // Setup link: the SPA offers it while no admin exists; the link only exists in the dev email log.
  await page.goto("/");
  await expect(page).toHaveURL(/\/login$/);
  await page.goto("/setup");
  const setupMark = emailMark();
  await page.getByRole("button", { name: "Email me the setup link" }).click();
  await expect(page.getByRole("heading", { name: "Check your inbox" })).toBeVisible();
  const setup = await waitForEmail(ADMIN.email, /Set up your Password Manager/, {
    since: setupMark,
  });
  expect(setup.payload).toMatch(/\/invite#t=/);

  // Account creation, recovery kit (24 words, 3 confirmed), then the vault.
  const adminPhrase = await acceptInvite(page, setup.payload, ADMIN.password);
  expect(adminPhrase.split(" ")).toHaveLength(24);
  await expect(vaultLink(page, "Personal")).toBeVisible();
  // The token left the address bar.
  expect(page.url()).not.toContain("#t=");

  // Once an admin exists the setup page is gone.
  const status = await page.request.get("/api/setup/status");
  expect(await status.json()).toEqual({ needsSetup: false });

  // Admin invites Bob.
  const inviteLink = await inviteUser(page, BOB.email);

  // Bob, in his own browser, accepts the invite.
  const bob = await newUser();
  const bobPhrase = await acceptInvite(bob, inviteLink, BOB.password);
  expect(bobPhrase.split(" ")).toHaveLength(24);
  expect(bobPhrase).not.toBe(adminPhrase);
  await expectInVault(bob);
  await expect(vaultLink(bob, "Personal")).toBeVisible();
  // Bob is a plain user: no admin entry in his menu.
  await bob.getByRole("button", { name: "Account menu" }).click();
  await expect(bob.getByRole("menuitem", { name: "Settings" })).toBeVisible();
  await expect(bob.getByRole("menuitem", { name: "Admin" })).toHaveCount(0);
});
