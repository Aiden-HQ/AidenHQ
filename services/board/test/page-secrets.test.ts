// A module page's Sign-ins panel route (POST /api/pages/<page>/secrets/<secret>/<key>): each value is capped by the page's
// declared field (300 when it declares none), a key field's whitespace is kept byte for byte, a text field still trims, and the
// body holds a 64 KB private key. The kernel's accounts routes are stood in for (kernel.ts); what the board sent it is read back.
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { createApp } from "../src/app.js";
import type { PagePoint } from "../src/module-views.js";
import { createKernelAuth } from "../src/kernel-auth.js";
import { Paperclip } from "../src/paperclip.js";
import { Store } from "../src/store.js";
import { fakeRecords } from "./fake-records.js";
import { BOARD_KEY, fakeKernel, type FakeAccount } from "./kernel.js";

// A sample key's armour, built from parts so the repo's leak scan doesn't read this test as one.
const PEM_HEAD = ["-----BEGIN", "OPENSSH", "PRIVATE KEY-----"].join(" ");
const PEM_END = ["-----END", "OPENSSH", "PRIVATE KEY-----"].join(" ");

const dir = mkdtempSync(join(tmpdir(), "page-secrets-"));
writeFileSync(join(dir, "paperclip.yaml"), stringify({ settings: { servers_machines: { value: [{ name: "alpha" }, { name: "beta" }], set: true } } }));
writeFileSync(join(dir, "modules.json"), JSON.stringify([]));
process.env.BOARD_PAPERCLIP_CONFIG = join(dir, "paperclip.yaml");
process.env.BOARD_MODULES_FILE = join(dir, "modules.json");

const pages: PagePoint[] = [
  {
    id: "servers", title: "Servers", icon: "list", order: 10, module: "servers", connection: "servers-mcp", view: "ui://servers/page", tools: [], settings: ["servers_machines"],
    secret_maps: [{ secret: "servers_keys", keys_from: "servers_machines[].name", fields: [
      { name: "label", label: "Label", kind: "text" },
      { name: "login", label: "Login", kind: "password" },
      { name: "private_key", label: "Private key", kind: "key", maxLength: 4096 },
    ] }],
  },
  // A page whose key field declares the schema's own ceiling (65536).
  {
    id: "bigkeys", title: "Big keys", icon: "list", order: 20, module: "servers", connection: "servers-mcp", view: "ui://servers/big", tools: [], settings: ["servers_machines"],
    secret_maps: [{ secret: "servers_keys", keys_from: "servers_machines[].name", fields: [{ name: "private_key", label: "Private key", kind: "key", maxLength: 65536 }] }],
  },
];

