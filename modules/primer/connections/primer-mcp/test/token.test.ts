import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterAll, beforeAll, expect, it } from "bun:test";
import { connectorToken, tokenAuth } from "../src/token.js";
import { createVendorProxy } from "../src/vendor/proxy.js";

// The self-hosted Primer as the board sees it through /auth/status: the connector signs in with primer_pat_<the generated
// secret> (seeded by modules/primer/server/start.ts), connected with nothing pasted; a token Primer refuses reads expired.
const SECRET = "a".repeat(64);
let accept = `primer_pat_${SECRET}`;
const primer = createServer((req, res) => {
  const ok = req.url === "/api/me" && req.headers.authorization === `Bearer ${accept}`;
  res.writeHead(ok ? 200 : 401, { "content-type": "application/json" }).end(JSON.stringify(ok ? { email: "agent@agents.primer.invalid" } : { error: "unauthorized" }));
});
const file = join(mkdtempSync(join(tmpdir(), "primer-token-")), "primer_connector_token");
let board = "";
const status = async () => (await fetch(`${board}/auth/status`, { headers: { authorization: "Bearer brd" } })).json();

beforeAll(async () => {
  writeFileSync(file, `${SECRET}\n`, { mode: 0o600 });
  await new Promise<void>((r) => primer.listen(0, "127.0.0.1", r));
  const local = `http://127.0.0.1:${(primer.address() as AddressInfo).port}`;
  const proxy = createVendorProxy({
    name: "Primer", upstream: new URL(`${local}/mcp`), auth: tokenAuth(connectorToken(file), local), log: pino({ level: "silent" }), serviceKey: "svc", authKey: "brd",
    caller: async () => {}, instructions: "test", stateDir: mkdtempSync(join(tmpdir(), "primer-state-")),
  });
  await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
  board = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
});
afterAll(() => void primer.close());

it("self-host: connected from the start with the generated token; expired when Primer refuses it", async () => {
  expect(await status()).toMatchObject({ configured: true, state: "ok" });
  expect((await status()).paste).toBeUndefined();
  accept = "primer_pat_other";
  writeFileSync(file, "b".repeat(64)); // a new token (a fresh vault): checked again at once
  expect(await status()).toMatchObject({ state: "expired", detail: expect.stringContaining("restart primer-server") });
});
