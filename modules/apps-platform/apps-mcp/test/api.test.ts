import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { authorize, callApi, type ApiRequest, type ResponseHeaders, type Resolve } from "../src/api.js";
import { agentSigner } from "../src/identity.js";
import { feedbackOnly } from "../src/mcp.js";
import { isSensitive, parseApp } from "../src/registry.js";

const api = { callers: ["roadmap-keeper"], paths: ["/api/agent/roadmap"] };
const app = (o: object = {}) => parseApp({ name: "roadmap-keeper", repo: "example-org/roadmap-keeper", owner: "app-maintainer", description: "d", health: { url: "http://app:8080/api/health" }, api, ...o });

/** apps-mcp's key and the public keys.json an app mounts (as scripts/identity.ts writes them), plus the app's middleware. */
export async function identityFixture() {
  const dir = mkdtempSync(`${tmpdir()}/identity-`);
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  writeFileSync(`${dir}/apps.pem`, privateKey.export({ format: "pem", type: "pkcs8" }));
  const sign = agentSigner(`${dir}/apps.pem`);
  const kid = JSON.parse(Buffer.from(sign("x", "y", { role: "member", methods: ["GET"] }).split(".")[0]!, "base64url").toString()).kid;
  writeFileSync(`${dir}/keys.json`, JSON.stringify({ keys: [{ ...publicKey.export({ format: "jwk" }), kid, iss: "aidenhq-apps" }] }));
  const middleware = new URL("../../starter/aidenhq-identity.mjs", import.meta.url).href; // the file every app copies
  const { createIdentity } = await import(middleware);
  const identity = createIdentity({ app: "roadmap-keeper", keysFile: `${dir}/keys.json` });
  const identify = (appName: string, req: { method: string; url: string; headers: Record<string, string> }) => createIdentity({ app: appName, keysFile: `${dir}/keys.json` }).identify(req);
  return { sign, identify, protect: identity.protect };
}

