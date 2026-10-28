import { generateTotp } from "@pm/otp";
import { ADMIN } from "./support/accounts.ts";
import { expect, test } from "./support/fixtures.ts";
import {
  acceptInvite,
  expectInVault,
  inviteUser,
  logOut,
  openAccountMenu,
  signIn,
} from "./support/ui.ts";

const DAVE = { email: "dave@e2e.test", password: "Quartz-Meadow-Lantern-6027" };

async function startSignIn(page: import("@playwright/test").Page, password: string): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Email").fill(DAVE.email);
  await page.getByLabel("Master password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

// Extra journey: sign-in 2FA (TOTP and a single-use backup code) against the real server, then an
// admin disables and re-enables the account. Not in the Phase 6 list but it exercises the server's
// encrypted TOTP secret, replay protection and session revocation end to end.
test("two-factor sign-in, backup codes and admin disable", async ({ page, newUser }) => {
  await signIn(page, ADMIN);
  const link = await inviteUser(page, DAVE.email);

  const dave = await newUser();
  await acceptInvite(dave, link, DAVE.password);

  // Turn on the authenticator app with the secret the server generated.
  await openAccountMenu(dave, "Settings");
  await dave.getByRole("button", { name: "Set up authenticator app" }).click();
  const secret = ((await dave.getByTestId("totp-secret").textContent()) ?? "").replace(/\s/g, "");
  expect(secret).toMatch(/^[A-Z2-7]{16,}$/);
  const otp = { secret, algorithm: "SHA1", digits: 6, period: 30 } as const;
  await dave.getByLabel("Verification code").fill(generateTotp(otp));
  await dave.getByRole("button", { name: "Turn on" }).click();

  // Turning 2FA on shows the first set of backup codes, once.
  const codesDialog = dave.getByRole("dialog", { name: "Your backup codes" });
  await expect(codesDialog).toBeVisible();
  const codes = (await codesDialog.getByRole("listitem").allTextContents()).map((c) => c.trim());
  expect(codes.length).toBeGreaterThanOrEqual(8);
  await codesDialog.getByLabel("I saved these codes").check();
  await codesDialog.getByRole("button", { name: "Done" }).click();
  await expect(codesDialog).toBeHidden();
  await expect(dave.getByText("On", { exact: true }).first()).toBeVisible();

  // Sign in again: the password alone is not enough. The code of the current step was used to
  // enable 2FA (replay protection), so use the next step's code, which the server also accepts.
  await logOut(dave);
  await startSignIn(dave, DAVE.password);
  await expect(dave.getByRole("heading", { name: "Two-step verification" })).toBeVisible();
  await dave.getByLabel("6-digit code").fill("000000");
  await dave.getByRole("button", { name: "Verify" }).click();
  await expect(
    dave
      .getByRole("alert")
      .or(dave.getByText(/incorrect|invalid|wrong/i))
      .first(),
  ).toBeVisible();
  await dave.getByLabel("6-digit code").fill(generateTotp(otp, Date.now() + 30_000));
  await dave.getByRole("button", { name: "Verify" }).click();
  await expectInVault(dave);

  // A backup code works once.
  await logOut(dave);
  await startSignIn(dave, DAVE.password);
  await dave.getByRole("tab", { name: "Backup code" }).click();
  await dave.getByLabel("Backup code").fill(codes[0] ?? "");
  await dave.getByRole("button", { name: "Verify" }).click();
  await expectInVault(dave);
  await logOut(dave);
  await startSignIn(dave, DAVE.password);
  await dave.getByRole("tab", { name: "Backup code" }).click();
  await dave.getByLabel("Backup code").fill(codes[0] ?? "");
  await dave.getByRole("button", { name: "Verify" }).click();
  await expect(dave.getByRole("heading", { name: "Two-step verification" })).toBeVisible();
  await expect(dave.getByRole("button", { name: "Account menu" })).toHaveCount(0);

  // Admin disables the account: sign-in is refused. Enabling it again restores access.
  await page
    .getByRole("navigation", { name: "Admin sections" })
    .getByRole("link", { name: "Users" })
    .click();
  await page.getByRole("button", { name: `Disable ${DAVE.email}` }).click();
  await expect(page.getByRole("button", { name: `Enable ${DAVE.email}` })).toBeVisible();
  await dave.goto("/login");
  await startSignIn(dave, DAVE.password);
  await expect(dave.getByRole("button", { name: "Account menu" })).toHaveCount(0);
  await expect(dave.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await page.getByRole("button", { name: `Enable ${DAVE.email}` }).click();
  await expect(page.getByRole("button", { name: `Disable ${DAVE.email}` })).toBeVisible();
});
