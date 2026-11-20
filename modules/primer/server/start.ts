// Starts the self-hosted Primer behind AidenHQ's gate, with nothing for the owner to set up.
// - People: AUTH_MODE=proxy trusting only the gate's X-AidenHQ-Identity (issuer aidenhq-gate, audience this module's app name,
//   the gate's Ed25519 key from the public keys every shared service gets). The address they open (AUTH_BASE_URL, the links
//   Primer makes) is the one compile gives the service: the module door or the share host (AIDENHQ_APP_URL).
// - The connector (primer-mcp): the agent user "AidenHQ agents", acting via the owner, with the token primer_pat_<generated
//   primer_connector_token>. After Primer's migrations this seeds, idempotently on every start, the owner as the gate names
//   them (proxy:<the gate's subOf(owner_email)>, the row Primer's proxy sign-in upserts), that agent user (an existing one is
//   kept, so its documents stay its own) and the token's row (hashed as Primer's auth/tokens.ts does, no scope limit).
// Then the server.
import { spawn, spawnSync } from "node:child_process";
import { createHash, createPublicKey, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const need = (name: string) => process.env[name] || (() => { throw new Error(`${name} is not set: ${name === "AIDENHQ_APP_URL" ? "Primer has no address on this install (with settings.edge, set primer_host)" : "see modules/primer/module.yaml"}`); })();
const keys = JSON.parse(readFileSync("/run/secrets/AIDENHQ_IDENTITY_KEYS", "utf8")).keys.filter((k: { iss: string }) => k.iss === "aidenhq-gate");
if (keys.length !== 1) throw new Error(`expected the gate's one identity key, found ${keys.length}`);
const { kty, crv, x } = keys[0];
const password = readFileSync(need("PRIMER_DB_PASSWORD_FILE"), "utf8").trim();
const env = {
  ...process.env,
  AUTH_MODE: "proxy",
  AUTH_BASE_URL: need("AIDENHQ_APP_URL"),
  PROXY_AUTH_HEADER: "x-aidenhq-identity",
  PROXY_AUTH_PUBLIC_KEY: createPublicKey({ key: { kty, crv, x }, format: "jwk" }).export({ type: "spki", format: "pem" }).toString(),
  PROXY_AUTH_ISSUER: "aidenhq-gate",
  PROXY_AUTH_AUDIENCE: process.env.AIDENHQ_APP,
  DATABASE_URL: `postgres://primer:${encodeURIComponent(password)}@primer-db:5432/primer`,
};
if (spawnSync("node", ["dist/db/migrate.js"], { env, stdio: "inherit" }).status !== 0) process.exit(1);

const AGENT = "AidenHQ agents";
const email = need("OWNER_EMAIL").trim().toLowerCase();
const owner = `proxy:u_${createHash("sha256").update(`aidenhq-user:${email}`).digest("base64url").slice(0, 22)}`; // the gate's subOf
const secret = readFileSync(need("PRIMER_CONNECTOR_TOKEN_FILE"), "utf8").trim();
if (!/^[0-9a-f]{64}$/.test(secret)) throw new Error("primer_connector_token is not a generated token");
const postgres = createRequire("/app/api/package.json")("postgres");
const sql = postgres(env.DATABASE_URL, { max: 1 });
await sql`INSERT INTO users (id, email, display_name) VALUES (${owner}, ${email}, ${process.env.OWNER_NAME || email}) ON CONFLICT (id) DO NOTHING`;
let [agent] = await sql`SELECT id FROM users WHERE kind = 'agent' AND via_user_id = ${owner} AND display_name = ${AGENT} ORDER BY created_at LIMIT 1`;
if (!agent) {
  const id = `agent_${randomUUID()}`;
  [agent] = await sql`INSERT INTO users (id, email, display_name, kind, via_user_id) VALUES (${id}, ${`${id}@agents.primer.invalid`}, ${AGENT}, 'agent', ${owner}) RETURNING id`;
}
const token = `primer_pat_${secret}`;
await sql`INSERT INTO api_tokens (id, user_id, name, token_hash, token_prefix, scopes)
  VALUES (${randomUUID()}, ${agent.id}, 'aidenhq-connector', ${createHash("sha256").update(token, "utf8").digest("hex")}, ${secret.slice(0, 8)}, NULL)
  ON CONFLICT (token_hash) DO NOTHING`;
await sql.end();

const server = spawn("node", ["dist/index.js"], { env, stdio: "inherit" });
for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => server.kill(sig));
server.on("exit", (code) => process.exit(code ?? 1));