describe("authorize", () => {
  const ok = (path: string, key = "roadmap-keeper") => () => authorize(app(), key, path);
  it("allows a granted caller under a prefix", () => {
    for (const p of ["/api/agent/roadmap", "/api/agent/roadmap/items/3", "/api/agent/roadmap?since=2026-11-01&x=a%20b"]) expect(ok(p)).not.toThrow();
  });
  it("refuses other callers and other paths", () => {
    expect(ok("/api/agent/roadmap", "app-maintainer")).toThrow(/may not call/);
    expect(ok("/api/agent/roadmap", "")).toThrow(/may not call/);
    expect(() => authorize(app({ api: undefined }), "roadmap-keeper", "/api/agent/roadmap")).toThrow(/no agent API/);
    for (const p of ["/api/agent/roadmap-admin", "/api/admin", "/", "/api/agent"]) expect(ok(p)).toThrow(/isn't under/);
  });
  it("refuses traversal and tricks", () => {
    for (const p of ["/api/agent/roadmap/../admin", "/api/agent/roadmap/./x", "/api/agent/roadmap//x", "/api/agent/roadmap/%2e%2e/admin", "/api/agent/roadmap\\..\\admin", "/api/agent/roadmap#x", "api/agent/roadmap", "//evil.example/api/agent/roadmap", "/api/agent/roadmap?a?b", "/api/agent/roadmap?a=<x>", "http://evil/api/agent/roadmap"])
      expect(ok(p), p).toThrow(/bad/);
  });
});


// Fake Docker: containers with compose labels and network IPs; resolve answers like `docker ps -q --filter label=...` + inspect.
const ctr = (id: string, project: string, service: string, ip: string) => ({ Id: id.padEnd(64, "0"), Config: { Labels: { "com.docker.compose.project": project, "com.docker.compose.service": service } }, NetworkSettings: { Networks: { [project]: { IPAddress: ip } } } });
const fakeDocker = (cs: ReturnType<typeof ctr>[], forged?: ReturnType<typeof ctr>): Resolve => async (a, service) => ({
  ids: cs.filter((c) => c.Config.Labels["com.docker.compose.project"] === `app-${a.name}` && c.Config.Labels["com.docker.compose.service"] === service).map((c) => c.Id.slice(0, 12)).join("\n"),
  inspect: async (id) => JSON.stringify([forged ?? cs.find((c) => c.Id.startsWith(id))]),
});

describe("callApi", () => {
  const setup = async (reply: (r: ApiRequest) => { status: number; headers: ResponseHeaders; body: string } | Promise<never>) => {
    const id = await identityFixture();
    const sent: ApiRequest[] = [];
    const into: string[] = [];
    return { id, sent, into, d: { sign: id.sign, resolve: fakeDocker([ctr("c1", "app-roadmap-keeper", "app", "172.22.0.5")]), send: async (_a: unknown, r: ApiRequest, c: string) => (sent.push(r), into.push(c), reply(r)) } };
  };
  it("sends a signed agent identity the app's middleware accepts, for this method and path only, and never echoes it", async () => {
    const { id, sent, into, d } = await setup((r) => ({ status: 200, headers: {}, body: JSON.stringify({ ok: true, echo: r.headers["x-aidenhq-identity"] }) }));
    const res = await callApi(app(), "roadmap-keeper", { method: "POST", path: "/api/agent/roadmap?x=1", body: { title: "x" } }, d);
    expect(into).toEqual(["c1".padEnd(64, "0")]); // sent from inside the verified container's network namespace
    expect(sent[0]).toMatchObject({ url: "http://127.0.0.1:8080/api/agent/roadmap?x=1", method: "POST", body: '{"title":"x"}', headers: { "content-type": "application/json" } });
    const token = sent[0]!.headers["x-aidenhq-identity"]!;
    expect(Object.keys(sent[0]!.headers).filter((k) => k.startsWith("x-aidenhq") || k === "authorization")).toEqual(["x-aidenhq-identity"]);
    const req = (method: string, url: string) => ({ method, url, headers: { "x-aidenhq-identity": token } });
    expect(id.identify("roadmap-keeper", req("POST", "/api/agent/roadmap?x=1"))).toEqual({ sub: "agent:roadmap-keeper", email: "", name: "roadmap-keeper", role: "admin", kind: "agent" });
    expect(() => id.identify("roadmap-keeper", req("DELETE", "/api/agent/roadmap"))).toThrow(/not for this request/);
    expect(() => id.identify("roadmap-keeper", req("POST", "/api/admin"))).toThrow(/not for this request/);
    expect(() => id.identify("other-app", req("POST", "/api/agent/roadmap"))).toThrow(/not for this app/);
    expect(res).toEqual({ status: 200, headers: {}, body: { ok: true, echo: "***" } });
    expect(JSON.stringify(res)).not.toContain(token);
  });
  it("audits caller, app, path and status; says so when apps-mcp has no key", async () => {
    const { d } = await setup(() => ({ status: 201, headers: {}, body: "{}" }));
    const log: object[] = [];
    await callApi(app(), "roadmap-keeper", { method: "POST", path: "/api/agent/roadmap", body: '{"a":1}' }, { ...d, audit: (o) => log.push(o) });
    expect(log).toEqual([{ caller: "roadmap-keeper", app: "roadmap-keeper", method: "POST", path: "/api/agent/roadmap", role: "admin", status: 201 }]);
    await expect(callApi(app(), "roadmap-keeper", { method: "GET", path: "/api/agent/roadmap" }, { ...d, sign: agentSigner("/nonexistent/apps.pem") })).rejects.toThrow(/no identity key/);
  });
  it("member: a listed caller reaches a real app's public route as the signed-in member app_view uses; an ungranted caller and an anonymous request are refused", async () => {
    const { id, d } = await setup(() => ({ status: 500, headers: {}, body: "unused" }));
    const seen: { user: unknown; body: string; token: string }[] = [];
    const server = createServer(id.protect((req: any, res: any) => {
      let raw = "";
      req.on("data", (c: Buffer) => (raw += c));
      req.on("end", () => {
        seen.push({ user: req.user, body: raw, token: String(req.headers["x-aidenhq-identity"] ?? "") });
        res.writeHead(201, { "content-type": "application/json", "x-echo": String(req.headers["x-aidenhq-identity"]) });
        res.end(JSON.stringify({ ok: true, received: JSON.parse(raw) }));
      });
    }));
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    const port = (server.address() as { port: number }).port;
    try {
      const res = await callApi(app(), "roadmap-keeper", { method: "POST", path: "/intake/feedback", body: { text: "canary" }, role: "member" }, { ...d, send: async (a, r, c) => {
        const u = new URL(r.url);
        const actual = await fetch(`http://127.0.0.1:${port}${u.pathname}${u.search}`, { method: r.method, headers: r.headers, body: r.body });
        const text = await actual.text();
        return { status: actual.status, headers: Object.fromEntries(actual.headers), body: text };
      } });
      expect(seen.map(({ user, body }) => ({ user, body }))).toEqual([{ user: { sub: "agent:roadmap-keeper", email: "", name: "roadmap-keeper", role: "member", kind: "agent" }, body: '{"text":"canary"}' }]);
      expect(res).toMatchObject({ status: 201, headers: { "content-type": "application/json", "x-echo": "***" }, body: { ok: true, received: { text: "canary" } } });
      expect(JSON.stringify(res)).not.toContain(seen[0]!.token);
      await expect(callApi(app(), "intruder", { method: "POST", path: "/intake/feedback", body: {}, role: "member" }, d)).rejects.toThrow(/may not call/);
      const anonymous = await fetch(`http://127.0.0.1:${port}/intake/feedback`, { method: "POST", body: "{}" }).then((r) => r.status);
      expect(anonymous).toBe(401);
      expect(seen).toHaveLength(1);
    } finally {
      await new Promise<void>((ok) => server.close(() => ok()));
    }
  });
  it("drops session-bearing response headers, keeps the app's real ones and repeats", async () => {
    const { d } = await setup(() => ({ status: 429, headers: { "retry-after": "37", "set-cookie": ["sid=live; HttpOnly", "csrf=x"], "x-multi": ["a", "b"], "content-type": "text/plain" }, body: "slow down" }));
    const r = await callApi(app(), "roadmap-keeper", { method: "POST", path: "/intake/feedback", role: "member" }, d);
    expect(r).toEqual({ status: 429, headers: { "retry-after": "37", "x-multi": ["a", "b"], "content-type": "text/plain" }, body: "slow down" });
    expect(JSON.stringify(r)).not.toContain("sid=live");
  });
  it("treats a header named like an inherited property as data, not a crash", async () => {
    // JSON.parse makes `__proto__` an own key (an object literal would set the prototype instead).
    const headers = JSON.parse('{"constructor":"x","__proto__":"y","x-real":"z"}') as ResponseHeaders;
    const { d } = await setup(() => ({ status: 201, headers, body: "ok" }));
    const r = await callApi(app(), "roadmap-keeper", { method: "POST", path: "/intake/feedback", role: "member" }, d);
    // Not status 0 (which is what a throwing accumulator would have produced): the app's real answer.
    expect(r.status).toBe(201);
    expect(Object.keys(r.headers).sort()).toEqual(["__proto__", "constructor", "x-real"]);
    expect(r.headers["constructor"]).toBe("x");
  });
  it("rejects a role other than admin or member instead of signing one", async () => {
    const { d } = await setup(() => ({ status: 200, headers: {}, body: "{}" }));
    await expect(callApi(app(), "roadmap-keeper", { method: "POST", path: "/api/agent/roadmap", role: "owner" as never }, d)).rejects.toThrow(/role must be admin or member/);
  });
  it("hides the token in errors, refuses before sending, caps text bodies", async () => {
    let seen = "";
    const bad = await setup((r) => ((seen = r.headers["x-aidenhq-identity"]!), Promise.reject(new Error(`connect failed ${r.headers["x-aidenhq-identity"]}`))));
    const err = await callApi(app(), "roadmap-keeper", { method: "GET", path: "/api/agent/roadmap" }, bad.d).catch((e: Error) => e.message);
    expect(err).toMatch(/connect failed \*\*\*/);
    expect(err).not.toContain(seen);
    const big = await setup(() => ({ status: 200, headers: {}, body: "x".repeat(60_000) }));
    await expect(callApi(app(), "intruder", { method: "GET", path: "/api/agent/roadmap" }, big.d)).rejects.toThrow(/may not call/);
    expect(big.sent).toEqual([]);
    const r = await callApi(app(), "roadmap-keeper", { method: "GET", path: "/api/agent/roadmap" }, big.d);
    expect((r.body as string).length).toBe(50_000);
    // A route-granted caller: the method decides before anything is sent.
    const routed = app({ api: { callers: [{ agent: "roadmap-feedback", paths: ["GET /api/agent/intake", "POST /api/agent/intake/{reference}/decision"] }], paths: ["/api/agent/intake"] } });
    const sent: ApiRequest[] = [];
    const d = { ...big.d, send: async (_a: unknown, r: ApiRequest) => (sent.push(r), { status: 200, headers: {}, body: "{}" }) };
    await expect(callApi(routed, "roadmap-feedback", { method: "DELETE", path: "/api/agent/intake" }, d)).rejects.toThrow(/isn't under/);
    await expect(callApi(routed, "roadmap-feedback", { method: "GET", path: "/api/agent/intake/AB12CD34/decision" }, d)).rejects.toThrow(/isn't under/);
    expect(sent).toEqual([]);
    await callApi(routed, "roadmap-feedback", { method: "POST", path: "/api/agent/intake/AB12CD34/decision", body: {} }, d);
    expect(sent.map((x) => `${x.method} ${x.url}`)).toEqual(["POST http://127.0.0.1:8080/api/agent/intake/AB12CD34/decision"]);
  });
});

