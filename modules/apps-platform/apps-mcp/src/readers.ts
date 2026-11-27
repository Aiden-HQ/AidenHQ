// Who may read apps-mcp's internal reads (/internal/sources, /quality, /open-prs): a module's own token that the kernel's
// GET /v1/whoami says is a module holding role apps.read (declared by this module, requested by the Fleet Steward). Never the
// internal token, which deploys. Fails closed: a kernel that can't be asked is a refusal.
import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

export const READ_ROLE = "apps.read";

const bearer = (req: IncomingMessage) => (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
export const bearerIs = (req: IncomingMessage, token: string): boolean => {
  const presented = Buffer.from(bearer(req));
  const expected = Buffer.from(token);
  return presented.length === expected.length && timingSafeEqual(presented, expected);
};

/** The caller's module when it may read, else the status to refuse with (401 unknown, 403 known but not a module holding
 * apps.read). A route that varies what it returns by caller (sources' detail) keys on the verified module here. */
export function appsReaderIdentity(kernelUrl: string, fetchFn: typeof fetch = fetch) {
  return async (req: IncomingMessage): Promise<{ module: string } | 401 | 403> => {
    if (!bearer(req)) return 401;
    const r = await fetchFn(`${kernelUrl}/v1/whoami`, { headers: { authorization: `Bearer ${bearer(req)}` }, signal: AbortSignal.timeout(10_000) }).catch(() => undefined);
    if (!r?.ok) return 401;
    const w = (await r.json().catch(() => ({}))) as { kind?: string; module?: string; roles?: string[] };
    return w.kind === "module" && w.module && (w.roles ?? []).includes(READ_ROLE) ? { module: w.module } : 403;
  };
}

/** 0 when the caller may read, else the status to refuse with. */
export function appsReader(kernelUrl: string, fetchFn: typeof fetch = fetch) {
  const identity = appsReaderIdentity(kernelUrl, fetchFn);
  return async (req: IncomingMessage): Promise<0 | 401 | 403> => {
    const who = await identity(req);
    return typeof who === "number" ? who : 0;
  };
}
