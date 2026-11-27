// Preloaded before every component test file (bunfig.toml): happy-dom's window and document become globals before any
// component loads (React and Radix read them at import), and each test's render is unmounted afterwards.
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterEach } from "bun:test"

const nodeFetch = globalThis.fetch
GlobalRegistrator.register()
globalThis.fetch = nodeFetch

const { cleanup } = await import("@testing-library/react")
afterEach(cleanup)
