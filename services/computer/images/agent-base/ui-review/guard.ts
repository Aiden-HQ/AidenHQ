// The live-app guard: what a run may do to the app it looks at, enforced on every request the run's Chrome makes. It is installed
// on the browser, not on one context: its own CDP connection auto-attaches to every target of that Chrome (the engine's contexts,
// a tab an agent opens over CDP in any context, iframes and workers), and each target is held at its start until the guard's
// rules are on it. Modes (each app's `live_mode` is the most a pass may do):
//   read        GET and HEAD only, whatever the origin; no WebSocket, WebTransport or peer connection.
//   test-write  the test account may change its own data: everything but DELETE and a path named like a destructive action
//               (DESTRUCTIVE; a best-effort extra: the guarantee is the owner's choice of test-write for a test account).
//   any         everything (a local throwaway build).
// A refused request fails with BlockedByClient and is recorded as { method, origin, path, page }; a socket as method "WS".
// The guard also seeds every new browser context with a session's cookies and local storage (Playwright storage state) before
// its first request, so a tab an agent opens is signed in as the engine's own pages are.
import { appendFileSync } from "node:fs";
import type { Blocked } from "./types.ts";

export type { Blocked };

export type Mode = "read" | "test-write" | "any";
export const MODES: Mode[] = ["read", "test-write", "any"];
/** Playwright's storage state (state.json): cookies and each origin's local storage. */
export type StorageState = {
  cookies: { name: string; value: string; domain: string; path: string; expires: number; httpOnly: boolean; secure: boolean; sameSite: "Strict" | "Lax" | "None" }[];
  origins: { origin: string; localStorage: { name: string; value: string }[] }[];
};

export const DESTRUCTIVE = /(delete|destroy|remove|purge|archive|cancel|refund|pay|checkout|billing|invite|send|transfer|publish|deploy)/i;

/** Whether `mode` refuses a request: read allows GET and HEAD only; test-write refuses DELETE and destructive paths. */
export function refuses(mode: Mode, method: string, url: string): boolean {
  if (mode === "any") return false;
  const m = method.toUpperCase();
  if (mode === "read") return m !== "GET" && m !== "HEAD";
  let path = url;
  try { path = new URL(url).pathname; } catch { /* not a URL: the whole string */ }
  return m === "DELETE" || (!["GET", "HEAD", "OPTIONS"].includes(m) && DESTRUCTIVE.test(path));
}

const where = (url: string) => { try { const u = new URL(url); return { origin: u.origin, path: u.pathname }; } catch { return { origin: "", path: url.slice(0, 200) }; } };
/** A page's label: its path and hash route, never a query or fragment (an auth callback's code stays out of every record). */
export const pageOf = (url: string) => { try { const u = new URL(url); return u.pathname + (u.hash.startsWith("#/") ? u.hash.replace(/[?&].*$/, "") : ""); } catch { return ""; } };

const WS_BINDING = "__uiReviewSocket";
/** Read mode's stand-ins: a WebSocket that reports itself to the guard and closes unopened; no WebTransport or peer connection. */
const NO_CHANNELS = `(() => {
  const report = globalThis.${WS_BINDING};
  class WebSocket extends EventTarget {
    constructor(url) {
      super(); this.url = String(url); this.readyState = 3; this.protocol = ""; this.extensions = ""; this.bufferedAmount = 0; this.binaryType = "blob";
      try { report?.(new URL(this.url, location.href).href); } catch {}
      setTimeout(() => { const e = new Event("error"); this.onerror?.(e); this.dispatchEvent(e); const c = new CloseEvent("close", { code: 1006 }); this.onclose?.(c); this.dispatchEvent(c); }, 0);
    }
    send() {} close() {}
  }
  Object.assign(WebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
  globalThis.WebSocket = WebSocket;
  for (const k of ["WebTransport", "RTCPeerConnection", "webkitRTCPeerConnection"]) try { delete globalThis[k]; } catch {}
})();`;

type Msg = { id?: number; method?: string; params?: Record<string, unknown>; sessionId?: string; result?: unknown; error?: { message: string } };
export type Guard = { mode: Mode; blocked(): Blocked[]; seed(state: StorageState | null): void; close(): void };

/**
 * Installs the guard on the Chrome at `cdp` (its browser WebSocket URL). `log`: a file each blocked request is appended to (one JSON
 * line), so a browser that outlives its command (the clicking pass) still reports them. With mode `any` and no session the guard
 * still attaches (it seeds sessions), but refuses nothing.
 */
