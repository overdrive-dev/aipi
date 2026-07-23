import { expect, test } from "@playwright/test";

test("filters tasks and restores the selected priority from the URL", async ({ page }) => {
  await page.goto("/");
  const filter = page.getByLabel("Priority");
  await expect(filter).toHaveValue("all");

  await filter.selectOption("high");
  await expect(page).toHaveURL(/\?priority=high$/);
  await expect(page.getByText("Review launch checklist")).toBeVisible();
  await expect(page.getByText("Polish empty state")).toHaveCount(0);
  await expect(page.getByText("1 total")).toBeVisible();

  await page.reload();
  await expect(filter).toHaveValue("high");
  await expect(page.getByText("Review launch checklist")).toBeVisible();

  await filter.selectOption("all");
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByText("3 total")).toBeVisible();
});
