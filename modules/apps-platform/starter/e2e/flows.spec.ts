// A click-through to copy: what a person does, checked in a real browser. One project is enough for a flow; the
// screenshots in screens.spec.ts cover the widths and themes.
import { expect, test } from "@playwright/test"

test("a project opens in its sheet at a URL, and Back closes it", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop-light", "flows run once")
  await page.goto("/")
  await page.getByRole("link", { name: "Search v2" }).click()
  await expect(page).toHaveURL(/item=search-v2/)
  await expect(page.getByRole("dialog")).toContainText("Search v2")
  await page.goBack()
  await expect(page.getByRole("dialog")).toHaveCount(0)
})
