import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { apiTarget, authorize, callApi, targetContainer, type ApiRequest, type ResponseHeaders, type Resolve } from "../src/api.js";
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

describe("registry: api", () => {
  it("validates the block; a static token is gone", () => {
    expect(app().secrets).toEqual([]);
    expect(app({ database: "warehouse", secrets: ["ROADMAP_DATABASE_URL"] }).secrets).toEqual(["ROADMAP_DATABASE_URL", "DATABASE_URL"]);
    expect(isSensitive(app(), [])).toBe(false);
    expect(() => app({ api: { ...api, token: "ROADMAP_AGENT_TOKEN" } })).toThrow(/api.token is gone/);
    expect(() => app({ secrets: ["AIDENHQ_IDENTITY_KEYS"] })).toThrow(/platform/);
    expect(() => app({ api: { ...api, callers: [] } })).toThrow();
    expect(() => app({ api: { ...api, paths: ["api/x"] } })).toThrow();
    expect(() => app({ api: { ...api, paths: ["GET /api/agent/roadmap"] } })).toThrow(); // the app's own paths stay prefixes
    const routed = app({ api: { callers: [{ agent: "k", paths: ["POST /api/agent/intake/{reference}/decision"] }], paths: api.paths } });
    expect(routed.api!.callers).toEqual([{ agent: "k", paths: ["POST /api/agent/intake/{reference}/decision"] }]);
    expect(routed.api!.member_paths).toEqual([]);
    expect(app({ api: { ...api, member_paths: ["/intake", "/intake/feedback"] } }).api!.member_paths).toEqual(["/intake", "/intake/feedback"]);
    expect(() => app({ api: { ...api, member_paths: ["intake"] } })).toThrow();
    for (const bad of ["/intake//feedback", "/intake?x=1", "/intake/../feedback", "/intake/./feedback", "https://example.com/intake"]) {
      expect(() => app({ api: { ...api, member_paths: [bad] } }), bad).toThrow();
    }
    for (const bad of ["GET /api/agent/{a}{b}", "get /api/agent/x", "FETCH /api/agent/x", "GET /api/agent/{a b}", "GET /api/agent/{a/b}", "GET /api/agent//x", "GET /api/agent/x y", "GET/api/agent/x", "GET ", "GET /api/agent/../x"])
      expect(() => app({ api: { ...api, callers: [{ agent: "k", paths: [bad] }] } }), bad).toThrow();
    expect(() => app({ health: {} })).toThrow(/health.url/);
  });
});

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

