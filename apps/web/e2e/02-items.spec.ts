import { ADMIN } from "./support/accounts.ts";
import { expect, test } from "./support/fixtures.ts";
import { expectShownCodeIsCurrent, TOTP_SECRET } from "./support/totp.ts";
import { signIn } from "./support/ui.ts";

const ITEM_NAME = "Example Bank";

// Journey 2: create a login with a generated password and a TOTP secret, read the live code,
// search, edit, trash and restore.
test("items, generator and TOTP", async ({ page }) => {
  await signIn(page, ADMIN);
  await page.getByRole("link", { name: "New item" }).click();
  await expect(page.getByRole("heading", { name: "New item" })).toBeVisible();

  await page.getByLabel("Name", { exact: true }).fill(ITEM_NAME);
  await page.getByLabel("Username or email").fill("alice@example.com");

  // Password from the generator dialog.
  await page.getByRole("button", { name: "Generate", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Generate a password" });
  await expect(dialog).toBeVisible();
  const generated = (await dialog.getByTestId("generator-output").textContent()) ?? "";
  expect(generated.length).toBeGreaterThanOrEqual(8);
  await dialog.getByRole("button", { name: "Regenerate" }).click();
  const regenerated = (await dialog.getByTestId("generator-output").textContent()) ?? "";
  expect(regenerated).not.toBe(generated);
  await dialog.getByRole("button", { name: "Use this password" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByLabel("Password", { exact: true })).toHaveValue(regenerated);

  // TOTP secret: the editor previews the live code.
  await page.getByLabel("Authenticator key").fill(TOTP_SECRET);
  await expect(page.getByTestId("totp-preview")).toBeVisible();
  await page.getByRole("button", { name: "Create item" }).click();

  // Detail: the 6-digit code equals what @pm/otp computes for the current time, with a countdown.
  const detail = page.getByRole("article", { name: ITEM_NAME });
  await expect(detail).toBeVisible();
  const code = detail.getByTestId("totp-code");
  await expect(code).toHaveText(/^\d{3} \d{3}$/);
  await expectShownCodeIsCurrent(() => code.textContent());
  const countdown = detail.getByRole("timer", { name: "Seconds until the code changes" });
  await expect(countdown).toHaveText(/^\d{1,2}$/);
  const seconds = Number(await countdown.textContent());
  expect(seconds).toBeGreaterThanOrEqual(1);
  expect(seconds).toBeLessThanOrEqual(30);

  // The password reveals to the generated value.
  await detail.getByRole("button", { name: "Reveal password" }).click();
  await expect(detail.getByTestId("secret-Password")).toHaveText(regenerated);

  // Search finds the item (and not for gibberish).
  const search = page.getByLabel("Search items");
  await search.fill("exampl");
  await expect(page.getByRole("list", { name: "Items" }).getByText(ITEM_NAME)).toBeVisible();
  await search.fill("zzz-no-such-item");
  await expect(page.getByText("No matches")).toBeVisible();
  await search.fill("alice@");
  await expect(page.getByRole("list", { name: "Items" }).getByText(ITEM_NAME)).toBeVisible();
  await search.fill("");

  // Edit: rename, add a website; the code survives the edit.
  await page.getByRole("list", { name: "Items" }).getByText(ITEM_NAME).click();
  await detail.getByRole("link", { name: "Edit" }).click();
  await expect(page.getByRole("heading", { name: "Edit item" })).toBeVisible();
  await page.getByLabel("Name", { exact: true }).fill(`${ITEM_NAME} Edited`);
  await page.getByRole("button", { name: "Save changes" }).click();
  const edited = page.getByRole("article", { name: `${ITEM_NAME} Edited` });
  await expect(edited).toBeVisible();
  await expectShownCodeIsCurrent(() => edited.getByTestId("totp-code").textContent());

  // Trash and restore.
  await edited.getByRole("button", { name: "Move to trash" }).click();
  await expect(page.getByRole("list", { name: "Items" })).toHaveCount(0);
  await page.getByRole("link", { name: /^Trash/ }).click();
  await page.getByRole("list", { name: "Items" }).getByText(`${ITEM_NAME} Edited`).click();
  await page.getByRole("button", { name: "Restore" }).click();
  await page.getByRole("link", { name: /^All items/ }).click();
  await expect(
    page.getByRole("list", { name: "Items" }).getByText(`${ITEM_NAME} Edited`),
  ).toBeVisible();
});
