// Preload for test/web (see the test script): registers happy-dom's window globals (document, HTMLElement, ...) before any
// test module loads, because React reads `document` once at import. Server tests run without it, on Node's own globals.
import { GlobalRegistrator } from "@happy-dom/global-registrator";

const nodeFetch = globalThis.fetch;
GlobalRegistrator.register();
globalThis.fetch = nodeFetch;
