

import { describe, expect, it } from "vitest";
import type { Resolve } from "../src/api.js";
import type { Scope, Sign } from "../src/identity.js";
import { parseApp } from "../src/registry.js";
import { graderView, isPublicIp, renderArgs, viewApp, viewContent, BROWSER_IMAGE, GRADER_SNAPSHOT_CAP, SNAPSHOT_CAP, SNAPSHOT_MAX, VIEW_SCRIPT, webView, WEB_NETWORK, type Render, type ViewResult } from "../src/view.js";

const app = (o: object = {}) => parseApp({ name: "roadmap-keeper", repo: "example-org/roadmap-keeper", owner: "app-maintainer", description: "d", health: { url: "http://app:8080/api/health" }, ...o });
const ID = "c".padEnd(64, "0");
const resolve: Resolve = async () => ({ ids: "cccc", inspect: async () => JSON.stringify([{ Id: ID, Config: { Labels: { "com.docker.compose.project": "app-roadmap-keeper", "com.docker.compose.service": "app" } } }]) });
const PAGE: ViewResult = { status: 200, url: "http://127.0.0.1:8080/", title: "Roadmap", timed_out: false, snapshot: '- heading "Roadmap" [level=1]', truncated: false, png: "iVBORw0KGgo=" };
const fake = () => {
  const calls: { network: string; req: object }[] = [];
  const render: Render = async (network, req) => (calls.push({ network, req }), PAGE);
  return { calls, render };
};
const agent = (key: string, roles: string[] = []) => ({ key, roles });
const TOKEN = "t".repeat(80);
const signed: { app: string; agent: string; scope: Scope }[] = [];
const sign: Sign = (app, agent, scope) => (signed.push({ app, agent, scope }), TOKEN);

describe("app_view", () => {
  it("renders an open app inside its verified container's namespace at 127.0.0.1; role-gated apps need the role", async () => {
    const { calls, render } = fake();
    const audit: object[] = [];
    await viewApp(app(), agent("roadmap-keeper"), { path: "/roadmap?tab=q1", screenshot: true }, { resolve, render, sign, audit: (o) => audit.push(o) });
    await viewApp(app({ access: { roles: ["finance"] } }), agent("cfo-agent", ["finance"]), { width: 390 }, { resolve, render, sign });
    expect(calls).toEqual([
      { network: `container:${ID}`, req: { url: "http://127.0.0.1:8080/roadmap?tab=q1", width: 1280, screenshot: true, web: false, headers: { "x-aidenhq-identity": TOKEN } } },
      { network: `container:${ID}`, req: { url: "http://127.0.0.1:8080/", width: 390, screenshot: false, web: false, headers: { "x-aidenhq-identity": TOKEN } } },
    ]);
    expect(audit).toEqual([{ caller: "roadmap-keeper", app: "roadmap-keeper", path: "/roadmap?tab=q1", status: 200 }]);
  });
  it("refuses before rendering: no role, traversal, no health.url, a remote host, a bad width", async () => {
    const { calls, render } = fake();
    const d = { resolve, render, sign };
    await expect(viewApp(app({ access: { roles: ["finance"] } }), agent("intruder"), {}, d)).rejects.toThrow(/no access/);
    for (const p of ["/a/../admin", "//evil.example/", "http://evil/", "/a#x", "/%2e%2e/x", "a"]) await expect(viewApp(app(), agent("x"), { path: p }, d), p).rejects.toThrow(/bad/);
    await expect(viewApp(app({ health: {} }), agent("x"), {}, d)).rejects.toThrow(/health.url/);
    await expect(viewApp(app({ host: "vps" }), agent("x"), {}, d)).rejects.toThrow(/docker context/);
    await expect(viewApp(app(), agent("x"), { width: 100 }, d)).rejects.toThrow(/width/);
    expect(calls).toEqual([]);
  });
});

describe("app_view identity", () => {
  it("signs a read-only member token for the agent, scoped by the renderer to the app's origin, and never shows it", async () => {
    signed.length = 0;
    const { render } = fake();
    await viewApp(app({ port: 8080, share: { host: "r.example.com", aud: "aud-12345678" } }), agent("scout"), {}, { resolve, render, sign });
    expect(signed).toEqual([{ app: "roadmap-keeper", agent: "scout", scope: { role: "member", methods: ["GET", "HEAD"] } }]);
    expect(VIEW_SCRIPT).toContain("ok = new URL(q.url).origin === own"); // per-request origin check
    expect(VIEW_SCRIPT).toMatch(/q\.method !== "GET" && q\.method !== "HEAD"\) return dt\.send\("Fetch\.failRequest"/); // a POST from the page is failed
    expect(VIEW_SCRIPT.indexOf("await guard(")).toBeLessThan(VIEW_SCRIPT.indexOf("await ab(\"open\", r.url)")); // before the first navigation
    const echo: Render = async () => ({ ...PAGE, url: `http://127.0.0.1:8080/?k=${TOKEN}`, title: TOKEN, snapshot: `- text "${TOKEN}"` });
    const r = await viewApp(app(), agent("scout"), {}, { resolve, render: echo, sign });
    expect(JSON.stringify(r)).not.toContain(TOKEN);
    const boom: Render = async () => { throw new Error(`failed at ${TOKEN}`); };
    await expect(viewApp(app(), agent("scout"), {}, { resolve, render: boom, sign })).rejects.not.toThrow(TOKEN);
  });
});

