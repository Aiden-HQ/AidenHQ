// The sign-in pages on the my-apps host (docs/design/access.md, App login modes; lean 3g: served by the gate itself, moved
// from the board). They post Better Auth's steps (sign in, the authenticator code, a password from a link) to /.auth/api/*,
// which the gate passes on to the kernel's sign-in listener (127.0.0.1:3129) with its secret. No inline script.
export const HEADERS = {
  "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
};

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** A page; `next` (a same-host path) rides along as a data attribute (no inline script). */
const page = (title: string, form: string, next?: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>${title}</title><link rel="stylesheet" href="/.auth/assets/auth.css"></head><body><main${next ? ` data-next="${esc(next)}"` : ""}><h1>${title}</h1>${form}<p id="msg" role="status"></p></main><script src="/.auth/assets/auth.js"></script></body></html>`;

const FORMS = {
  "/.auth/sign-in": ["Sign in", `<form id="password"><label>Email<input name="email" type="email" autocomplete="username" required></label><label>Password<input name="password" type="password" autocomplete="current-password" required></label><button>Sign in</button></form>`],
  "/.auth/two-factor": ["Enter your code", `<form id="totp"><label>Code from your authenticator app<input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required></label><button>Continue</button></form>`],
  "/.auth/set-password": ["Set your password", `<form id="set"><label>New password (12 characters or more)<input name="password" type="password" autocomplete="new-password" minlength="12" required></label><button>Set password</button></form>`],
} as const;

const CSS = `:root{color-scheme:light dark;--bg:#f6f6f4;--fg:#1b1b1a;--muted:#6b6b66;--card:#fff;--line:#deded8;--accent:#2f5bd3}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--fg:#ecece8;--muted:#9a9a93;--card:#1e1e1c;--line:#33332f;--accent:#7b9cff}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.45 system-ui,-apple-system,sans-serif}
main{max-width:380px;margin:12vh auto;padding:24px 16px}h1{font-size:22px;margin:0 0 16px}
form{display:grid;gap:12px;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px}
label{display:grid;gap:4px;font-size:14px;color:var(--muted)}input{font:inherit;padding:10px;border:1px solid var(--line);border-radius:8px;background:transparent;color:var(--fg)}
button{font:inherit;padding:10px;border:0;border-radius:8px;background:var(--accent);color:#fff;cursor:pointer}#msg{color:var(--muted);min-height:1.5em}`;

const JS = `(() => {
  const main = document.querySelector("main"), next = main.dataset.next || "";
  const msg = (t) => (document.getElementById("msg").textContent = t);
  const call = async (path, body) => {
    const r = await fetch("/.auth/api" + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error((d && (d.message || d.error)) || "failed (" + r.status + ")"), { status: r.status });
    return d;
  };
  const withNext = (path) => path + (next ? "?next=" + encodeURIComponent(next) : "");
  // Signed in: on to next (a path here, e.g. the gate's /.auth/go?…, which hands off to the app), else the apps list.
  const finish = async () => void (location.href = next || "/");
  const pw = document.getElementById("password"), totp = document.getElementById("totp"), set = document.getElementById("set");
  pw && pw.addEventListener("submit", async (e) => {
    e.preventDefault(); msg("");
    try {
      const d = await call("/sign-in/email", { email: pw.email.value, password: pw.password.value });
      if (d.twoFactorRedirect) location.href = withNext("/.auth/two-factor"); else await finish();
    } catch (err) { msg(err.message); }
  });
  totp && totp.addEventListener("submit", async (e) => {
    e.preventDefault(); msg("");
    try { await call("/two-factor/verify-totp", { code: totp.code.value }); await finish(); } catch (err) { msg(err.message); }
  });
  set && set.addEventListener("submit", async (e) => {
    e.preventDefault(); msg("");
    const token = new URLSearchParams(location.search).get("token") || location.hash.slice(1);
    try { await call("/reset-password", { token, newPassword: set.password.value }); location.href = withNext("/.auth/sign-in"); } catch (err) { msg(err.message); }
  });
})();`;

const ASSETS: Record<string, [string, string]> = {
  "/.auth/assets/auth.js": [JS, "text/javascript; charset=utf-8"],
  "/.auth/assets/auth.css": [CSS, "text/css; charset=utf-8"],
};


/** `next` after sign-in: a path on the same host (the gate sends `/.auth/go?…` or `/`), else nothing (no open redirect). */
export function safeNext(next: string | null | undefined): string | undefined {
  // Browsers drop tabs and newlines from URLs ("/\t/evil" is "//evil"): no control characters, and it must stay on this origin.
  if (!next || !next.startsWith("/") || /[\u0000-\u001f\u007f\\]/.test(next)) return undefined;
  try {
    return new URL(next, "https://same.invalid").origin === "https://same.invalid" && !next.startsWith("//") ? next : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A sign-in page or asset the gate serves itself on the my-apps host (GET /.auth/sign-in, /.auth/two-factor,
 * /.auth/set-password, /.auth/assets/*), or undefined. The steps they post go on to the kernel's sign-in listener.
 */
export function signinPage(pathAndQuery: string): { status: number; headers: Record<string, string>; body: string } | undefined {
  const url = new URL(pathAndQuery, "https://same.invalid");
  const form = FORMS[url.pathname as keyof typeof FORMS];
  if (form) return { status: 200, headers: { ...HEADERS, "content-type": "text/html; charset=utf-8" }, body: page(form[0], form[1], safeNext(url.searchParams.get("next"))) };
  const asset = ASSETS[url.pathname];
  return asset ? { status: 200, headers: { ...HEADERS, "content-type": asset[1] }, body: asset[0] } : undefined;
}
