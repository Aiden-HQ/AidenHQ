// Model credentials the runner mints for the gateway: `ahqj_<payload>.<hmac>`, signed with the secret gateway_job_secret
// (held by the runner and the gateway only). Stateless, so a runner or gateway restart never strands a running job.
// payload: { k: kind (agent | reviewer | grader | source), a: agent id | null, i: task id | null, c: component, x: expiry ms }.
// An Engineer job's token is kind agent (capped); the runner's own calls (reviewer, grader, intake) are system kinds.
import { createHmac, timingSafeEqual } from "node:crypto";

export const JOB_TOKEN_PREFIX = "ahqj_";
const KINDS = new Set(["agent", "reviewer", "grader", "source"]);
const sign = (secret, body) => createHmac("sha256", secret).update(body).digest("base64url");

/** A token for one job or one system call; `ttlMs` past now. */
export function mintToken(secret, { kind = "agent", agentId = null, issueId = null, component, ttlMs = 2 * 3600_000 }, now = Date.now()) {
  if (!secret) throw new Error("the model gateway isn't set up on this host (no gateway_job_secret)");
  if (!KINDS.has(kind)) throw new Error(`not a token kind: ${kind}`);
  const body = Buffer.from(JSON.stringify({ k: kind, a: agentId, i: issueId, c: component ?? null, x: now + ttlMs })).toString("base64url");
  return `${JOB_TOKEN_PREFIX}${body}.${sign(secret, body)}`;
}

/** The payload of a genuine, unexpired token, else undefined. */
export function verifyToken(secret, token, now = Date.now()) {
  if (!secret || typeof token !== "string" || !token.startsWith(JOB_TOKEN_PREFIX)) return undefined;
  const [body, mac] = token.slice(JOB_TOKEN_PREFIX.length).split(".");
  if (!body || !mac) return undefined;
  const want = Buffer.from(sign(secret, body)), got = Buffer.from(mac);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return undefined;
  let p;
  try { p = JSON.parse(Buffer.from(body, "base64url").toString("utf8")); } catch { return undefined; }
  if (!p || !KINDS.has(p.k) || !(p.x > now)) return undefined;
  return p;
}
