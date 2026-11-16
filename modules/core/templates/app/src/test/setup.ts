// Runs before every component test file (vite.config.ts `test.setupFiles`): unmount what each test rendered.
import { afterEach } from "vitest"
import { cleanup } from "@testing-library/react"

afterEach(cleanup)
