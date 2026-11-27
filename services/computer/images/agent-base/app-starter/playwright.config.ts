// Browser checks and screenshots: `bun run screens` (Playwright Test). Playwright starts the seeded app itself
// (`bun run preview`: build, then server.mjs with its sample data on port 4173), waits for it, runs e2e/ in ten
// projects (1440, 1920 and 2560 desktop, 768 tablet, 390 phone; light and dark) and stops it. Screenshots land in
// .aidenhq/out/ (e2e/screens.spec.ts).
// The browser: AidenHQ's pinned Chrome in its Engineer jobs (AGENT_BROWSER_EXECUTABLE_PATH in agent computers, under
// AIDENHQ_BROWSER_DIR on the host), else Playwright's own (`bunx playwright install chromium` once on a laptop).
import { defineConfig } from "@playwright/test"

const PORT = Number(process.env.PREVIEW_PORT || 4173)
const { AGENT_BROWSER_EXECUTABLE_PATH, AIDENHQ_BROWSER_DIR } = process.env
const chrome = AGENT_BROWSER_EXECUTABLE_PATH || (AIDENHQ_BROWSER_DIR && `${AIDENHQ_BROWSER_DIR}/chrome/chrome`)
// Real sizes: a laptop, a desktop monitor, a large monitor, a tablet and a phone. The 1440 desktop keeps the plain
// "desktop-*" names (flows.spec.ts runs once, on desktop-light).
const sizes = {
  desktop: { viewport: { width: 1440, height: 900 } },
  "desktop-1920": { viewport: { width: 1920, height: 1080 } },
  "desktop-2560": { viewport: { width: 2560, height: 1440 } },
  tablet: { viewport: { width: 768, height: 1024 }, isMobile: true, hasTouch: true },
  phone: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
}

export default defineConfig({
  testDir: "e2e",
  reporter: "line",
  use: { baseURL: `http://127.0.0.1:${PORT}`, launchOptions: chrome ? { executablePath: chrome } : {} },
  projects: Object.entries(sizes).flatMap(([size, use]) =>
    (["light", "dark"] as const).map((colorScheme) => ({ name: `${size}-${colorScheme}`, use: { ...use, colorScheme } })),
  ),
  webServer: {
    command: "bun run preview",
    url: `http://127.0.0.1:${PORT}/api/health`,
    env: { PORT: String(PORT) },
    reuseExistingServer: false,
    timeout: 120_000,
  },
})
