import { BOB, BOB_RECOVERED_PASSWORD } from "./support/accounts.ts";
import { emailMark, waitForEmail } from "./support/emails.ts";
import { expect, test } from "./support/fixtures.ts";
import {
  confirmRecoveryKit,
  expectInVault,
  logOut,
  openAccountMenu,
  signIn,
} from "./support/ui.ts";

const NEW_PASSWORD = "Copper-Violet-Sunrise-2468";
const ITEM = "Bob Streaming Login";

// Journey 4: lock and unlock, change the master password, then forget it and get back in with the
// recovery kit. Uses Bob (no admin rights needed) and a fresh item, to prove data survives.
test("lock, password change and recovery with the kit", async ({ page }) => {
  await signIn(page, BOB);
  await page.getByRole("link", { name: "New item" }).click();
  await page.getByLabel("Name", { exact: true }).fill(ITEM);
  await page.getByLabel("Username or email").fill("bob@example.com");
  await page.getByLabel("Password", { exact: true }).fill("not-a-real-password-1");
  await page.getByRole("button", { name: "Create item" }).click();
  await expect(page.getByRole("article", { name: ITEM })).toBeVisible();

  // Lock, fail with a wrong password, unlock.
  await page.getByRole("button", { name: "Lock" }).click();
  await expect(page.getByRole("heading", { name: "Vault locked" })).toBeVisible();
  await page.getByLabel("Master password").fill("this is not the password");
  await page.getByRole("button", { name: "Unlock" }).click();
  await expect(page.getByText("Wrong password.")).toBeVisible();
  await page.getByLabel("Master password").fill(BOB.password);
  await expect(page.getByRole("button", { name: "Unlock" })).toBeEnabled({ timeout: 30_000 });
  await page.getByRole("button", { name: "Unlock" }).click();
  await expectInVault(page);
  await page.getByRole("list", { name: "Items" }).getByText(ITEM).click();
  await expect(page.getByRole("article", { name: ITEM })).toBeVisible();

  // Change the master password.
  await openAccountMenu(page, "Settings");
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  await page.getByLabel("Current password").fill(BOB.password);
  await page.getByLabel("New password", { exact: true }).fill(NEW_PASSWORD);
  await page.getByLabel("Confirm password").fill(NEW_PASSWORD);
  await page.getByRole("button", { name: "Change password" }).click();
  await expect(page.getByText("Master password changed.")).toBeVisible();

  // Old password no longer signs in; the new one does, with the item intact.
  await logOut(page);
  await page.getByLabel("Email").fill(BOB.email);
  await page.getByLabel("Master password").fill(BOB.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("Incorrect email or password.")).toBeVisible();
  await page.getByLabel("Master password").fill(NEW_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expectInVault(page);
  await expect(page.getByRole("list", { name: "Items" }).getByText(ITEM)).toBeVisible();

  // Replace the recovery kit and keep the new words (the first kit was not kept by journey 1).
  await openAccountMenu(page, "Settings");
  await page.getByRole("button", { name: "Generate a new recovery kit" }).click();
  await page.getByRole("button", { name: "Generate", exact: true }).click();
  const phrase = await confirmRecoveryKit(page, "Replace my recovery kit");
  await expect(page.getByText("Your new recovery kit is active.")).toBeVisible();

  // Forgot password: email code + the 24 words.
  await logOut(page);
  await page.getByRole("link", { name: "Forgot password?" }).click();
  await expect(page.getByRole("heading", { name: "Forgot your password?" })).toBeVisible();
  const mark = emailMark();
  await page.getByLabel("Email").fill(BOB.email);
  await page.getByRole("button", { name: "Email me a code" }).click();
  const mail = await waitForEmail(BOB.email, /recovery code/, { since: mark });
  expect(mail.payload).toMatch(/^\d{6}$/);
  await expect(page.getByRole("heading", { name: "Verify it is you" })).toBeVisible();
  await page.getByLabel("Email code").fill(mail.payload);
  await page.getByLabel("Recovery phrase").fill(phrase);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "Choose a new master password" })).toBeVisible({
    timeout: 60_000,
  });
  await page.getByLabel("Master password").fill(BOB_RECOVERED_PASSWORD);
  await page.getByLabel("Confirm password").fill(BOB_RECOVERED_PASSWORD);
  await page.getByRole("button", { name: "Set password and sign in" }).click();

  // Signed in again and asked for a new kit (the typed one is considered used).
  await expect(page.getByRole("heading", { name: "Password changed" })).toBeVisible({
    timeout: 60_000,
  });
  await page.getByRole("button", { name: "Create a new recovery kit" }).click();
  await expect(page.getByRole("heading", { name: "Save your new recovery kit" })).toBeVisible();
  const newPhrase = await confirmRecoveryKit(page, "I saved it, open my vault");
  expect(newPhrase).not.toBe(phrase);
  await expectInVault(page);
  await expect(page.getByRole("list", { name: "Items" }).getByText(ITEM)).toBeVisible();
  await page.getByRole("list", { name: "Items" }).getByText(ITEM).click();
  await page.getByRole("button", { name: "Reveal password" }).click();
  await expect(page.getByTestId("secret-Password")).toHaveText("not-a-real-password-1");

  // The recovered password works for a fresh sign-in.
  await logOut(page);
  await signIn(page, { email: BOB.email, password: BOB_RECOVERED_PASSWORD });
  await expect(page.getByRole("list", { name: "Items" }).getByText(ITEM)).toBeVisible();
});
