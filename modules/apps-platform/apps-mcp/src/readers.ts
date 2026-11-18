// Who may read an app's grading evidence from apps-mcp (/internal/deploys, /internal/view): a module's own token that the
// kernel's GET /v1/whoami says is a module holding role apps.read (declared by this module, requested by grading). Never the
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

/** 0 when the caller may read, else the status to refuse with (401 unknown, 403 known but not a module holding apps.read). */
export function appsReader(kernelUrl: string, fetchFn: typeof fetch = fetch) {
  return async (req: IncomingMessage): Promise<0 | 401 | 403> => {
    if (!bearer(req)) return 401;
    const r = await fetchFn(`${kernelUrl}/v1/whoami`, { headers: { authorization: `Bearer ${bearer(req)}` }, signal: AbortSignal.timeout(10_000) }).catch(() => undefined);
    if (!r?.ok) return 401;
    const w = (await r.json().catch(() => ({}))) as { kind?: string; roles?: string[] };
    return w.kind === "module" && (w.roles ?? []).includes(READ_ROLE) ? 0 : 403;
  };
}
