// Component tests stay on the ready setup: Vitest's happy-dom environment and src/test/setup.ts for every test file,
// and the lint rule that steers a test away from hand-building a DOM (the harness that cost a job 20 minutes).
import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("..", import.meta.url))

test("vitest: every component test gets happy-dom and the setup file", async () => {
  const { default: config } = await import("../vite.config.ts")
  assert.equal(config.test.environment, "happy-dom")
  assert.deepEqual(config.test.setupFiles, ["./src/test/setup.ts"])
  assert.ok(existsSync(join(root, "src/test/setup.ts")))
})

test("lint: a test that builds its own DOM or React root fails with the fix", () => {
  const input = 'import { JSDOM } from "jsdom"\nimport { createRoot } from "react-dom/client"\nexport const x = [JSDOM, createRoot]\n'
  const r = spawnSync(join("node_modules/.bin/eslint"), ["--stdin", "--stdin-filename", "src/pages/x.test.tsx"], { cwd: root, input, encoding: "utf8" })
  assert.equal(r.status, 1, r.stderr)
  assert.match(r.stdout, /Render with @testing-library\/react/)
})