describe("web_view", () => {
  const dns = async (h: string) => (({ "example.com": ["93.184.215.14"], "v6.example": ["2606:4700::1111"], "rebind.example": ["93.184.215.14", "192.168.20.5"], "paperclip": ["172.18.0.4"] }) as Record<string, string[]>)[h]?.map((address) => ({ address })) ?? [];
  it("renders public pages on the computers network; refuses private addresses and non-http(s) URLs before rendering", async () => {
    const { calls, render } = fake();
    const d = { lookup: dns, render };
    await webView("https://example.com/a?b=1", agent("x"), {}, d);
    await webView("http://v6.example/", agent("x"), { screenshot: true }, d);
    expect(calls.map((c) => c.network)).toEqual([WEB_NETWORK, WEB_NETWORK]);
    expect(calls[0]!.req).toEqual({ url: "https://example.com/a?b=1", width: 1280, screenshot: false, web: true });
    for (const u of ["http://127.0.0.1/", "http://10.231.2.1:8200/", "http://172.20.0.2:8080/", "https://192.168.20.5:8443/", "http://100.100.1.2/", "http://169.254.169.254/latest/meta-data", "http://[::1]/", "http://[fd00::1]/", "http://[::ffff:127.0.0.1]/", "http://0.0.0.0/", "http://2130706433/", "http://rebind.example/", "http://paperclip:3100/", "http://nowhere.example/"])
      await expect(webView(u, agent("x"), {}, d), u).rejects.toThrow(/not a public address|doesn't resolve/);
    for (const u of ["file:///etc/passwd", "ftp://example.com/", "javascript:alert(1)", "https://user:pw@example.com/", "not a url", `https://example.com/${"a".repeat(2000)}`]) await expect(webView(u, agent("x"), {}, d), u).rejects.toThrow(/http|too long/);
    expect(calls).toHaveLength(2);
  });
  it("classifies addresses", () => {
    for (const ip of ["8.8.8.8", "93.184.215.14", "2606:4700::1111"]) expect(isPublicIp(ip), ip).toBe(true);
    for (const ip of ["10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.0.1", "100.64.0.1", "100.127.255.255", "127.0.0.1", "169.254.169.254", "0.0.0.0", "224.0.0.1", "255.255.255.255", "198.18.0.1", "::", "::1", "fe80::1", "fc00::1", "ff02::1", "::ffff:8.8.8.8", "64:ff9b::808:808", "2001:db8::1", "2002:a00:1::1", "nonsense"]) expect(isPublicIp(ip), ip).toBe(false);
  });
});

describe("renderer", () => {
  it("runs the host's browser image, non-root, without capabilities, read-only and limited, with no mounts, secrets or token", () => {
    const a = renderArgs(`container:${ID}`, BROWSER_IMAGE);
    const after = (f: string) => a[a.indexOf(f) + 1];
    expect([after("--network"), after("--pull"), after("--cap-drop"), after("--security-opt"), after("--user")]).toEqual([`container:${ID}`, "never", "ALL", "no-new-privileges", "65534:65534"]);
    for (const f of ["--rm", "-i", "--init", "--read-only", "--memory", "--cpus", "--pids-limit"]) expect(a).toContain(f);
    expect(a.slice(-4)).toEqual([BROWSER_IMAGE, "node", "-e", VIEW_SCRIPT]);
    expect(BROWSER_IMAGE).toBe("aidenhq/computer-browser:current"); // the host's own build (ops/computer-images.sh), never pulled
    expect(a.slice(0, -1).join(" ")).not.toMatch(/token|secret|authorization|bearer|-v |--volume|--mount|--privileged|--cap-add/i);
    expect(renderArgs(WEB_NETWORK, BROWSER_IMAGE)).toContain(WEB_NETWORK);
    for (const n of ["host", "bridge", "container:abc", "app-roadmap-keeper"]) expect(() => renderArgs(n, BROWSER_IMAGE), n).toThrow(/network/);
  });
  it("answers with the fenced snapshot, and the screenshot only when taken", () => {
    const c = viewContent(PAGE);
    expect(c.content[0]!.type).toBe("text");
    const text = (c.content[0] as { text: string }).text;
    expect(text).toContain(`<untrusted_page_accessibility_snapshot>\n${PAGE.snapshot}\n</untrusted_page_accessibility_snapshot>`);
    expect(JSON.parse(text.split("\n")[0]!)).toEqual({ status: 200, url: PAGE.url, title: "Roadmap", timed_out: false, truncated: false });
    expect(c.content[1]).toEqual({ type: "image", data: PAGE.png, mimeType: "image/png" });
    expect(viewContent({ ...PAGE, png: undefined }).content).toHaveLength(1);
  });
});

describe("the grader's live view", () => {
  it("reads the running commit before and after the render; restricted or unreachable apps are unavailable, not errors", async () => {
    const { calls, render } = fake();
    let sha = "a".repeat(40);
    const d = { resolve, render, sign, running: () => sha };
    expect(await graderView(app(), { path: "/roadmap" }, d)).toMatchObject({ status: 200, sha_before: sha, sha_after: sha });
    const redeploy: Render = async (n, r) => ((sha = "b".repeat(40)), render(n, r));
    expect(await graderView(app(), {}, { ...d, render: redeploy })).toMatchObject({ sha_before: "a".repeat(40), sha_after: "b".repeat(40) });
    // A restricted app has pages, just not ones the grader may look at: unavailable, and never flagged as having no page.
    expect(await graderView(app({ access: { roles: ["finance"] } }), {}, d)).toEqual({ unavailable: expect.stringMatching(/restricted/) });
    expect(await graderView(app({ health: {} }), {}, d)).toEqual({ unavailable: expect.stringMatching(/health.url/) });
    expect(calls.length).toBe(2);
  });
  it("flags noHttp only from the deploy's own proven verdict, never from the registry's shape", async () => {
    const { calls, render } = fake();
    const bare = { unavailable: expect.stringMatching(/health\.url/) };
    // warehouse-shaped: stateful, expose: false, a port, no health.url, no api, not shared (parseApp defaults expose: true).
    const warehouse = { name: "warehouse", repo: "example-org/example", owner: "app-maintainer", description: "d", stateful: true, expose: false, port: 5433, health: {} };
    const proven = { resolve, render, sign, running: () => "a".repeat(40), noHttpProven: (n: string) => n === "warehouse" };
    const unproven = { resolve, render, sign, running: () => "a".repeat(40) };
    expect(await graderView(app(warehouse), {}, proven)).toEqual({ ...bare, noHttp: true });
    // The same shape without a probe that proved it is a page not captured, never a page that doesn't exist.
    expect(await graderView(app(warehouse), {}, unproven)).toEqual(bare);
    expect(await graderView(app({ ...warehouse, name: "other" }), {}, proven)).toEqual(bare);
    // A restricted app is a page the grader may not look at, never a page that doesn't exist, even when its shape matches.
    expect(await graderView(app({ access: { roles: ["finance"] }, health: {} }), {}, proven)).toEqual({ unavailable: expect.stringMatching(/restricted/) });
    // A remote app is out of the renderer's reach, whatever a probe of some other context could say.
    expect(await graderView(app({ ...warehouse, host: "vps" }), {}, proven)).toEqual({ unavailable: expect.stringMatching(/docker context vps/) });
    // An exposed app with no health.url is a page this registry knows no address for: not captured, not not-applicable.
    expect(await graderView(app({ health: {}, expose: true, port: 8080 }), {}, proven)).toEqual(bare);
    expect(calls).toEqual([]);
  });
  it("keeps an agent's view at SNAPSHOT_CAP; the grader's view takes the cap its verified caller was given", async () => {
    const { calls, render } = fake();
    const d = { resolve, render, sign, running: () => "a".repeat(40) };
    await graderView(app(), { path: "/changes", cap: GRADER_SNAPSHOT_CAP }, d);
    expect((calls[0]!.req as { snapshotCap?: number }).snapshotCap).toBe(GRADER_SNAPSHOT_CAP);
    // Any other apps.read caller's view keeps the ordinary cap.
    await graderView(app(), { path: "/changes", cap: SNAPSHOT_CAP }, d);
    expect((calls[1]!.req as { snapshotCap?: number }).snapshotCap).toBe(SNAPSHOT_CAP);
    await viewApp(app(), agent("scout"), {}, d);
    expect(calls[2]!.req).not.toHaveProperty("snapshotCap"); // an agent's view keeps the renderer's own SNAPSHOT_CAP
    // The renderer honours the request, bounded by SNAPSHOT_MAX, and reports the cut it made.
    expect(VIEW_SCRIPT).toContain("Math.min(Number(r.snapshotCap) || " + SNAPSHOT_CAP + ", " + SNAPSHOT_MAX + ")");
  });
});
