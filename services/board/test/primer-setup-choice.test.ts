// Setting Primer up from a fresh install, through its setup flow's choice: connect (the address, then OAuth) or self-host (an
// apply, then the pasted token). The flow is modules/primer's compiled board.setup_flows entry; the proxy, the kernel's
// save_secret and Paperclip are stood in for.
import { mkdtempSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { createApp } from "../src/app.js";
import { createKernelAuth } from "../src/kernel-auth.js";
import { McpAuth } from "../src/mcpauth.js";
import type { Paperclip } from "../src/paperclip.js";
import { changesOf } from "../src/settings-change.js";
import { Store } from "../src/store.js";
import { fakeRecords } from "./fake-records.js";
import { BOARD_KEY, fakeKernel } from "./kernel.js";

const GOOD = "primer_pat_" + "a".repeat(24);
const dir = mkdtempSync(join(tmpdir(), "primer-choice-"));
const compiledFile = join(dir, "paperclip.yaml");
process.env.BOARD_PAPERCLIP_CONFIG = compiledFile;
process.env.BOARD_MODULES_FILE = join(dir, "modules.json");
writeFileSync(process.env.BOARD_MODULES_FILE, JSON.stringify([{ name: "primer", enabled: true, settings: { primer_mode: { default: "connect", values: ["connect", "self-host"] }, primer_host: { default: "" }, primer_host_aud: { default: "" } } }]));
const live = (settings: Record<string, unknown>) => writeFileSync(compiledFile, stringify({ settings: Object.fromEntries(Object.entries(settings).map(([k, value]) => [k, { value, set: value !== "" }])) }));

const flow = {
  module: "primer", order: 125, title: "Primer", why: "Documents.", effort: "a few minutes", steps: "Choose.", signin: "primer",
  choose: {
    setting: "primer_mode",
    options: [
      { value: "connect", label: "Connect your organization's Primer", detail: "Paste its MCP address." },
      { value: "self-host", label: "Run your own Primer on this server", detail: "One apply.", requires: { setting: "edge", otherwise: "Needs a public address." }, inputs: [
        { setting: "primer_host", label: "Public address", pattern: "^[a-z0-9.-]+\\.[a-z]+$" },
        { setting: "primer_host_aud", label: "Audience", pattern: "^[A-Za-z0-9:._-]{1,200}$", when: { app_login: ["access", "header-jwt"] } },
      ] },
    ],
  },
};
const secrets = {
  "self-host": [{ secret: "primer_service_token", label: "Primer service token", pattern: "^primer_pat_[A-Za-z0-9_-]{16,}$" }],
  connect: [{ secret: "primer_mcp_url", label: "Primer MCP address", pattern: "^https://.+$" }],
};

describe.each(["connect", "self-host"] as const)("Primer setup from a fresh install, choosing %s", (mode) => {
  let kernel: Awaited<ReturnType<typeof fakeKernel>>;
  let app: ReturnType<typeof createApp>;
  let port = 0;
  let signedIn = false;
  const created: Record<string, any>[] = [];
  const saved = () => kernel.calls.filter((c) => c.path === "/v1/accounts/save_secret").map((c) => c.body as { secret: string; value: string });
  const proxy = new McpAuth("Primer", "http://primer-mcp:8084", "t", undefined, (async (u: string | URL) => {
    const path = new URL(String(u)).pathname;
    const value = saved().at(-1)?.value;
    if (path === "/auth/status") {
      if (mode === "self-host") return Response.json(!value ? { configured: true, state: "missing", paste: true } : { configured: true, state: value === GOOD ? "ok" : "expired", paste: true });
      return Response.json({ configured: Boolean(value), state: signedIn ? "ok" : "missing" });
    }
    if (path === "/auth/start") return Response.json({ url: "https://primer.example.com/oauth/authorize?state=s" });
    if (path === "/auth/finish") return (signedIn = true, Response.json({ ok: true }));
    return Response.json({}, { status: 404 });
  }) as typeof fetch);
  const pc = {
    me: async () => "owner-user", agents: async () => [], labels: async () => [{ id: "l1", name: "settings-change", color: "#000" }], company: async () => ({ issuePrefix: "WOR" }),
    createIssue: async (b: Record<string, any>) => (created.push(b), { id: "i1", identifier: "WOR-9", ...b }),
  } as unknown as Paperclip;

  beforeAll(async () => {
    live({ primer_mode: "connect", primer_host: "", primer_host_aud: "", app_login: "access" }); // a fresh install: no edge
    kernel = await fakeKernel();
    const accounts = createKernelAuth({ kernel: { url: kernel.url, token: BOARD_KEY }, adminUrl: "http://localhost:3120" });
    app = createApp({
      paperclip: pc, store: new Store(":memory:"), records: fakeRecords(), log: pino({ level: "silent" }), staticDir: "/nonexistent", timezone: "UTC", accounts, allowedHosts: ["localhost:3121"], mode: "lan", lan: { url: "https://aiden.example.com" },
      signIns: [{ id: "primer", label: "Primer", connect: "/primer/connect", callback: "/primer/callback", missing: "m", stopped: "s", fields: secrets[mode], auth: proxy }],
      setupFlows: { flows: [flow] },
    });
    await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
    port = (app.address() as AddressInfo).port;
  });
  afterAll(() => {
    app.close();
    kernel.close();
  });

  const owner = (method: string, path: string, body?: unknown) =>
    new Promise<{ status: number; json: any; location?: string }>((resolve, reject) => {
      const cookie = `aidenhq-board=${kernel.session({ id: "u-1", email: "o@example.com", name: "O", role: "admin", owner: true })}`;
      const headers: Record<string, string> = { host: "localhost:3121", cookie, ...(method !== "GET" ? { "content-type": "application/json", "x-aidenhq-board": "1", origin: "http://localhost:3121" } : {}) };
      const req = request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => resolve({ status: res.statusCode!, json: text && res.headers["content-type"]?.includes("json") ? JSON.parse(text) : undefined, location: res.headers.location }));
      });
      req.on("error", reject);
      req.end(body === undefined ? (method === "GET" ? undefined : "{}") : JSON.stringify(body));
    });
  const choice = async () => (await owner("GET", "/api/setup-flows")).json.flows[0].choose;

  it("opens the choice before anything else, then follows the pick to connected", async () => {
    // Connect opens the setup flow until the owner has chosen.
    expect(await owner("GET", "/primer/connect")).toMatchObject({ status: 302, location: "/#/setup/primer" });
    expect(await choice()).toMatchObject({ setting: "primer_mode", value: "connect", chosen: null });

    if (mode === "self-host") {
      // No public address on this install: refused, nothing filed.
      expect((await choice()).options[1].unavailable).toBe("Needs a public address.");
      expect(await owner("POST", "/api/setup-flows/primer/choose", { value: "self-host", inputs: { primer_host: "primer.example.com" } })).toMatchObject({ status: 409 });
      live({ primer_mode: "connect", primer_host: "", primer_host_aud: "", app_login: "access", edge: { tunnel_id: "x" } });
      expect((await choice()).options[1].unavailable).toBeUndefined();
      expect(await owner("POST", "/api/setup-flows/primer/choose", { value: "self-host", inputs: { primer_host: "nope" } })).toMatchObject({ status: 400 });
      expect(created).toHaveLength(0);
      // With app_login access the audience is asked too; the pick files the mode and both values as one change.
      expect((await choice()).options[1].inputs.map((i: { setting: string }) => i.setting)).toEqual(["primer_host", "primer_host_aud"]);
      expect((await owner("POST", "/api/setup-flows/primer/choose", { value: "self-host", inputs: { primer_host: "primer.example.com", primer_host_aud: "service:primer" } })).json).toEqual({ ok: true, identifier: "WOR-9" });
      expect(changesOf(created.at(-1)!.description)).toEqual([{ kind: "setting", key: "primer_mode", value: "self-host" }, { kind: "setting", key: "primer_host", value: "primer.example.com" }, { kind: "setting", key: "primer_host_aud", value: "service:primer" }]);
      // Until the apply lands the page waits: the pick isn't live, so Connect keeps sending it back to the flow.
      expect(await choice()).toMatchObject({ value: "connect", chosen: "self-host" });
      expect(await owner("GET", "/primer/connect")).toMatchObject({ status: 302, location: "/#/setup/primer" });
      live({ primer_mode: "self-host", primer_host: "primer.example.com", primer_host_aud: "service:primer", app_login: "access", edge: { tunnel_id: "x" } });
      expect(await choice()).toMatchObject({ value: "self-host", chosen: "self-host" });
    } else {
      // The hosted mode is what is live: choosing it files nothing.
      expect((await owner("POST", "/api/setup-flows/primer/choose", { value: "connect" })).json).toEqual({ ok: true });
      expect(created).toHaveLength(0);
    }

    // The Connect from #735 takes over for the mode.
    const [field] = secrets[mode];
    expect(await owner("GET", "/primer/connect")).toMatchObject({ status: 302, location: "/#/settings/connections?connect=primer" });
    if (mode === "self-host") {
      expect((await owner("POST", "/api/sign-ins/primer/secret", { secret: field!.secret, value: GOOD })).status).toBe(200);
    } else {
      expect((await owner("POST", "/api/sign-ins/primer/secret", { secret: field!.secret, value: "https://primer.example.com/mcp" })).status).toBe(200);
      expect(await owner("GET", "/primer/connect")).toMatchObject({ status: 302, location: "https://primer.example.com/oauth/authorize?state=s" });
      expect((await owner("GET", "/primer/callback?state=s&code=c")).status).toBe(302);
    }
    expect((await owner("GET", "/api/sign-ins/primer")).json).toMatchObject({ asks: false, state: "ok" });
  });

  it("reopens when finished with its current mode and its choices (secrets only as present, never their values), and a new pick files the same settings change", async () => {
    live({ primer_mode: mode, primer_host: mode === "self-host" ? "primer.example.com" : "", primer_host_aud: "service:primer", app_login: "access", edge: { tunnel_id: "x" } });
    const [f] = (await owner("GET", "/api/setup-flows")).json.flows;
    expect(f).toMatchObject({ module: "primer", done: true, choose: { value: mode, chosen: mode }, paired: true });
    expect(JSON.stringify(f)).not.toContain(GOOD);
    created.length = 0;
    const other = mode === "connect" ? { value: "self-host", inputs: { primer_host: "primer.example.com", primer_host_aud: "service:primer" } } : { value: "connect" };
    expect((await owner("POST", "/api/setup-flows/primer/choose", other)).json).toMatchObject({ ok: true, identifier: "WOR-9" });
    expect(changesOf(created.at(-1)!.description)![0]).toEqual({ kind: "setting", key: "primer_mode", value: other.value });
  });
});
