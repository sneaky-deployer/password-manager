import { ADMIN, BOB, BOB_RECOVERED_PASSWORD } from "./support/accounts.ts";
import { emailMark, waitForEmail } from "./support/emails.ts";
import { expect, test } from "./support/fixtures.ts";
import {
  confirmRecoveryKit,
  expectInVault,
  logOut,
  openAccountMenu,
  signIn,
  vaultLink,
} from "./support/ui.ts";

const BOB_THIRD_PASSWORD = "Ember-Walnut-Cascade-8841";
const DAVE = { email: "dave@e2e.test", oldPassword: "Quartz-Meadow-Lantern-6027" };
const DAVE_NEW_PASSWORD = "Basalt-Ferry-Nectar-3350";

// Journey 8 (extra): resetting the master password from an unlocked device with an email code,
// an admin resetting an account (data wiped, 2FA cleared, fresh invite) and a vault rename/delete.
test("reset from an unlocked device, admin account reset, vault rename and delete", async ({
  page,
  newUser,
}) => {
  // Bob, unlocked, sets a new password with an emailed code instead of the old password.
  await signIn(page, { email: BOB.email, password: BOB_RECOVERED_PASSWORD });
  await openAccountMenu(page, "Settings");
  await page.getByRole("button", { name: "I don't remember my current password" }).click();
  const mark = emailMark();
  await page.getByRole("button", { name: "Email me a code" }).click();
  const mail = await waitForEmail(BOB.email, /confirmation code/, { since: mark });
  expect(mail.payload).toMatch(/^\d{6}$/);
  await page.getByLabel("Email code").fill(mail.payload);
  await page.getByLabel("New password", { exact: true }).fill(BOB_THIRD_PASSWORD);
  await page.getByLabel("Confirm password").fill(BOB_THIRD_PASSWORD);
  await page.getByRole("button", { name: "Change password" }).click();
  await expect(page.getByText("Master password changed.")).toBeVisible();
  await logOut(page);
  await signIn(page, { email: BOB.email, password: BOB_THIRD_PASSWORD });

  // Vault: create, rename, delete.
  await page.getByRole("button", { name: "+ New vault" }).click();
  await page.getByLabel("Name", { exact: true }).fill("Scratch");
  await page.getByRole("button", { name: "Create vault" }).click();
  await vaultLink(page, "Scratch").click();
  await page.getByRole("button", { name: "Vault menu" }).click();
  await page.getByRole("menuitem", { name: "Rename…" }).click();
  await page.getByLabel("Name", { exact: true }).fill("Scratch renamed");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Scratch renamed" })).toBeVisible();
  await page.getByRole("button", { name: "Vault menu" }).click();
  await page.getByRole("menuitem", { name: "Delete vault…" }).click();
  await page.getByRole("button", { name: "Delete vault", exact: true }).click();
  await expect(vaultLink(page, "Scratch renamed")).toHaveCount(0);

  // Admin resets Dave's account (he has 2FA on and no recovery kit at hand).
  const admin = await newUser();
  await signIn(admin, ADMIN);
  await openAccountMenu(admin, "Admin");
  await admin
    .getByRole("navigation", { name: "Admin sections" })
    .getByRole("link", { name: "Users" })
    .click();
  const resetMark = emailMark();
  await admin.getByRole("button", { name: `Reset account of ${DAVE.email}` }).click();
  await admin.getByRole("button", { name: "Reset account", exact: true }).click();
  const invite = await waitForEmail(DAVE.email, /Set a new master password/, { since: resetMark });

  const dave = await newUser();
  await dave.goto(invite.payload);
  await expect(dave.getByRole("heading", { name: "Set a new master password" })).toBeVisible();
  await dave.getByLabel("Master password").fill(DAVE_NEW_PASSWORD);
  await dave.getByLabel("Confirm password").fill(DAVE_NEW_PASSWORD);
  await dave.getByRole("button", { name: "Set password" }).click();
  await confirmRecoveryKit(dave, "I saved it, open my vault");
  await expectInVault(dave);
  await expect(vaultLink(dave, "Personal")).toBeVisible();

  // The old password and the old 2FA are gone: a plain sign-in with the new password works.
  await logOut(dave);
  await dave.getByLabel("Email").fill(DAVE.email);
  await dave.getByLabel("Master password").fill(DAVE.oldPassword);
  await dave.getByRole("button", { name: "Sign in" }).click();
  await expect(dave.getByText("Incorrect email or password.")).toBeVisible();
  await dave.getByLabel("Master password").fill(DAVE_NEW_PASSWORD);
  await dave.getByRole("button", { name: "Sign in" }).click();
  await expectInVault(dave);
});
