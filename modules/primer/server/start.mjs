// Starts the self-hosted Primer behind AidenHQ's gate. People: AUTH_MODE=proxy trusting only the gate's X-AidenHQ-Identity
// (issuer aidenhq-gate, audience this module's app name, the gate's Ed25519 key from the public keys every shared app gets).
// The connector (primer-mcp): a Primer service token, which Primer resolves before the identity header. The database
// password comes from the vault. Then Primer's own start: migrations, then the server.
import { spawn, spawnSync } from "node:child_process";
import { createPublicKey } from "node:crypto";
import { readFileSync } from "node:fs";

const keys = JSON.parse(readFileSync("/run/secrets/AIDENHQ_IDENTITY_KEYS", "utf8")).keys.filter((k) => k.iss === "aidenhq-gate");
if (keys.length !== 1) throw new Error(`expected the gate's one identity key, found ${keys.length}`);
const { kty, crv, x } = keys[0];
const password = readFileSync(process.env.PRIMER_DB_PASSWORD_FILE, "utf8").trim();
const env = {
  ...process.env,
  AUTH_MODE: "proxy",
  PROXY_AUTH_HEADER: "x-aidenhq-identity",
  PROXY_AUTH_PUBLIC_KEY: createPublicKey({ key: { kty, crv, x }, format: "jwk" }).export({ type: "spki", format: "pem" }).toString(),
  PROXY_AUTH_ISSUER: "aidenhq-gate",
  PROXY_AUTH_AUDIENCE: process.env.AIDENHQ_APP,
  DATABASE_URL: `postgres://primer:${encodeURIComponent(password)}@primer-db:5432/primer`,
};
if (spawnSync("node", ["dist/db/migrate.js"], { env, stdio: "inherit" }).status !== 0) process.exit(1);
const server = spawn("node", ["dist/index.js"], { env, stdio: "inherit" });
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => server.kill(sig));
server.on("exit", (code) => process.exit(code ?? 1));
