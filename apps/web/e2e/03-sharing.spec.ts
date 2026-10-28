import { ADMIN, BOB } from "./support/accounts.ts";
import { expect, test } from "./support/fixtures.ts";
import { expectShownCodeIsCurrent } from "./support/totp.ts";
import { reloadAndUnlock, signIn, syncUntil, vaultLink } from "./support/ui.ts";

const VAULT = "Team Vault";
// The item journey 2 left behind.
const EDITED_NAME = "Example Bank Edited";

// Journey 3: share a vault with a viewer, check what the viewer can and cannot do, then remove
// them (key rotation) and check that access is gone while the owner still reads everything.
test("sharing, viewer limits and revoke with key rotation", async ({ page, newUser }) => {
  // Admin: new vault, move the item into it, share the vault with Bob as viewer.
  await signIn(page, ADMIN);
  await page.getByRole("button", { name: "+ New vault" }).click();
  await page.getByLabel("Name", { exact: true }).fill(VAULT);
  await page.getByRole("button", { name: "Create vault" }).click();
  await expect(vaultLink(page, VAULT)).toBeVisible();

  await page.getByRole("link", { name: /^All items/ }).click();
  await page.getByRole("list", { name: "Items" }).getByText(EDITED_NAME).click();
  await page.getByRole("button", { name: "Move", exact: true }).click();
  await page.getByLabel("Target vault").selectOption({ label: `${VAULT} (Owner)` });
  await page.getByRole("button", { name: "Move", exact: true }).last().click();

  await vaultLink(page, VAULT).click();
  await page.getByRole("list", { name: "Items" }).getByText(EDITED_NAME).click();
  const adminDetail = page.getByRole("article", { name: EDITED_NAME });
  await expectShownCodeIsCurrent(() => adminDetail.getByTestId("totp-code").textContent());

  await page.getByRole("button", { name: "Vault menu" }).click();
  await page.getByRole("menuitem", { name: "Share and members…" }).click();
  const share = page.getByRole("dialog", { name: `Share “${VAULT}”` });
  await share.getByLabel("Email address").fill(BOB.email);
  await share.getByRole("button", { name: "Find person" }).click();
  await expect(share.getByText(`Found ${BOB.email}`)).toBeVisible();
  await share.getByLabel("Role").selectOption("viewer");
  await share.getByRole("button", { name: "Send invitation" }).click();
  await expect(share.getByText(`Invitation sent to ${BOB.email}`)).toBeVisible();
  await expect(share.getByRole("listitem").filter({ hasText: BOB.email })).toContainText("Invited");
  await share.getByRole("button", { name: "Close" }).first().click();

  // Bob: sees the invitation, accepts it, reads the item and the same TOTP code.
  const bob = await newUser();
  await signIn(bob, BOB);
  await bob.getByRole("link", { name: /^Invitations/ }).click();
  await expect(bob.getByText(`From ${ADMIN.email}`)).toBeVisible();
  await bob.getByRole("button", { name: "Accept" }).click();
  await expect(vaultLink(bob, VAULT)).toBeVisible();
  await vaultLink(bob, VAULT).click();
  await bob.getByRole("list", { name: "Items" }).getByText(EDITED_NAME).click();
  const bobDetail = bob.getByRole("article", { name: EDITED_NAME });
  await expect(bobDetail).toBeVisible();
  await expectShownCodeIsCurrent(() => bobDetail.getByTestId("totp-code").textContent());

  // Viewer limits: no write actions in the UI, and the server refuses a trash request.
  await expect(bobDetail.getByRole("link", { name: "Edit" })).toHaveCount(0);
  await expect(bobDetail.getByRole("button", { name: "Move to trash" })).toHaveCount(0);
  await expect(bobDetail.getByRole("button", { name: "Share" })).toHaveCount(0);
  const itemId = new URL(bob.url()).searchParams.get("item");
  expect(itemId).toBeTruthy();
  const refused = await bob.request.post(`/api/items/${itemId}/trash`, {
    headers: { Origin: new URL(bob.url()).origin },
    data: {},
  });
  expect(refused.status()).toBe(403);

  // Admin removes Bob. The rotation runs right away and re-encrypts the vault.
  await page.getByRole("button", { name: "Vault menu" }).click();
  await page.getByRole("menuitem", { name: "Share and members…" }).click();
  await share.getByRole("button", { name: `Remove ${BOB.email}` }).click();
  await page.getByRole("button", { name: "Remove and rotate key" }).click();
  const rotation = page.getByRole("dialog", { name: "Vault key rotated" });
  await expect(rotation).toBeVisible();
  await rotation.getByRole("button", { name: "Done" }).click();

  // Bob's sidebar loses the vault after the next sync, and the server no longer serves it.
  await syncUntil(bob, () => expect(vaultLink(bob, VAULT)).toHaveCount(0, { timeout: 1_500 }));
  await expect(bob.getByRole("list", { name: "Items" }).getByText(EDITED_NAME)).toHaveCount(0);
  const bobSync = await bob.request.get("/api/sync");
  expect(bobSync.ok()).toBe(true);
  expect(JSON.stringify(await bobSync.json())).not.toContain(itemId ?? "unreachable");

  // Admin still reads the item, also from scratch (reload, unlock, full sync under the new key).
  await reloadAndUnlock(page, ADMIN.password);
  await vaultLink(page, VAULT).click();
  await page.getByRole("list", { name: "Items" }).getByText(EDITED_NAME).click();
  const after = page.getByRole("article", { name: EDITED_NAME });
  await expectShownCodeIsCurrent(() => after.getByTestId("totp-code").textContent());
  await page.getByRole("button", { name: "Vault menu" }).click();
  await page.getByRole("menuitem", { name: "Share and members…" }).click();
  await expect(share.getByText(BOB.email)).toHaveCount(0);
});
