import { ADMIN } from "./support/accounts.ts";
import { expect, test } from "./support/fixtures.ts";
import { openAccountMenu, signIn } from "./support/ui.ts";

// Phone-width smoke (PLAN.md section 15, responsive): no horizontal page scroll on the main
// screens, and the sidebar is reachable through its drawer.
test.use({ viewport: { width: 375, height: 700 } });

async function expectNoHorizontalScroll(page: import("@playwright/test").Page, where: string) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, `horizontal overflow on ${where}`).toBeLessThanOrEqual(0);
}

test("phone layout has no horizontal scroll", async ({ page }) => {
  await page.goto("/login");
  await expectNoHorizontalScroll(page, "sign-in");
  await signIn(page, ADMIN);
  await expectNoHorizontalScroll(page, "vault list");

  await page.getByRole("list", { name: "Items" }).getByText("Example Bank Edited").first().click();
  await expect(page.getByRole("link", { name: "Back to list" })).toBeVisible();
  await expectNoHorizontalScroll(page, "item detail");

  await page.getByRole("button", { name: "Open sidebar" }).click();
  await expect(page.getByRole("navigation", { name: "Vaults" })).toBeVisible();
  await page.getByRole("button", { name: "Close", exact: true }).click();

  await openAccountMenu(page, "Settings");
  await expectNoHorizontalScroll(page, "settings");
  await openAccountMenu(page, "Admin");
  await expectNoHorizontalScroll(page, "admin");
});
