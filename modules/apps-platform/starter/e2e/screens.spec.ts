// A screenshot of every page in feature-map.json, per project (width and colour scheme), and the checks a person would
// notice at a glance: no page errors, no console errors (a CSP violation is one) and nothing wider than the screen.
// SCREENS=/,/teams limits it to those paths (the pages a change touches). The pictures go to the task folder's
// .aidenhq/out/ in an AidenHQ job (attached to the task after the run, at most 20), else this folder's.
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "@playwright/test"

const only = process.env.SCREENS?.split(",")
const pages: { path: string; shows: string }[] = JSON.parse(readFileSync("feature-map.json", "utf8")).pages.filter((p: { path: string }) => !only || only.includes(p.path))
const out = join(process.env.AIDENHQ_TASK_WORKTREE ?? ".", ".aidenhq/out")
const slug = (path: string) => path.replace(/[^\w.]+/g, "-").replace(/^-+|-+$/g, "") || "home"

for (const { path, shows } of pages) {
  test(`${path}: ${shows}`, async ({ page }, info) => {
    const errors: string[] = []
    page.on("pageerror", (e) => errors.push(`page error: ${e.message}`))
    page.on("console", (m) => { if (m.type() === "error") errors.push(`console: ${m.text()}`) })
    await page.goto(path)
    await page.waitForLoadState("networkidle")
    await page.screenshot({ path: join(out, `${slug(path)}-${info.project.name}.png`) })
    expect(errors).toEqual([])
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
    expect(overflow, "the page is no wider than the screen").toBeLessThanOrEqual(0)
  })
}
