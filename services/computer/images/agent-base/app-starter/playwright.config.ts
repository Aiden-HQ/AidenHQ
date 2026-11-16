// Browser checks and screenshots: `npm run screens` (Playwright Test). Playwright starts the seeded app itself
// (`npm run preview`: build, then server.mjs with its sample data on port 4173), waits for it, runs e2e/ in four
// projects (1440 and 390 wide, light and dark) and stops it. Screenshots land in .aidenhq/out/ (e2e/screens.spec.ts).
// The browser: AidenHQ's pinned Chrome in its Engineer jobs (AGENT_BROWSER_EXECUTABLE_PATH in agent computers, under
// AIDENHQ_BROWSER_DIR on the host), else Playwright's own (`npx playwright install chromium` once on a laptop).
import { defineConfig } from "@playwright/test"

const PORT = Number(process.env.PREVIEW_PORT || 4173)
const { AGENT_BROWSER_EXECUTABLE_PATH, AIDENHQ_BROWSER_DIR } = process.env
const chrome = AGENT_BROWSER_EXECUTABLE_PATH || (AIDENHQ_BROWSER_DIR && `${AIDENHQ_BROWSER_DIR}/chrome/chrome`)
const desktop = { viewport: { width: 1440, height: 900 } }
const phone = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }

export default defineConfig({
  testDir: "e2e",
  reporter: "line",
  use: { baseURL: `http://127.0.0.1:${PORT}`, launchOptions: chrome ? { executablePath: chrome } : {} },
  projects: [
    { name: "desktop-light", use: { ...desktop, colorScheme: "light" } },
    { name: "desktop-dark", use: { ...desktop, colorScheme: "dark" } },
    { name: "phone-light", use: { ...phone, colorScheme: "light" } },
    { name: "phone-dark", use: { ...phone, colorScheme: "dark" } },
  ],
  webServer: {
    command: "npm run preview",
    url: `http://127.0.0.1:${PORT}/api/health`,
    env: { PORT: String(PORT) },
    reuseExistingServer: false,
    timeout: 120_000,
  },
})
