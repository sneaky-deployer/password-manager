import { expect, test } from "@playwright/test";

test("home page loads and reaches the API", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Password Manager" })).toBeVisible();
  await expect(page.getByText("API status: ok")).toBeVisible();
});
