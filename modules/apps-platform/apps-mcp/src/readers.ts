// Who may call apps-mcp's /internal/* routes. Writes (a deploy) take only the internal token. Reads (an app's deploys, its
// live view) take it too, or a module's own token that the kernel's GET /v1/whoami says is a module holding role apps.read
// (declared by this module, requested by e.g. grading). Fails closed: a kernel that can't be asked is a refusal.
import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

export const READ_ROLE = "apps.read";

const bearer = (req: IncomingMessage) => (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
export const bearerIs = (req: IncomingMessage, token: string): boolean => {
  const presented = Buffer.from(bearer(req));
  const expected = Buffer.from(token);
  return presented.length === expected.length && timingSafeEqual(presented, expected);
};

/** 0 when the caller may, else the status to refuse with (401 unknown, 403 known but without apps.read). */
export function internalAccess(kernelUrl: string, internalToken: string, fetchFn: typeof fetch = fetch) {
  return async (req: IncomingMessage, access: "read" | "write"): Promise<0 | 401 | 403> => {
    if (bearerIs(req, internalToken)) return 0;
    if (access === "write" || !bearer(req)) return 401;
    const r = await fetchFn(`${kernelUrl}/v1/whoami`, { headers: { authorization: `Bearer ${bearer(req)}` }, signal: AbortSignal.timeout(10_000) }).catch(() => undefined);
    if (!r?.ok) return 401;
    const w = (await r.json().catch(() => ({}))) as { kind?: string; roles?: string[] };
    return w.kind === "module" && (w.roles ?? []).includes(READ_ROLE) ? 0 : 403;
  };
}
