// Test-user sign-in (docs/design/access.md, Test-user sign-in): an agent's own request as the one test identity the owner named
// for a shared app, for end-to-end checks of the person-facing routes a front door would otherwise close to agents.
//
// This is not a bypass. The kernel holds the signing key (identity/test.pem, issuer aidenhq-test); the gate verifies a
// 60-second, single-use token bound to the exact host, app and email, then resolves the account and role exactly as for a
// browser. The owner names the apps (settings.edge.test_user.apps, a Tier 2 apply); the account must exist, be enabled and not
// be an admin; removing the app, disabling the account or deleting the key revokes it. The token is never shown to the agent,
// and each use names the agent and task in its answer and in the gate's log.
import { createHash, createPrivateKey, createPublicKey, randomBytes, sign } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import http from "node:http";

const TTL_S = 60;
const BODY_CAP = 64 * 1024;
const MAX_REQUEST = 256 * 1024;
const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]);
/** Headers a caller may set: what an app legitimately reads from a browser request. */
const HEADERS = new Set(["accept", "referer", "user-agent", "content-type", "x-requested-with"]);

export class TestUserError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) { super(message); this.name = "TestUserError"; this.status = status; this.code = code; }
}

export interface GateTestConfig {
  /** The gate's config (config/gate.json): the test identity and the shared apps' hosts. */
  test_user?: { email?: unknown; apps?: unknown };
  /** The shared apps by name, as readGate() returns them. */
  apps?: Record<string, { host?: unknown }>;
  hosts?: Record<string, { app?: unknown; door?: unknown }>;
}

/** The app host a shared app's person-facing routes are served at, or undefined when the owner hasn't named it for the test user. */
export function appHost(cfg: GateTestConfig | undefined, name: string): string | undefined {
  if (!name || !cfg?.test_user || !Array.isArray(cfg.test_user.apps) || !cfg.test_user.apps.includes(name)) return undefined;
  const known = cfg.apps?.[name]?.host;
  if (typeof known === "string" && known) return known.toLowerCase();
  const hosts = Object.entries(cfg.hosts ?? {}).filter(([, h]) => h?.app === name && h?.door !== true);
  return hosts.length === 1 ? hosts[0]![0].toLowerCase() : undefined;
}

/** The test user's stable, opaque id, the same the gate mints for the email (`subOf` in gate.ts). */
export const subOf = (email: string) => `u_${createHash("sha256").update(`aidenhq-user:${email.trim().toLowerCase()}`).digest("base64url").slice(0, 22)}`;

/** The kernel's test-session signer, from identity/test.pem; re-read when the file changes. `kid` as scripts/identity.ts. */
export function testSigner(file: string) {
  let cached: { key: KeyObject; kid: string } | undefined, mtime = -1;
  return () => {
    const m = statSync(file).mtimeMs;
    if (m !== mtime) {
      const key = createPrivateKey(readFileSync(file, "utf8"));
      const x = createPublicKey(key).export({ format: "jwk" }).x!;
      cached = { key, kid: createHash("sha256").update(Buffer.from(x, "base64url")).digest("base64url").slice(0, 16) };
      mtime = m;
    }
    return cached!;
  };
}

/** The gate's public keys (identity/keys.json), as scripts/identity.ts writes them. */
export const publishedKeys = (file: string): { kid?: string; iss?: string }[] => {
  try { return (JSON.parse(readFileSync(file, "utf8")) as { keys?: { kid?: string; iss?: string }[] }).keys ?? []; } catch { return []; }
};

export interface RunRequest { app: string; method: string; path: string; body?: unknown; headers?: Record<string, unknown> }

/**
 * The kernel's test-user requests. `job` names the live kernel job (its agent and task) from its own token, `gate` reads the
 * compiled gate config, and `send` reaches the gate's loopback listener (a test double in the tests).
 */