export async function installGuard(cdp: string, mode: Mode, o: { log?: string; state?: StorageState | null; lost?: () => void } = {}): Promise<Guard> {
  const ws = new WebSocket(cdp);
  await new Promise<void>((ok, no) => { ws.onopen = () => ok(); ws.onerror = () => no(new Error("the guard could not reach Chrome's CDP")); });
  let next = 0;
  const waiting = new Map<number, (m: Msg) => void>();
  const send = (method: string, params: object = {}, sessionId?: string) => new Promise<Msg>((ok) => {
    const id = ++next;
    waiting.set(id, ok);
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  const blocked: Blocked[] = [];
  const urls = new Map<string, string>(); // sessionId -> its target's URL
  const targetOf = new Map<string, string>(); // targetId -> sessionId
  const seeded = new Set<string>(); // browser contexts given the session
  let state = o.state ?? null;
  const block = (b: Blocked) => { blocked.push(b); if (o.log) try { appendFileSync(o.log, JSON.stringify(b) + "\n"); } catch { /* the list still has it */ } };
  const seedScript = (s: StorageState) => `(() => { try {
    const all = ${JSON.stringify(Object.fromEntries(s.origins.map((x) => [x.origin, x.localStorage])))}, items = all[location.origin];
    if (items && !localStorage.getItem("__uiReviewSeeded")) { for (const i of items) localStorage.setItem(i.name, i.value); localStorage.setItem("__uiReviewSeeded", "1"); }
  } catch {} })();`;

  const attached = async (sessionId: string, info: { targetId: string; type: string; url: string; browserContextId?: string }) => {
    urls.set(sessionId, info.url); targetOf.set(info.targetId, sessionId);
    const page = info.type === "page" || info.type === "iframe";
    // A document's scripts take only with the Page domain on.
    const pageOn = page ? send("Page.enable", {}, sessionId) : Promise.resolve();
    const steps: Promise<unknown>[] = [send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sessionId)];
    if (mode !== "any") steps.push(send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] }, sessionId));
    if (mode === "read") {
      // The channels request interception doesn't see (WebSocket, WebTransport, peer connections) are replaced before the app's own
      // code runs, in every document and worker: a socket never connects (it reports the refusal and closes, as a refused upgrade).
      // (Runtime events: a binding call is reported only with the domain on.)
      steps.push(send("Runtime.enable", {}, sessionId).then(() => send("Runtime.addBinding", { name: WS_BINDING }, sessionId)).then(() => page
        ? pageOn.then(() => send("Page.addScriptToEvaluateOnNewDocument", { source: NO_CHANNELS }, sessionId))
        : send("Runtime.evaluate", { expression: NO_CHANNELS }, sessionId)));
    }
    if (state && info.browserContextId && !seeded.has(info.browserContextId)) {
      seeded.add(info.browserContextId);
      steps.push(send("Storage.setCookies", { browserContextId: info.browserContextId, cookies: state.cookies.map((c) => ({ ...c, ...(c.expires > 0 ? {} : { expires: undefined }) })) }));
    }
    if (state && page && state.origins.length) steps.push(pageOn.then(() => send("Page.addScriptToEvaluateOnNewDocument", { source: seedScript(state!) }, sessionId)));
    // Fail closed: a target whose rules didn't all take is closed, never resumed.
    if ((await Promise.all(steps)).some((m) => (m as Msg | undefined)?.error)) { await send("Target.closeTarget", { targetId: info.targetId }); return; }
    await send("Runtime.runIfWaitingForDebugger", {}, sessionId);
  };

  ws.onmessage = (ev) => {
    const m = JSON.parse(String(ev.data)) as Msg;
    if (m.id !== undefined) { waiting.get(m.id)?.(m); waiting.delete(m.id); return; }
    const p = m.params ?? {};
    if (m.method === "Target.attachedToTarget") void attached(p.sessionId as string, p.targetInfo as never).catch(() => {});
    else if (m.method === "Target.detachedFromTarget") urls.delete(p.sessionId as string);
    else if (m.method === "Target.targetInfoChanged") { const t = p.targetInfo as { targetId: string; url: string }, s = targetOf.get(t.targetId); if (s) urls.set(s, t.url); }
    else if (m.method === "Fetch.requestPaused") {
      const r = p.request as { url: string; method: string };
      if (refuses(mode, r.method, r.url)) {
        block({ method: r.method, ...where(r.url), page: pageOf(urls.get(m.sessionId!) ?? "") });
        void send("Fetch.failRequest", { requestId: p.requestId, errorReason: "BlockedByClient" }, m.sessionId);
      } else void send("Fetch.continueRequest", { requestId: p.requestId }, m.sessionId);
    } else if (m.method === "Runtime.bindingCalled" && p.name === WS_BINDING) {
      block({ method: "WS", ...where(String(p.payload)), page: pageOf(urls.get(m.sessionId!) ?? "") });
    }
  };
  // A lost guard connection leaves nothing guarded: the caller stops the browser.
  let closing = false;
  ws.onclose = () => { if (!closing) o.lost?.(); };
  await send("Target.setDiscoverTargets", { discover: true });
  await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  return {
    mode,
    blocked: () => [...blocked],
    // A new session (a re-login): contexts made from now on get it; the caller makes fresh contexts.
    seed: (s) => { state = s; seeded.clear(); },
    close: () => { closing = true; try { ws.close(); } catch { /* gone */ } },
  };
}

/** A command's --mode: the one given (undefined when it isn't a mode), else `any` for a local build (127.0.0.1, localhost), `read` for everything else. */
export function modeOf(given: string | undefined, target: string): Mode | undefined {
  if (given !== undefined) return (MODES as string[]).includes(given) ? (given as Mode) : undefined;
  return ["127.0.0.1", "localhost", "[::1]"].includes(new URL(target).hostname) ? "any" : "read";
}
