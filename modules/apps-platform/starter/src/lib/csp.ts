import { setNonce } from "get-nonce"

// The page's CSP allows only 'self' plus this per-request nonce for styles (server.mjs). Radix adds a few <style> tags at
// run time (the scroll lock under dialogs, sheets and menus; the Select viewport), and each must carry the nonce or the
// browser blocks it. The server writes the nonce into <meta name="csp-nonce">; under `vite` dev there is none.
const meta = document.querySelector<HTMLMetaElement>('meta[name="csp-nonce"]')?.content ?? ""
export const cspNonce = /^[A-Za-z0-9+/=_-]{16,}$/.test(meta) ? meta : undefined
if (cspNonce) setNonce(cspNonce)
