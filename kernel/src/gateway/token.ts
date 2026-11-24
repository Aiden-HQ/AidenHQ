// Model credentials the kernel mints for the gateway: `ahqj_<payload>.<hmac>`, signed with the secret gateway_job_secret
// (held by the kernel only). Stateless, so a restart never strands a running job.
// payload: { k: kind (job | reviewer | grader | check), a: agent id | null, i: task id | null, c: component, x: expiry ms, id?: the job }.
// Kind job: a kernel-admitted job's only credential (boxes.ts), id: the job; what it may do is its job row's frozen authority.
// A fast chat lane signs its own turn tokens in this format, kind agent, with gateway_lane_secret (chat-lane model.ts).
import { createHmac, timingSafeEqual } from "node:crypto";

type Brand<T, B extends string> = T & { readonly __brand: B };
/** A token's payload (kind, agent, task, component, expiry). */
export interface TokenPayload { k: string; a: string | null; i: string | null; c: string | null; x: number; id?: string }
/** The payload of a genuine, unexpired token: only verifyToken() makes one, after the HMAC and expiry checks. */
export type VerifiedToken = Brand<TokenPayload, "VerifiedToken">;

export const JOB_TOKEN_PREFIX = "ahqj_";
/** The largest model request the gateway takes, and the most a computer launcher holds of one to send again. */
export const MODEL_BODY_MAX = 32 * 1024 * 1024;
/** What the kernel mints; a verified token may also be a lane's (agent), which only the gateway's lane check accepts. */
const MINTED = new Set(["job", "reviewer", "grader", "check"]);
const KINDS = new Set([...MINTED, "agent"]);
const sign = (secret: string, body: string) => createHmac("sha256", secret).update(body).digest("base64url");

/** A token for one job or one system call; `ttlMs` past now. */
export function mintToken(secret: string, { kind, agentId = null, issueId = null, component, ttlMs = 2 * 3600_000, job }: { kind: string; agentId?: string | null; issueId?: string | null; component?: string | null; ttlMs?: number; job?: string }, now = Date.now()) {
  if (!secret) throw new Error("the model gateway isn't set up on this host (no gateway_job_secret)");
  if (!MINTED.has(kind)) throw new Error(`not a token kind: ${kind}`);
  if ((kind === "job") !== Boolean(job)) throw new Error("a job token names its job, and only a job token does");
  const body = Buffer.from(JSON.stringify({ k: kind, a: agentId, i: issueId, c: component ?? null, x: now + ttlMs, ...(job ? { id: job } : {}) })).toString("base64url");
  return `${JOB_TOKEN_PREFIX}${body}.${sign(secret, body)}`;
}

/** The payload of a genuine, unexpired token, else undefined. */
export function verifyToken(secret: string, token: unknown, now = Date.now()): VerifiedToken | undefined {
  if (!secret || typeof token !== "string" || !token.startsWith(JOB_TOKEN_PREFIX)) return undefined;
  const [body, mac] = token.slice(JOB_TOKEN_PREFIX.length).split(".");
  if (!body || !mac) return undefined;
  const want = Buffer.from(sign(secret, body)), got = Buffer.from(mac);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return undefined;
  let p: TokenPayload | null;
  try { p = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as TokenPayload | null; } catch { return undefined; }
  if (!p || !KINDS.has(p.k) || !(p.x > now)) return undefined;
  return p as VerifiedToken;
}