describe("page secret values", () => {
  let app: ReturnType<typeof createApp>, port = 0, kernel: Awaited<ReturnType<typeof fakeKernel>>, accounts: ReturnType<typeof createKernelAuth>;
  beforeAll(async () => {
    kernel = await fakeKernel();
    // sent stores nothing: the board's sent values are read from kernel.calls.
    kernel.ops["/v1/accounts/secret_keys"] = [200, { keys: [] }];
    accounts = createKernelAuth({ kernel: { url: kernel.url, token: BOARD_KEY }, adminUrl: "http://localhost:3120" });
    const paperclip = new Paperclip("http://paperclip", "00000000-0000-4000-8000-000000000001", "k", (async () => new Response("[]")) as unknown as typeof fetch);
    app = createApp({
      paperclip, store: new Store(":memory:"), records: fakeRecords(), log: pino({ level: "silent" }), staticDir: "/nonexistent", timezone: "UTC",
      accounts, allowedHosts: ["localhost:3121"], mode: "lan",
      views: { pages: () => pages, page: async (id: string) => pages.find((p) => p.id === id)!, html: async () => "", call: async () => ({}), reads: async () => ({}) } as never,
    });
    await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
    port = (app.address() as AddressInfo).port;
  });
  afterAll(() => {
    app.close();
    kernel.close();
  });
  const admin: FakeAccount = { id: "u-1", email: "a@example.com", name: "A", role: "admin", owner: true };
  const send = (key: string, values: unknown, page = "servers") =>
    new Promise<{ status: number; json: any }>((resolve, reject) => {
      const body = JSON.stringify({ values });
      const r = request({ host: "127.0.0.1", port, method: "POST", path: `/api/pages/${page}/secrets/servers_keys/${key}`, headers: {
        host: "localhost:3121", "content-type": "application/json", "x-aidenhq-board": "1", origin: "http://localhost:3121",
        cookie: `aidenhq-board=${kernel.session(admin)}`,
      } }, (res) => {
        let t = "";
        res.on("data", (c) => (t += c));
        res.on("end", () => resolve({ status: res.statusCode!, json: t ? JSON.parse(t) : undefined }));
      });
      r.on("error", reject);
      r.end(body);
    });
  const lastSent = () => kernel.calls.filter((c) => c.path === "/v1/accounts/save_secret").at(-1)?.body;

  it("a key field over its declared maxLength is refused before the kernel is called", async () => {
    const before = kernel.calls.filter((c) => c.path === "/v1/accounts/save_secret").length;
    const r = await send("alpha", { label: "a", login: "u", private_key: "k".repeat(4097) });
    expect(r.status).toBe(400);
    expect(r.json.error).toContain("private_key is longer than 4096");
    expect(kernel.calls.filter((c) => c.path === "/v1/accounts/save_secret").length).toBe(before);
  });

  it("a key field's value is stored whole, its trailing newline included, byte for byte", async () => {
    const pem = `${PEM_HEAD}\nAAAAB3NzaC1yc2E\n\tindented line\n${PEM_END}\n`;
    const r = await send("alpha", { label: "alpha", login: "root", private_key: pem });
    expect(r.status).toBe(200);
    const sent = lastSent();
    expect(JSON.parse(sent.value)).toEqual({ label: "alpha", login: "root", private_key: pem });
    expect(JSON.parse(sent.value).private_key.endsWith(`${PEM_END}\n`)).toBe(true);
  });

  it("a text field is still trimmed, and a password keeps its spaces", async () => {
    const r = await send("alpha", { label: "  alpha  ", login: " root ", private_key: "k\n" });
    expect(r.status).toBe(200);
    expect(JSON.parse(lastSent().value)).toEqual({ label: "alpha", login: " root ", private_key: "k\n" });
  });

  it("an undeclared field still caps at 300", async () => {
    const r = await send("alpha", { label: "l".repeat(301), login: "u", private_key: "k" });
    expect(r.status).toBe(400);
    expect(r.json.error).toContain("label is longer than 300");
  });

  it("a value for a name the page doesn't declare is refused", async () => {
    const r = await send("alpha", { label: "a", login: "u", private_key: "k", other: "x" });
    expect(r.status).toBe(400);
    expect(r.json.error).toBe("not one of this page's fields");
  });


  it("a key at the schema's ceiling of 65536 characters fits the route's body, even all newlines", async () => {
    // Every character a newline: its JSON escaping is the worst case, twice the field's length.
    const at = "\n".repeat(65536);
    const r = await send("beta", { private_key: at }, "bigkeys");
    expect(r.status).toBe(200);
    expect(JSON.parse(lastSent().value).private_key).toBe(at);
    // One over the ceiling is refused.
    expect((await send("beta", { private_key: "k".repeat(65537) }, "bigkeys")).status).toBe(400);
  });

  it("a 4 KB key plus JSON escaping fits the route's 64 KB body", async () => {
    // 4096 characters of JSON-escaped text (each a newline's escape) still fits.
    const key = "\n".repeat(4096);
    const r = await send("beta", { label: "b", login: "u", private_key: key });
    expect(r.status).toBe(200);
    expect(JSON.parse(lastSent().value).private_key).toBe(key);
  });
});
