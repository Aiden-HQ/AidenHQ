import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { apiTarget, authorize, callApi, targetContainer, type ApiRequest, type Resolve } from "../src/api.js";
import { agentSigner } from "../src/identity.js";
import { isSensitive, parseApp } from "../src/registry.js";

const api = { callers: ["roadmap-keeper"], paths: ["/api/agent/roadmap"] };
const app = (o: object = {}) => parseApp({ name: "roadmap-keeper", repo: "example-org/roadmap-keeper", owner: "app-maintainer", description: "d", health: { url: "http://app:8080/api/health" }, api, ...o });

/** apps-mcp's key and the public keys.json an app mounts (as scripts/identity.mjs writes them), plus the app's middleware. */
export async function identityFixture() {
  const dir = mkdtempSync(`${tmpdir()}/identity-`);
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  writeFileSync(`${dir}/apps.pem`, privateKey.export({ format: "pem", type: "pkcs8" }));
  const sign = agentSigner(`${dir}/apps.pem`);
  const kid = JSON.parse(Buffer.from(sign("x", "y", { role: "member", methods: ["GET"] }).split(".")[0]!, "base64url").toString()).kid;
  writeFileSync(`${dir}/keys.json`, JSON.stringify({ keys: [{ ...publicKey.export({ format: "jwk" }), kid, iss: "aidenhq-apps" }] }));
  const middleware = new URL("../../shared/aidenhq-identity.mjs", import.meta.url).href; // the file every app copies
  const { createIdentity } = await import(middleware);
  const identify = (appName: string, req: { method: string; url: string; headers: Record<string, string> }) => createIdentity({ app: appName, keysFile: `${dir}/keys.json` }).identify(req);
  return { sign, identify };
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
  const setup = async (reply: (r: ApiRequest) => { status: number; body: string } | Promise<never>) => {
    const id = await identityFixture();
    const sent: ApiRequest[] = [];
    const into: string[] = [];
    return { id, sent, into, d: { sign: id.sign, resolve: fakeDocker([ctr("c1", "app-roadmap-keeper", "app", "172.22.0.5")]), send: async (_a: unknown, r: ApiRequest, c: string) => (sent.push(r), into.push(c), reply(r)) } };
  };
  it("sends a signed agent identity the app's middleware accepts, for this method and path only, and never echoes it", async () => {
    const { id, sent, into, d } = await setup((r) => ({ status: 200, body: JSON.stringify({ ok: true, echo: r.headers["x-aidenhq-identity"] }) }));
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
    expect(res).toEqual({ status: 200, body: { ok: true, echo: "***" } });
    expect(JSON.stringify(res)).not.toContain(token);
  });
  it("audits caller, app, path and status; says so when apps-mcp has no key", async () => {
    const { d } = await setup(() => ({ status: 201, body: "{}" }));
    const log: object[] = [];
    await callApi(app(), "roadmap-keeper", { method: "POST", path: "/api/agent/roadmap", body: '{"a":1}' }, { ...d, audit: (o) => log.push(o) });
    expect(log).toEqual([{ caller: "roadmap-keeper", app: "roadmap-keeper", method: "POST", path: "/api/agent/roadmap", status: 201 }]);
    await expect(callApi(app(), "roadmap-keeper", { method: "GET", path: "/api/agent/roadmap" }, { ...d, sign: agentSigner("/nonexistent/apps.pem") })).rejects.toThrow(/no identity key/);
  });
  it("hides the token in errors, refuses before sending, caps text bodies", async () => {
    let seen = "";
    const bad = await setup((r) => ((seen = r.headers["x-aidenhq-identity"]!), Promise.reject(new Error(`connect failed ${r.headers["x-aidenhq-identity"]}`))));
    const err = await callApi(app(), "roadmap-keeper", { method: "GET", path: "/api/agent/roadmap" }, bad.d).catch((e: Error) => e.message);
    expect(err).toMatch(/connect failed \*\*\*/);
    expect(err).not.toContain(seen);
    const big = await setup(() => ({ status: 200, body: "x".repeat(60_000) }));
    await expect(callApi(app(), "intruder", { method: "GET", path: "/api/agent/roadmap" }, big.d)).rejects.toThrow(/may not call/);
    expect(big.sent).toEqual([]);
    const r = await callApi(app(), "roadmap-keeper", { method: "GET", path: "/api/agent/roadmap" }, big.d);
    expect((r.body as string).length).toBe(50_000);
  });
});

