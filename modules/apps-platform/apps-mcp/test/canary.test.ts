// app_page_canary (canary.ts): mint → one-shot browser on the canary network → the page's own POST /.aidenhq/notify → revoke.
// The browser and kernel are fakes here, so the whole contract runs in CI; the real Chrome, the real test listener and a real
// page run in render.e2e.test.ts (AIDENHQ_BROWSER_E2E=1).
import { describe, expect, it } from "vitest";
import { CANARY_NETWORK, renderArgs } from "../src/view.js";
import { CANARY_BASE, CANARY_LISTENER_ADDRESS, CANARY_PORT, CANARY_SCRIPT, canaryContent, canaryOrigin, pageCanary, type CanaryDeps } from "../src/canary.js";
import { parseApp } from "../src/registry.js";

const app = parseApp({ name: "roadmap-keeper", repo: "example-org/roadmap-keeper", owner: "app-maintainer", description: "d", port: 4100, share: { host: "roadmap.example.com", aud: "aud-roadmap-0001" } });

/** A kernel that mints one session and records every call; `run` is the browser's answer. */
function deps(o: { mintStatus?: number; run?: object | (() => Promise<string>); onRun?: (input: any) => void; revokeStatus?: number } = {}) {
  const calls: { path: string; body: any }[] = [];
  const runs: { network: string; script: string; input: any; timeout: number }[] = [];
  const d: CanaryDeps = {
    kernel: async (path, body) => {
      calls.push({ path, body });
      if (path === "/v1/test-session") return o.mintStatus && o.mintStatus !== 200 ? { status: o.mintStatus, json: { error: { message: "refused" } } } : { status: 200, json: { id: "sess-1", app: "roadmap-keeper", host: "roadmap.example.com", expires: new Date(Date.now() + 900_000).toISOString(), code: "c".repeat(43), state: "0".repeat(32) } };
      if (path === "/v1/test-session/revoke") return { status: o.revokeStatus ?? 200, json: { revoked: 1 } };
      return { status: 404, json: {} };
    },
    run: async (network, script, input, timeout) => {
      runs.push({ network, script, input, timeout });
      o.onRun?.(input);
      const r = typeof o.run === "function" ? await o.run() : o.run ?? {};
      return JSON.stringify(r);
    },
  };
  return { d, calls, runs };
}

describe("app_page_canary", () => {
  it("mints for the app, runs the page on the canary network, and returns notify: fired with the reference and screenshot", async () => {
    const { d, calls, runs } = deps({ run: { status: 200, finalUrl: `${canaryOrigin("roadmap-keeper")}/intake`, pageTitle: "Roadmap Keeper", notify: "fired", notifyStatus: 204, reference: "TEST-RT-2026-11-24-1", submittedAt: "2026-11-24T09:00:00.000Z", png: "iVBORw0KGgo=" } });
    const r = await pageCanary(app, { app: "roadmap-keeper", text: "TEST-RT-2026-11-24-1 canary", path: "/intake" }, d);
    expect(r).toMatchObject({ ok: true, status: 200, notify: "fired", notifyStatus: 204, reference: "TEST-RT-2026-11-24-1", screenshot: "iVBORw0KGgo=", session: { id: "sess-1", revoked: true } });
    // The session was minted for this app only, and revoked by id after the run.
    expect(calls.map((c) => [c.path, c.body])).toEqual([["/v1/test-session", { app: "roadmap-keeper" }], ["/v1/test-session/revoke", { sessionId: "sess-1" }]]);
    // The browser ran on the canary network, at the listener's host for this app, with the handoff's code and the text.
    expect(runs).toHaveLength(1);
    expect(runs[0]!.network).toBe(CANARY_NETWORK);
    expect(runs[0]!.input).toMatchObject({ listener: `http://roadmap-keeper.${CANARY_BASE}:${CANARY_PORT}`, listenerAddress: CANARY_LISTENER_ADDRESS, code: "c".repeat(43), state: "0".repeat(32), path: "/intake", text: "TEST-RT-2026-11-24-1 canary" });
    // The tool's answer carries the screenshot as its own content part.
    const content = canaryContent(r);
    expect(content.content).toHaveLength(2);
    expect(content.content[1]).toEqual({ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" });
  });

  it("a page that never posts notify is not-fired, and the session is still revoked", async () => {
    const { d, calls } = deps({ run: { status: 200, finalUrl: `${canaryOrigin("roadmap-keeper")}/intake`, pageTitle: "Roadmap", notify: "not-fired", notifyStatus: null, reference: null } });
    const r = await pageCanary(app, { app: "roadmap-keeper", text: "x" }, d);
    expect(r).toMatchObject({ ok: false, notify: "not-fired", notifyStatus: null, session: { revoked: true } });
    expect(calls.at(-1)).toEqual({ path: "/v1/test-session/revoke", body: { sessionId: "sess-1" } });
  });

  it("a refused mint never starts a browser; a failed browser run still revokes and reports why", async () => {
    const refused = deps({ mintStatus: 403 });
    await expect(pageCanary(app, { app: "roadmap-keeper", text: "x" }, refused.d)).rejects.toThrow(/refused \(403\)/);
    expect(refused.runs).toEqual([]);
    expect(refused.calls.map((c) => c.path)).toEqual(["/v1/test-session"]); // nothing to revoke
    const failed = deps({ run: { error: "no feedback field on the page", finalUrl: `${canaryOrigin("roadmap-keeper")}/` } });
    const r = await pageCanary(app, { app: "roadmap-keeper", text: "x" }, failed.d);
    expect(r).toMatchObject({ ok: false, error: "no feedback field on the page", session: { revoked: true } });
    expect(failed.calls.at(-1)).toEqual({ path: "/v1/test-session/revoke", body: { sessionId: "sess-1" } });
  });

  it("an app that isn't shared has no test listener: refused before any session", async () => {
    const { d, calls } = deps();
    await expect(pageCanary(parseApp({ name: "notes", repo: "example-org/notes", owner: "a", description: "d" }), { app: "notes", text: "x" }, d)).rejects.toThrow(/isn't a shared app/);
    expect(calls).toEqual([]);
  });

  it("the renderer maps every *.canary.localhost name to the listener, follows the handoff, and reads the page's own notify", () => {
    const script = CANARY_SCRIPT;
    expect(script).toContain('"/.auth/handoff?"');
    expect(script).toContain("--host-resolver-rules=MAP *.canary.localhost");
    expect(script).toContain('new URL(n.url).pathname === "/.aidenhq/notify"');
    expect(script).toContain("document.body.innerText");
    // The image's launch maps the canary names to the listener's address, and the network is the one renderArgs allows.
    expect(renderArgs(CANARY_NETWORK, "img")).toContain(CANARY_NETWORK);
    expect(renderArgs(CANARY_NETWORK, "img").slice(0, -1).join(" ")).not.toMatch(/--cap-add|--privileged|-v |--volume|--mount/);
  });
});
