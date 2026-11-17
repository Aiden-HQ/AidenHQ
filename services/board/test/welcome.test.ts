// The first-run wizard's server side: the state the board shows a new owner and the one welcome chat it ends in.
import { mkdtempSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { createKernelAuth } from "../src/kernel-auth.js";
import type { Paperclip } from "../src/paperclip.js";
import { Store } from "../src/store.js";
import { fakeRecords } from "./fake-records.js";
import { BOARD_KEY, fakeKernel, type FakeAccount } from "./kernel.js";

const flow = (module: string, order: number, wizard?: boolean) => ({ module, order, title: module.toUpperCase(), why: "w", effort: "a minute", steps: "s", ...(wizard ? { wizard } : {}) });
const flows = [flow("later", 30, true), flow("optional", 5), flow("first", 20, true)];
const aiden = { id: "cos", name: "Aiden", status: "idle", adapterType: "codex_local", metadata: { setupKey: "aidenhq:chief-of-staff" } };
const label = { id: "l1", name: "chat", color: "#0ea5e9" };

describe("first-run welcome", () => {
  const created: { description: string }[] = [];
  const pc = {
    me: async () => "me-1",
    agents: async () => [aiden],
    labels: async () => [label],
    company: async () => ({ issuePrefix: "WOR" }),
    openIssues: async () => [],
    createIssue: async (i: { description: string }) => (created.push(i), { id: "i1", identifier: "WOR-1" }),
  } as unknown as Paperclip;
  let kernel: Awaited<ReturnType<typeof fakeKernel>>;
  let port = 0;
  let app: ReturnType<typeof createApp>;
  const dir = mkdtempSync(join(tmpdir(), "welcome-"));
  const marker = join(dir, "welcome-sent");
  beforeAll(async () => {
    kernel = await fakeKernel();
    const accounts = createKernelAuth({ kernel: { url: kernel.url, token: BOARD_KEY }, adminUrl: "http://localhost:3120" });
    app = createApp({ paperclip: pc, store: new Store(":memory:"), records: fakeRecords(), log: pino({ level: "silent" }), staticDir: "/nonexistent", timezone: "UTC", accounts, allowedHosts: ["localhost:3121"], mode: "lan", setupFlows: { flows }, welcomeMarker: marker });
    await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
    port = (app.address() as AddressInfo).port;
  });
  afterAll(() => {
    app.close();
    kernel.close();
  });
  const as = (account: FakeAccount) => {
    let cookie = "";
    return (method: string, path: string, body?: unknown) =>
      new Promise<{ status: number; json: any }>((resolve, reject) => {
        cookie ||= `aidenhq-board=${kernel.session(account)}`;
        const headers: Record<string, string> = { host: "localhost:3121", cookie, ...(method !== "GET" ? { "content-type": "application/json", "x-aidenhq-board": "1", origin: "http://localhost:3121" } : {}) };
        const req = request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
          let text = "";
          res.on("data", (c) => (text += c));
          res.on("end", () => resolve({ status: res.statusCode!, json: text ? JSON.parse(text) : undefined }));
        });
        req.on("error", reject);
        req.end(body === undefined ? (method === "GET" ? undefined : "{}") : JSON.stringify(body));
      });
  };
  const owner = as({ id: "u-1", email: "m@example.com", name: "Mo", role: "admin", owner: true });

  it("wizard lists only wizard flows in order", async () => {
    kernel.ops["/v1/accounts/recovery_key_waiting"] = [200, { waiting: true }];
    kernel.ops["/v1/accounts/model_ready"] = [200, { ready: true }];
    const r = (await owner("GET", "/api/welcome")).json;
    expect(r).toEqual({ finished: false, modelReady: true, recoveryKeyWaiting: true, wizard: ["first", "later"] });
  });

  it("no model key shows only the connect-a-model state", async () => {
    kernel.ops["/v1/accounts/model_ready"] = [200, { ready: false }];
    expect((await owner("GET", "/api/welcome")).json.modelReady).toBe(false);
    kernel.ops["/v1/accounts/model_ready"] = [200, { ready: true }];
  });

  it("finish posts one welcome with done and skipped; a second call posts nothing", async () => {
    const r = await owner("POST", "/api/welcome/finish", { done: ["first", "optional", "nope"], skipped: ["later"] });
    expect(r.json).toEqual({ ok: true, identifier: "WOR-1" });
    expect(created).toHaveLength(1);
    expect(created[0]!.description).toContain("Welcome\n\n[setup] Mo's AidenHQ is new. Connected: FIRST. Skipped: LATER. Start the first chat with a new owner (your handbook).");
    expect((await owner("POST", "/api/welcome/finish", { done: [], skipped: [] })).json).toEqual({ ok: true });
    expect(created).toHaveLength(1);
    expect((await owner("GET", "/api/welcome")).json.finished).toBe(true);
  });
});

describe("an existing welcome-sent marker", () => {
  it("skips the wizard", async () => {
    const kernel = await fakeKernel();
    kernel.ops["/v1/accounts/model_ready"] = [200, { ready: true }];
    const dir = mkdtempSync(join(tmpdir(), "welcome-"));
    const marker = join(dir, "welcome-sent");
    writeFileSync(marker, "");
    const accounts = createKernelAuth({ kernel: { url: kernel.url, token: BOARD_KEY }, adminUrl: "http://localhost:3120" });
    const app = createApp({ paperclip: {} as Paperclip, store: new Store(":memory:"), records: fakeRecords(), log: pino({ level: "silent" }), staticDir: "/nonexistent", timezone: "UTC", accounts, allowedHosts: ["localhost:3121"], mode: "lan", setupFlows: { flows }, welcomeMarker: marker });
    await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
    const cookie = `aidenhq-board=${kernel.session({ id: "u-1", email: "m@example.com", name: "Mo", role: "admin", owner: true })}`;
    const status = await new Promise<any>((resolve) =>
      request({ host: "127.0.0.1", port: (app.address() as AddressInfo).port, path: "/api/welcome", headers: { host: "localhost:3121", cookie } }, (res) => {
        let t = "";
        res.on("data", (c) => (t += c));
        res.on("end", () => resolve(JSON.parse(t)));
      }).end(),
    );
    expect(status.finished).toBe(true);
    app.close();
    kernel.close();
  });
});
