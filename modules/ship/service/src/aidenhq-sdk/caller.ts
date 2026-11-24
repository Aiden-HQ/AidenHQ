// Who a proxied tool call is for: the kernel's signed caller assertion (X-AidenHQ-Caller, an EdDSA JWT, 60 s), checked
// against the kernel's keys (GET /v1/jwks). A module trusts nothing else about the caller: not a header, not an argument.
//
// First-party modules hold byte-identical copies (scripts/sync-shared.ts: edit this one and run it); third-party modules import
// @aidenhq/sdk/caller.
import { createPublicKey, verify, type JsonWebKey } from "node:crypto";
import type { IncomingMessage } from "node:http";

/** The calling agent, as the kernel resolved it. `agent` is its control-plane id, `key` its agent key, `call` the call id. */
export interface Caller { agent: string; key: string; name: string; roles: string[]; task?: string; run?: string; tool: string; call: string; kind: string }
export type JWK = JsonWebKey & { kid?: string };
export type JWKS = { keys: JWK[] };

export const CALLER_HEADER = "x-aidenhq-caller";
const b64 = (s: string) => Buffer.from(s, "base64url");

/** The kernel's keys from `url` (its /v1/jwks), fetched once and again at most once a minute when a key id is unknown. */
export function kernelJwks(url = `${process.env.AIDENHQ_KERNEL_URL ?? "http://10.231.0.1:3130"}/v1/jwks`): () => Promise<JWKS> {
  let cached: JWKS | undefined, at = 0;
  return async () => {
    if (cached && Date.now() - at < 60_000) return cached;
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`the kernel's keys are unavailable (${res.status})`);
    cached = (await res.json()) as JWKS;
    at = Date.now();
    return cached;
  };
}

/** The caller of this request, for module `aud`. Throws on a missing, forged, expired or misaddressed assertion. */
export async function verifyCaller(req: IncomingMessage | { headers: Record<string, unknown> }, jwks: JWKS | (() => Promise<JWKS>), aud: string, now = Date.now()): Promise<Caller> {
  const jwt = String(req.headers[CALLER_HEADER] ?? "");
  const [h, p, s] = jwt.split(".");
  if (!h || !p || !s) throw new Error("no caller assertion");
  let header: { alg?: string; kid?: string }, claims: Record<string, unknown>;
  try {
    header = JSON.parse(b64(h).toString("utf8"));
    claims = JSON.parse(b64(p).toString("utf8"));
  } catch {
    throw new Error("the caller assertion is malformed");
  }
  if (header.alg !== "EdDSA") throw new Error("the caller assertion isn't EdDSA");
  const keys = typeof jwks === "function" ? await jwks() : jwks;
  const jwk = keys.keys.find((k) => !header.kid || k.kid === header.kid);
  if (!jwk) throw new Error("the caller assertion's key is unknown");
  const { kid: _kid, ...material } = jwk;
  if (!verify(null, Buffer.from(`${h}.${p}`), createPublicKey({ key: material, format: "jwk" }), b64(s))) throw new Error("the caller assertion's signature is wrong");
  if (claims.aud !== aud) throw new Error(`the caller assertion is for ${String(claims.aud)}, not ${aud}`);
  if (typeof claims.exp !== "number" || claims.exp * 1000 <= now) throw new Error("the caller assertion has expired");
  const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
  return {
    agent: str(claims.agent) ?? "",
    key: str(claims.key) ?? "",
    name: str(claims.name) ?? str(claims.key) ?? "",
    roles: Array.isArray(claims.roles) ? claims.roles.map(String) : [],
    ...(str(claims.task) ? { task: str(claims.task) } : {}),
    ...(str(claims.run) ? { run: str(claims.run) } : {}),
    tool: str(claims.tool) ?? "",
    call: str(claims.jti) ?? "",
    kind: str(claims.kind) ?? "run",
  };
}
