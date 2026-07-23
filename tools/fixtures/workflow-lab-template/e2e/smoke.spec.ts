import { expect, test } from "@playwright/test";

test("renders the seeded taskboard", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Taskboard", exact: true })).toBeVisible();
  await expect(page.getByText("Review launch checklist")).toBeVisible();
  await expect(page.getByText("3 total")).toBeVisible();
});
