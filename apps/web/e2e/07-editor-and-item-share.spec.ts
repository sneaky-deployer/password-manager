import { ADMIN, BOB, BOB_RECOVERED_PASSWORD } from "./support/accounts.ts";
import { expect, test } from "./support/fixtures.ts";
import { reloadAndUnlock, signIn, syncUntil, vaultLink } from "./support/ui.ts";

const VAULT = "Team Vault";
const SHARED_ITEM = "Example Bank Edited";
const BOBS_ITEM = "Bob Streaming Login";

// Journey 7 (extra): re-inviting a removed member as editor, an edit by that editor reaching the
// owner, a single-item share and its revocation, and a deep link surviving the lock screen.
test("editor role, item share and deep link", async ({ page, newUser }) => {
  const bob = await newUser();
  await signIn(page, ADMIN);
  await signIn(bob, { email: BOB.email, password: BOB_RECOVERED_PASSWORD });

  // Admin invites Bob to the Team Vault again, now as editor (he was removed in journey 3).
  await vaultLink(page, VAULT).click();
  await page.getByRole("button", { name: "Vault menu" }).click();
  await page.getByRole("menuitem", { name: "Share and members…" }).click();
  const share = page.getByRole("dialog", { name: `Share “${VAULT}”` });
  await share.getByLabel("Email address").fill(BOB.email);
  await share.getByRole("button", { name: "Find person" }).click();
  await share.getByLabel("Role").selectOption("editor");
  await share.getByRole("button", { name: "Send invitation" }).click();
  await expect(share.getByText(`Invitation sent to ${BOB.email}`)).toBeVisible();
  await share.getByRole("button", { name: "Close" }).first().click();

  // Bob accepts (the invitation list refreshes on focus) and edits the item.
  await bob.getByRole("link", { name: /^Invitations/ }).click();
  await syncUntil(bob, () =>
    expect(bob.getByRole("button", { name: "Accept" })).toBeVisible({ timeout: 1_500 }),
  );
  await bob.getByRole("button", { name: "Accept" }).click();
  await vaultLink(bob, VAULT).click();
  await bob.getByRole("list", { name: "Items" }).getByText(SHARED_ITEM).click();
  await bob.getByRole("link", { name: "Edit", exact: true }).click();
  await bob.getByLabel("Name", { exact: true }).fill(`${SHARED_ITEM} by Bob`);
  await bob.getByRole("button", { name: "Save changes" }).click();
  await expect(bob.getByRole("article", { name: `${SHARED_ITEM} by Bob` })).toBeVisible();
  // PLAN.md 11.1: editors may trash, but sharing and moving need a manager or the owner.
  await expect(bob.getByRole("button", { name: "Move to trash" })).toBeVisible();
  await expect(bob.getByRole("button", { name: "Share", exact: true })).toHaveCount(0);

  // The owner sees the editor's change after the next sync.
  await syncUntil(page, () =>
    expect(
      page.getByRole("list", { name: "Items" }).getByText(`${SHARED_ITEM} by Bob`),
    ).toBeVisible({ timeout: 1_500 }),
  );

  // Bob shares one item of his own Personal vault with the admin; the admin reads it.
  await bob
    .getByRole("navigation", { name: "Vaults" })
    .getByRole("link", { name: "Personal" })
    .click();
  await bob.getByRole("list", { name: "Items" }).getByText(BOBS_ITEM).click();
  await bob.getByRole("button", { name: "Share", exact: true }).click();
  const itemShare = bob.getByRole("dialog", { name: /^Share/ });
  await itemShare.getByLabel("Email address").fill(ADMIN.email);
  await itemShare.getByRole("button", { name: "Find person" }).click();
  await itemShare.getByRole("button", { name: "Share item" }).click();
  await expect(itemShare.getByText(`Invitation sent to ${ADMIN.email}`)).toBeVisible();
  await itemShare.getByRole("button", { name: "Close" }).first().click();

  await page.getByRole("link", { name: /^Invitations/ }).click();
  await syncUntil(page, () =>
    expect(page.getByRole("button", { name: "Accept" })).toBeVisible({ timeout: 1_500 }),
  );
  await page.getByRole("button", { name: "Accept" }).click();
  await page.getByRole("link", { name: /^Shared with me/ }).click();
  await page.getByRole("list", { name: "Items" }).getByText(BOBS_ITEM).click();
  const sharedDetail = page.getByRole("article", { name: BOBS_ITEM });
  await sharedDetail.getByRole("button", { name: "Reveal password" }).click();
  await expect(sharedDetail.getByTestId("secret-Password")).toHaveText("not-a-real-password-1");

  // Deep link: reload on this item, unlock, and land on the same item again.
  const deepLink = page.url();
  await reloadAndUnlock(page, ADMIN.password);
  await expect(page).toHaveURL(deepLink);
  await expect(page.getByRole("article", { name: BOBS_ITEM })).toBeVisible();

  // Bob revokes the item share: the admin's copy disappears after sync.
  await bob.getByRole("button", { name: "Share", exact: true }).click();
  await itemShare.getByRole("button", { name: `Revoke access of ${ADMIN.email}` }).click();
  await bob.getByRole("button", { name: "Revoke access", exact: true }).click();
  // The dialog stays open through the key rotation and shows the notice (it used to vanish when the
  // item's new revision swapped the detail pane to a spinner).
  await expect(itemShare.getByText(/They no longer have access/)).toBeVisible();
  await expect(itemShare.getByText("Not shared with anyone yet.")).toBeVisible();
  await page.getByRole("link", { name: /^Shared with me/ }).click();
  await syncUntil(page, () =>
    expect(page.getByRole("list", { name: "Items" }).getByText(BOBS_ITEM)).toHaveCount(0, {
      timeout: 1_500,
    }),
  );
});
