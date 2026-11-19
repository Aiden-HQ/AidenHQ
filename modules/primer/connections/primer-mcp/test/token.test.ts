import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterAll, beforeAll, expect, it } from "vitest";
import { fileToken, tokenAuth } from "../src/token.js";
import { createVendorProxy } from "../src/vendor/proxy.js";

// The owner's setup of a self-hosted Primer, as the board sees it through /auth/status: nothing saved, a token Primer refuses,
// then the token it accepts (written into the same file, as the kernel saves a secret): connected, with no restart.
const GOOD = "primer_pat_" + "a".repeat(24);
const primer = createServer((req, res) => {
  const ok = req.url === "/api/me" && req.headers.authorization === `Bearer ${GOOD}`;
  res.writeHead(ok ? 200 : 401, { "content-type": "application/json" }).end(JSON.stringify(ok ? { email: "owner@example.com" } : { error: "unauthorized" }));
});
const file = join(mkdtempSync(join(tmpdir(), "primer-token-")), "primer_service_token");
let board = "";
const status = async () => (await fetch(`${board}/auth/status`, { headers: { authorization: "Bearer brd" } })).json();

beforeAll(async () => {
  await new Promise<void>((r) => primer.listen(0, "127.0.0.1", r));
  const local = `http://127.0.0.1:${(primer.address() as AddressInfo).port}`;
  const proxy = createVendorProxy({
    name: "Primer", upstream: new URL(`${local}/mcp`), auth: tokenAuth(fileToken(file), local), log: pino({ level: "silent" }), serviceKey: "svc", authKey: "brd",
    caller: async () => {}, instructions: "test", stateDir: mkdtempSync(join(tmpdir(), "primer-state-")),
  });
  await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
  board = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
});
afterAll(() => void primer.close());

it("self-host: missing until a token is saved, expired with Primer's refusal, connected once it accepts the token", async () => {
  expect(await status()).toMatchObject({ configured: true, state: "missing", paste: true });
  expect((await fetch(`${board}/auth/start`, { method: "POST", headers: { authorization: "Bearer brd" }, body: "{}" })).status).toBe(400); // no OAuth sign-in to start
  writeFileSync(file, "primer_pat_" + "b".repeat(24), { mode: 0o600 });
  expect(await status()).toMatchObject({ state: "expired", paste: true, detail: expect.stringContaining("refused the service token") });
  writeFileSync(file, GOOD);
  expect(await status()).toMatchObject({ configured: true, state: "ok", paste: true });
});
