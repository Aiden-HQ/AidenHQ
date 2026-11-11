import { mkdtempSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { apiTarget, authorize, callApi, ensureApiToken, targetContainer, type ApiRequest, type Resolve } from "../src/api.js";
import { isSensitive, parseApp } from "../src/registry.js";

const api = { token: "ROADMAP_AGENT_TOKEN", callers: ["roadmap-keeper"], paths: ["/api/agent/roadmap"] };
const app = (o: object = {}) => parseApp({ name: "roadmap-keeper", repo: "example-org/roadmap-keeper", owner: "app-maintainer", description: "d", health: { url: "http://app:8080/api/health" }, api, ...o });

describe("registry: api", () => {
  it("mounts the token secret and validates the block", () => {
    expect(app().secrets).toEqual(["ROADMAP_AGENT_TOKEN"]);
    expect(app({ database: "warehouse", secrets: ["ROADMAP_DATABASE_URL"] }).secrets).toEqual(["ROADMAP_DATABASE_URL", "DATABASE_URL", "ROADMAP_AGENT_TOKEN"]);
    expect(isSensitive(app(), [])).toBe(false);
    expect(() => app({ api: { ...api, token: "bad-name" } })).toThrow();
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

describe("token", () => {
  it("is generated once, 0644, and never rotated", () => {
    const dir = mkdtempSync(`${tmpdir()}/api-`);
    ensureApiToken(app(), dir);
    const f = `${dir}/roadmap-keeper/ROADMAP_AGENT_TOKEN`;
    const t = readFileSync(f, "utf8");
    expect(t).toMatch(/^[0-9a-f]{64}$/);
    expect(statSync(f).mode & 0o777).toBe(0o644);
    ensureApiToken(app(), dir);
    expect(readFileSync(f, "utf8")).toBe(t);
    writeFileSync(f, "set-by-hand");
    ensureApiToken(app(), dir);
    expect(readFileSync(f, "utf8")).toBe("set-by-hand");
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
  const TOKEN = "f".repeat(64);
  const setup = (reply: (r: ApiRequest) => { status: number; body: string } | Promise<never>) => {
    const dir = mkdtempSync(`${tmpdir()}/api-`);
    mkdirSync(`${dir}/roadmap-keeper`);
    writeFileSync(`${dir}/roadmap-keeper/ROADMAP_AGENT_TOKEN`, TOKEN);
    const sent: ApiRequest[] = [];
    const into: string[] = [];
    return { sent, into, d: { secretsDir: dir, resolve: fakeDocker([ctr("c1", "app-roadmap-keeper", "app", "172.22.0.5")]), send: async (_a: unknown, r: ApiRequest, c: string) => (sent.push(r), into.push(c), reply(r)) } };
  };
  it("sends the bearer to the app's origin and never echoes it", async () => {
    const { sent, into, d } = setup((r) => ({ status: 200, body: JSON.stringify({ ok: true, echo: r.headers.authorization }) }));
    const res = await callApi(app(), "roadmap-keeper", { method: "POST", path: "/api/agent/roadmap", body: { title: "x" } }, d);
    expect(into).toEqual(["c1".padEnd(64, "0")]); // sent from inside the verified container's network namespace
    expect(sent[0]).toMatchObject({ url: "http://127.0.0.1:8080/api/agent/roadmap", method: "POST", body: '{"title":"x"}', headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" } });
    expect(res).toEqual({ status: 200, body: { ok: true, echo: "Bearer ***" } });
    expect(JSON.stringify(res)).not.toContain(TOKEN);
  });
  it("sends the gate secret and admin role to a shared app, and nothing of the sort to a non-shared one", async () => {
    const shared = setup(() => ({ status: 200, body: "{}" }));
    writeFileSync(`${shared.d.secretsDir}/roadmap-keeper/AIDENHQ_GATE_SECRET`, "g".repeat(64));
    await callApi(app({ port: 8080, share: { host: "r.example.com", aud: "aud-12345678" } }), "roadmap-keeper", { method: "GET", path: "/api/agent/roadmap" }, shared.d);
    expect(shared.sent[0]!.headers).toMatchObject({ "x-aidenhq-gate": "g".repeat(64), "x-aidenhq-user": "agent:roadmap-keeper", "x-aidenhq-role": "admin" });
    const leaky = setup((r) => ({ status: 200, body: JSON.stringify({ echo: r.headers["x-aidenhq-gate"] }) }));
    writeFileSync(`${leaky.d.secretsDir}/roadmap-keeper/AIDENHQ_GATE_SECRET`, "g".repeat(64));
    const res = await callApi(app({ port: 8080, share: { host: "r.example.com", aud: "aud-12345678" } }), "roadmap-keeper", { method: "GET", path: "/api/agent/roadmap" }, leaky.d);
    expect(JSON.stringify(res)).not.toContain("g".repeat(64));
    const plain = setup(() => ({ status: 200, body: "{}" }));
    await callApi(app(), "roadmap-keeper", { method: "GET", path: "/api/agent/roadmap" }, plain.d);
    expect(Object.keys(plain.sent[0]!.headers).filter((k) => k.startsWith("x-aidenhq"))).toEqual([]);
  });
  it("audits caller, app, path and status, and asks for a deploy when there is no token yet", async () => {
    const { d } = setup(() => ({ status: 201, body: "{}" }));
    const log: object[] = [];
    await callApi(app(), "roadmap-keeper", { method: "POST", path: "/api/agent/roadmap", body: '{"a":1}' }, { ...d, audit: (o) => log.push(o) });
    expect(log).toEqual([{ caller: "roadmap-keeper", app: "roadmap-keeper", method: "POST", path: "/api/agent/roadmap", status: 201 }]);
    await expect(callApi(app(), "roadmap-keeper", { method: "GET", path: "/api/agent/roadmap" }, { ...d, secretsDir: `${d.secretsDir}/none` })).rejects.toThrow(/deploy it once/);
  });
  it("hides the token in errors, refuses before sending, caps text bodies", async () => {
    const bad = setup(() => Promise.reject(new Error(`connect failed Bearer ${TOKEN}`)));
    await expect(callApi(app(), "roadmap-keeper", { method: "GET", path: "/api/agent/roadmap" }, bad.d)).rejects.toThrow(/Bearer \*\*\*/);
    await expect(callApi(app(), "roadmap-keeper", { method: "GET", path: "/api/agent/roadmap" }, bad.d)).rejects.not.toThrow(TOKEN);
    const big = setup(() => ({ status: 200, body: "x".repeat(60_000) }));
    await expect(callApi(app(), "intruder", { method: "GET", path: "/api/agent/roadmap" }, big.d)).rejects.toThrow(/may not call/);
    expect(big.sent).toEqual([]);
    const r = await callApi(app(), "roadmap-keeper", { method: "GET", path: "/api/agent/roadmap" }, big.d);
    expect((r.body as string).length).toBe(50_000);
  });
});