describe("a caller's exact routes", () => {
  // The caller's entry names the two routes it uses; the app's own paths stay the prefixes where its API lives.
  const rk = app({
    api: {
      callers: ["roadmap-keeper", { agent: "roadmap-feedback", paths: ["GET /api/agent/intake", "POST /api/agent/intake/{reference}/decision"] }],
      paths: ["/api/agent/roadmap", "/api/agent/intake"],
    },
  });
  const as = (method: string, path: string, key = "roadmap-feedback") => () => authorize(rk, key, path, method);

  it("allows its two routes, with a query string on the GET and any reference on the POST", () => {
    expect(as("GET", "/api/agent/intake?status=received")).not.toThrow();
    expect(as("POST", "/api/agent/intake/AB12CD34/decision")).not.toThrow();
    expect(as("POST", "/api/agent/intake/9f3e/decision")).not.toThrow();
  });
  it("denies another method, a bare or extra segment, a missing reference, and a path outside the grant", () => {
    for (const [m, p] of [
      ["DELETE", "/api/agent/intake"],
      ["POST", "/api/agent/intake"],
      ["GET", "/api/agent/intake/AB12CD34/decision"],
      ["HEAD", "/api/agent/intake"],
      ["POST", "/api/agent/intake/AB12CD34/decision/extra"],
      ["POST", "/api/agent/intake/decision"],
      ["GET", "/api/agent/intake/x"],
      ["GET", "/api/item"],
    ] as const)
      expect(as(m, p), `${m} ${p}`).toThrow(/isn't under/);
    expect(as("GET", "/api/agent/intake/../decision")).toThrow(/bad path/);
  });
  it("is never read as a prefix: a read route can't be spent on a write, and a route never widens the app's own paths", () => {
    const readOnly = app({ api: { callers: [{ agent: "reader", paths: ["GET /api/agent/intake"] }], paths: ["/api/agent/intake"] } });
    expect(() => authorize(readOnly, "reader", "/api/agent/intake?status=received", "GET")).not.toThrow();
    expect(() => authorize(readOnly, "reader", "/api/agent/intake", "POST")).toThrow(/isn't under/);
    expect(() => authorize(readOnly, "reader", "/api/agent/intake/AB12CD34/decision", "GET")).toThrow(/isn't under/);
    const outside = app({ api: { callers: [{ agent: "reader", paths: ["GET /api/admin/users"] }], paths: ["/api/agent/intake"] } });
    expect(() => authorize(outside, "reader", "/api/admin/users", "GET")).toThrow(/isn't under/);
  });
  it("holds a member request to the caller's own grants; a plain-string caller reaches any route the app serves", () => {
    const asMember = (method: string, path: string, key = "roadmap-feedback") => () => authorize(rk, key, path, method, "member");
    // The same exact routes it may use as admin, and nothing else: a narrow integration never widens to the public surface.
    expect(asMember("GET", "/api/agent/intake?status=received")).not.toThrow();
    expect(asMember("POST", "/api/agent/intake/AB12CD34/decision")).not.toThrow();
    for (const [m, p] of [["POST", "/intake/feedback"], ["DELETE", "/api/agent/intake"], ["GET", "/admin/intake"], ["POST", "/"]] as const)
      expect(asMember(m, p), `${m} ${p}`).toThrow(/isn't under/);
    // The app's own agent is a plain-string caller: listed for the whole app, so member reaches any public route.
    expect(asMember("POST", "/intake/feedback", "roadmap-keeper")).not.toThrow();
    expect(asMember("GET", "/admin/intake", "roadmap-keeper")).not.toThrow();
    // The caller gate still applies.
    expect(() => authorize(rk, "intruder", "/intake/feedback", "POST", "member")).toThrow(/may not call/);
  });
  it("extends a member request to api.member_paths, while admin and an object caller's own grant keep their limits", () => {
    const publicGrants = app({
      api: {
        callers: [
          { agent: "red-teamer", paths: ["/intake", "/intake/feedback"] },
          { agent: "intake-only", paths: ["/intake/feedback"] },
          { agent: "exact", paths: ["POST /intake/{reference}"] },
        ],
        paths: ["/api/agent/roadmap"],
        member_paths: ["/intake", "/intake/feedback"],
      },
    });
    const asMember = (method: string, path: string, key = "red-teamer") => () => authorize(publicGrants, key, path, method, "member");
    expect(asMember("POST", "/intake")).not.toThrow();
    expect(asMember("POST", "/intake/feedback")).not.toThrow();
    expect(asMember("POST", "/intake/missing_item")).not.toThrow();
    expect(asMember("POST", "/intake/feedback", "intake-only")).not.toThrow();
    expect(asMember("POST", "/intake", "intake-only")).toThrow(/isn't under/);
    // An exact-route caller keeps its method and segment count under member_paths too.
    expect(asMember("POST", "/intake/AB12CD34", "exact")).not.toThrow();
    expect(asMember("GET", "/intake/AB12CD34", "exact")).toThrow(/isn't under/);
    expect(asMember("POST", "/intake/AB12CD34/extra", "exact")).toThrow(/isn't under/);
    expect(asMember("POST", "/intake/feedback", "intruder")).toThrow(/may not call/);
    expect(asMember("POST", "/admin/intake")).toThrow(/isn't under/);
    // A denial names the app's grant (member_paths included) and the caller's own paths, so a member_paths gap doesn't
    // read as the caller's paths being wrong.
    expect(asMember("POST", "/admin/intake")).toThrow(/member_paths \(\/intake, \/intake\/feedback\)/);
    expect(asMember("POST", "/admin/intake")).toThrow(/caller's own paths \(\/intake, \/intake\/feedback\)/);
    // Admin still has the app's own agent API only; member_paths is not a writer path.
    expect(() => authorize(publicGrants, "red-teamer", "/intake/feedback", "POST")).toThrow(/isn't under/);
    expect(() => authorize(publicGrants, "red-teamer", "/api/agent/roadmap", "POST")).toThrow(/isn't under/);
    // An app without member_paths behaves exactly as before: the same object caller cannot reach the public route.
    const unchanged = app({ api: { callers: [{ agent: "red-teamer", paths: ["/intake", "/intake/feedback"] }], paths: ["/api/agent/roadmap"] } });
    expect(() => authorize(unchanged, "red-teamer", "/intake/feedback", "POST", "member")).toThrow(/isn't under/);
    expect(() => authorize(unchanged, "red-teamer", "/intake/feedback", "POST", "member")).toThrow(/member_paths \(none\)/);
    expect(() => authorize(unchanged, "red-teamer", "/intake/feedback", "POST", "member")).toThrow(/caller's own paths \(\/intake, \/intake\/feedback\)/);
    // A member route the app grants but this caller's own paths lack names the caller's grant too.
    const narrowCaller = app({ api: { callers: [{ agent: "red-teamer", paths: ["/api/agent/roadmap"] }], paths: ["/api/agent/roadmap"], member_paths: ["/intake"] } });
    expect(() => authorize(narrowCaller, "red-teamer", "/intake", "POST", "member")).toThrow(/member_paths \(\/intake\)/);
    expect(() => authorize(narrowCaller, "red-teamer", "/intake", "POST", "member")).toThrow(/caller's own paths \(\/api\/agent\/roadmap\)/);
    // A plain-string caller is already granted the app's whole surface; member_paths does not narrow or widen it.
    const plain = app({ api: { callers: ["red-teamer"], paths: ["/api/agent/roadmap"], member_paths: ["/intake"] } });
    expect(() => authorize(plain, "red-teamer", "/intake/feedback", "POST", "member")).not.toThrow();
    expect(() => authorize(plain, "red-teamer", "/admin/intake", "POST", "member")).not.toThrow();
  });
  it("leaves the app's own agent, and a bare-path {agent, paths} caller, as prefix callers", () => {
    expect(as("GET", "/api/agent/roadmap/items/3", "roadmap-keeper")).not.toThrow();
    expect(as("DELETE", "/api/agent/intake/x", "roadmap-keeper")).not.toThrow();
    expect(as("GET", "/", "roadmap-keeper")).toThrow(/isn't under/);
    const prefixed = app({ api: { callers: [{ agent: "reader", paths: ["/api/agent/intake"] }], paths: ["/api/agent/intake"] } });
    for (const [m, p] of [["GET", "/api/agent/intake?status=received"], ["GET", "/api/agent/intake/AB12CD34/decision"], ["DELETE", "/api/agent/intake/x"]] as const)
      expect(() => authorize(prefixed, "reader", p, m), `${m} ${p}`).not.toThrow();
    expect(() => authorize(prefixed, "reader", "/api/agent/intake-other", "GET")).toThrow(/isn't under/);
  });
});


// Fake Docker: containers with compose labels and network IPs; resolve answers like `docker ps -q --filter label=...` + inspect.
const ctr = (id: string, project: string, service: string, ip: string) => ({ Id: id.padEnd(64, "0"), Config: { Labels: { "com.docker.compose.project": project, "com.docker.compose.service": service } }, NetworkSettings: { Networks: { [project]: { IPAddress: ip } } } });
const fakeDocker = (cs: ReturnType<typeof ctr>[], forged?: ReturnType<typeof ctr>): Resolve => async (a, service) => ({
  ids: cs.filter((c) => c.Config.Labels["com.docker.compose.project"] === `app-${a.name}` && c.Config.Labels["com.docker.compose.service"] === service).map((c) => c.Id.slice(0, 12)).join("\n"),
  inspect: async (id) => JSON.stringify([forged ?? cs.find((c) => c.Id.startsWith(id))]),
});

describe("target", () => {
  it("is the app's own container, found by compose labels, by its full id", async () => {
    expect(apiTarget(app())).toEqual({ service: "app", protocol: "http:", port: "8080" });
    expect(() => apiTarget(app({ health: { url: "http://10.0.0.5:8080/h" } }))).toThrow(/compose service/);
    // app xy service a-b and app xy-a service b share the name app-xy-a-b-1; labels tell them apart.
    const x = app({ name: "xy" }), xa = app({ name: "xy-a" });
    const docker = fakeDocker([ctr("1", "app-xy", "a-b", "172.20.0.2"), ctr("2", "app-xy-a", "b", "172.21.0.2"), ctr("3", "app-roadmap-keeper", "app", "172.22.0.5"), ctr("4", "app-other", "app", "172.22.0.9")]);
    expect(await targetContainer(x, "a-b", docker)).toBe("1".padEnd(64, "0"));
    expect(await targetContainer(xa, "b", docker)).toBe("2".padEnd(64, "0"));
    expect(await targetContainer(app(), "app", docker)).toBe("3".padEnd(64, "0"));
  });
  it("refuses none, several, or a container that isn't the app's", async () => {
    await expect(targetContainer(app(), "app", fakeDocker([]))).rejects.toThrow(/found 0/);
    await expect(targetContainer(app(), "app", fakeDocker([ctr("1", "app-roadmap-keeper", "app", "1.1.1.1"), ctr("2", "app-roadmap-keeper", "app", "1.1.1.2")]))).rejects.toThrow(/found 2/);
    await expect(targetContainer(app(), "app", fakeDocker([ctr("1", "app-roadmap-keeper", "app", "1.1.1.1")], ctr("1", "app-other", "app", "1.1.1.9")))).rejects.toThrow(/isn't this app's/);
  });
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


describe("an app's feedback agent", () => {
  const rk = app({ feedback_to: "roadmap-feedback", api: { callers: ["roadmap-keeper", { agent: "roadmap-feedback", paths: ["/api/agent/intake"] }], paths: ["/api/agent/roadmap", "/api/agent/intake"] } });
  it("calls only its own paths of that app's API", () => {
    expect(() => authorize(rk, "roadmap-feedback", "/api/agent/intake?status=received")).not.toThrow();
    expect(() => authorize(rk, "roadmap-feedback", "/api/agent/intake/AB12CD34/decision")).not.toThrow();
    expect(() => authorize(rk, "roadmap-feedback", "/api/agent/roadmap")).toThrow(/for this caller/);
    expect(() => authorize(rk, "roadmap-keeper", "/api/agent/roadmap")).not.toThrow();
  });
  it("reaches no other app with any tool", () => {
    const other = app({ name: "wiki" });
    expect(() => feedbackOnly([rk, other], "roadmap-feedback", "roadmap-keeper")).not.toThrow();
    expect(() => feedbackOnly([rk, other], "roadmap-feedback", "wiki")).toThrow(/handles feedback for roadmap-keeper only/);
    expect(() => feedbackOnly([rk, other], "roadmap-feedback", undefined)).toThrow(); // app_list, warehouse_query: no app named
    expect(() => feedbackOnly([rk, other], "roadmap-keeper", "wiki")).not.toThrow();
  });
});
