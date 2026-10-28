import { expect, type Page } from "@playwright/test";
import { emailMark, waitForEmail } from "./emails.ts";

export interface Credentials {
  email: string;
  password: string;
}

/** Argon2id (64 MiB, 3 passes) runs in the browser worker: give every derive a generous budget. */
export const DERIVE_TIMEOUT = 60_000;

/** The shell is rendered (unlocked, signed in): the account menu only exists then. */
export async function expectInVault(page: Page): Promise<void> {
  await expect(page.getByRole("button", { name: "Account menu" })).toBeVisible({
    timeout: DERIVE_TIMEOUT,
  });
}

/**
 * Reads the 24 recovery words from the recovery kit screen, types the three confirmation words
 * the screen asks for and presses the confirm button. Returns the phrase.
 */
export async function confirmRecoveryKit(
  page: Page,
  confirmLabel: string | RegExp,
): Promise<string> {
  const list = page.getByRole("list", { name: "Recovery words" });
  await expect(list).toBeVisible({ timeout: DERIVE_TIMEOUT });
  const items = list.getByRole("listitem");
  await expect(items).toHaveCount(24);
  const words: string[] = [];
  for (const item of await items.all()) {
    words.push(((await item.locator("span").last().textContent()) ?? "").trim());
  }
  expect(words.every((w) => /^[a-z]+$/.test(w))).toBe(true);

  // The screen asks for three random words: "Word 13", "Word 15", ...
  const labels = await page.getByText(/^Word \d+$/).allTextContents();
  expect(labels).toHaveLength(3);
  for (const label of labels) {
    const position = Number(label.replace("Word ", ""));
    await page.getByLabel(label, { exact: true }).fill(words[position - 1] ?? "");
  }
  await page.getByRole("button", { name: confirmLabel }).click();
  return words.join(" ");
}

/** Opens an invite/setup link, creates the account and finishes the recovery kit screen. */
export async function acceptInvite(page: Page, link: string, password: string): Promise<string> {
  await page.goto(link);
  await expect(page.getByRole("heading", { name: "Create your account" })).toBeVisible();
  await page.getByLabel("Master password").fill(password);
  await page.getByLabel("Confirm password").fill(password);
  await page.getByRole("button", { name: "Create account" }).click();
  const phrase = await confirmRecoveryKit(page, "I saved it, open my vault");
  await expectInVault(page);
  return phrase;
}

export async function signIn(page: Page, { email, password }: Credentials): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Master password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expectInVault(page);
}

export async function openAccountMenu(page: Page, item: string): Promise<void> {
  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("menuitem", { name: item }).click();
}

export async function logOut(page: Page): Promise<void> {
  await openAccountMenu(page, "Log out");
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
}

/** A vault entry in the sidebar. */
export function vaultLink(page: Page, name: string) {
  return page.getByRole("navigation", { name: "Vaults" }).getByRole("link", { name });
}

/**
 * Fires the "tab became visible / window focused" events that make the app sync (TanStack Query
 * refetches on focus; PLAN.md section 15). Unlike a reload this keeps the keys in memory.
 */
export async function triggerFocusSync(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange", { bubbles: true }));
  });
}

/** Reloads the page (which locks the vault: keys live in memory only) and unlocks it again. */
export async function reloadAndUnlock(page: Page, password: string): Promise<void> {
  await page.reload();
  await expect(page.getByRole("heading", { name: "Vault locked" })).toBeVisible();
  await page.getByLabel("Master password").fill(password);
  await page.getByRole("button", { name: "Unlock" }).click();
  await expectInVault(page);
}

/**
 * Keeps firing the focus event until `check` passes. The app only refetches data older than its
 * 10 s stale time, so the first events right after a sync are ignored by design.
 */
export async function syncUntil(page: Page, check: () => Promise<void>): Promise<void> {
  await expect(async () => {
    await triggerFocusSync(page);
    await check();
  }).toPass({ timeout: 45_000, intervals: [1_000, 2_000] });
}

/**
 * As a signed-in admin (unlocked), invites `email` from the Admin screen and returns the invite
 * link taken from the dev email log. The page ends up on the Admin > Invites tab.
 */
export async function inviteUser(admin: Page, email: string): Promise<string> {
  await openAccountMenu(admin, "Admin");
  await admin
    .getByRole("navigation", { name: "Admin sections" })
    .getByRole("link", { name: "Invites" })
    .click();
  const mark = emailMark();
  await admin.getByLabel("Email address").fill(email);
  await admin.getByRole("button", { name: "Send invite" }).click();
  await expect(admin.getByRole("cell", { name: email, exact: true })).toBeVisible();
  const mail = await waitForEmail(email, /invited you/, { since: mark });
  return mail.payload;
}
