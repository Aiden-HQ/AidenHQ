import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { authorize, callApi, type ApiRequest, type Resolve } from "../src/api.js";
import { agentSigner } from "../src/identity.js";
import { parseApp } from "../src/registry.js";

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
  const identify = (appName: string, req: { method: string; url: string; headers: Record<string, string> }) => createIdentity({ app: appName, keysFile: `${dir}/keys.json` }).identify(req);
  return { sign, identify };
}

describe("authorize", () => {
  const ok = (path: string, key = "roadmap-keeper") => () => authorize(app(), key, path);
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
    // A route-granted caller: the method decides before anything is sent.
    const routed = app({ api: { callers: [{ agent: "roadmap-feedback", paths: ["GET /api/agent/intake", "POST /api/agent/intake/{reference}/decision"] }], paths: ["/api/agent/intake"] } });
    const sent: ApiRequest[] = [];
    const d = { ...big.d, send: async (_a: unknown, r: ApiRequest) => (sent.push(r), { status: 200, body: "{}" }) };
    await expect(callApi(routed, "roadmap-feedback", { method: "DELETE", path: "/api/agent/intake" }, d)).rejects.toThrow(/isn't under/);
    await expect(callApi(routed, "roadmap-feedback", { method: "GET", path: "/api/agent/intake/AB12CD34/decision" }, d)).rejects.toThrow(/isn't under/);
    expect(sent).toEqual([]);
    await callApi(routed, "roadmap-feedback", { method: "POST", path: "/api/agent/intake/AB12CD34/decision", body: {} }, d);
    expect(sent.map((x) => `${x.method} ${x.url}`)).toEqual(["POST http://127.0.0.1:8080/api/agent/intake/AB12CD34/decision"]);
  });
});