export function createTestUser({ job, gate, keyFile, keysFile, gatePort = 3130, now = Date.now, log, send }: {
  job: (token: string) => { agent: string; task: string };
  gate: () => GateTestConfig | undefined;
  /** identity/test.pem (the kernel's signer) and identity/keys.json (the public half the gate mounts), as the vault holds them. */
  keyFile: () => string;
  keysFile: () => string;
  gatePort?: number;
  now?: () => number;
  /** The kernel's log: each use names the agent, the task, the app and the request (never the session token). */
  log?: (o: object) => void;
  send?: (req: { host: string; method: string; path: string; headers: Record<string, string>; body?: string }) => Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }>;
}) {
  /** The gate's listener on 127.0.0.1, with the Host of the app's own host. */
  const post = (req: { host: string; method: string; path: string; headers: Record<string, string>; body?: string }) => new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }>((ok, no) => {
    const r = http.request({ host: "127.0.0.1", port: gatePort, method: req.method, path: req.path, headers: { ...req.headers, host: req.host }, timeout: 30_000 }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (c: Buffer) => { size += c.length; if (size <= BODY_CAP * 2) chunks.push(c); });
      res.on("end", () => ok({ status: res.statusCode ?? 502, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    r.on("timeout", () => r.destroy(new Error("the gate didn't answer within 30 seconds")));
    r.on("error", no);
    if (req.body !== undefined) r.write(req.body);
    r.end();
  });

  const allowed = () => {
    const cfg = gate();
    return { email: typeof cfg?.test_user?.email === "string" ? cfg.test_user.email.trim().toLowerCase() : "", apps: Array.isArray(cfg?.test_user?.apps) ? cfg!.test_user!.apps.map(String) : [], cfg };
  };

  return {
    /** One request as the test user: its status, a few headers and a trimmed body; never the session token. */
    async run(token: string, b: RunRequest) {
      const who = job(token); // throws (JobToolError) for a job that has ended
      const { email, apps, cfg } = allowed();
      const app = String(b?.app ?? "").trim();
      const host = appHost(cfg, app);
      if (!email || !host) throw new TestUserError(403, "not-allowed", `${app || "that app"} isn't one the test user may sign in to (${apps.join(", ") || "none configured"})`);
      const method = String(b?.method ?? "GET").toUpperCase();
      if (!METHODS.has(method)) throw new TestUserError(400, "bad-method", `method must be one of ${[...METHODS].join(", ")}`);
      const path = String(b?.path ?? "/");
      if (!path.startsWith("/") || path.startsWith("//") || /[\u0000-\u001f\u007f\\]/.test(path)) throw new TestUserError(400, "bad-path", "path must be an absolute path on the app, without control characters");
      let body: string | undefined;
      if (b?.body !== undefined) {
        body = typeof b.body === "string" ? b.body : JSON.stringify(b.body);
        if (Buffer.byteLength(body) > MAX_REQUEST) throw new TestUserError(413, "body-too-large", `body must be under ${MAX_REQUEST} bytes`);
      }
      const headers: Record<string, string> = { accept: "application/json", "sec-fetch-site": "same-origin" };
      for (const [k, v] of Object.entries(b?.headers ?? {})) {
        const name = k.toLowerCase();
        if (!HEADERS.has(name)) throw new TestUserError(400, "bad-header", `headers may be ${[...HEADERS].join(", ")} only`);
        if (typeof v !== "string" || /[\u0000-\u001f\u007f]/.test(v)) throw new TestUserError(400, "bad-header", `${name} must be one line of text`);
        headers[name] = v;
      }
      if (body !== undefined) headers["content-type"] ??= "application/json";

      let signer: { key: KeyObject; kid: string };
      try { signer = testSigner(keyFile())(); } catch (e) { throw new TestUserError(503, "key-missing", `the kernel has no test-signing key: run ops/apply-config.sh (${String((e as Error).message)})`); }
      // The gate verifies with the public keys it mounts: without this key among them, every session would be refused.
      if (!publishedKeys(keysFile()).some((k) => k.iss === "aidenhq-test" && k.kid === signer.kid)) throw new TestUserError(503, "key-missing", "the gate has no test-signing key: run the apply that writes identity/keys.json");

      const iat = Math.floor(now() / 1000), jti = randomBytes(16).toString("hex");
      const part = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
      const claims = `${part({ alg: "EdDSA", kid: signer.kid, typ: "JWT" })}.${part({ iss: "aidenhq-test", aud: host, app, sub: subOf(email), email, jti, iat, exp: iat + TTL_S })}`;
      headers["x-aidenhq-test-session"] = `${claims}.${sign(undefined, Buffer.from(claims), signer.key).toString("base64url")}`;
      const answer = await (send ?? post)({ host, method, path, headers, ...(body !== undefined ? { body } : {}) });
      log?.({ msg: "test sign-in", agent: who.agent, task: who.task, app, host, method, path, status: answer.status });
      const keep = ["content-type", "retry-after", "location", "cache-control", "www-authenticate", "allow"];
      const out = Object.fromEntries(keep.flatMap((k) => { const v = answer.headers[k]; return v === undefined ? [] : [[k, v]]; }));
      return { app, host, url: `https://${host}${path}`, status: answer.status, headers: out, body: answer.body.slice(0, BODY_CAP), truncated: answer.body.length > BODY_CAP, by: { agent: who.agent, task: who.task } };
    },
    /** The apps the test user may reach now, for a clear refusal. */
    apps: () => allowed().apps,
  };
}

export type TestUser = ReturnType<typeof createTestUser>;
