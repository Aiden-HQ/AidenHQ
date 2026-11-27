// The board as an OAuth resource server for the owner's own Claude (docs/architecture.md, AidenHQ MCP): /mcp
// takes a bearer only (never the board's cookies), minted by the kernel's authorization server on the admin origin and checked
// there for this resource. Reads believe a checked bearer a few seconds; a write asks again, so a revoke, a disable or a reset
// ends the very next write.
import type { IncomingMessage } from "node:http";
import { forwardedProto, type AccountSession, type KernelAuth } from "./kernel-auth.js";
import { accountSession, type BoardSession } from "./session.js";

const CHECK_MS = 5_000;

/** The board's own origin as the kernel knows it: the first AIDENHQ_BOARD_ORIGINS entry, else BOARD_LAN_URL's, else the loopback board. */
export const boardOrigin = (env: NodeJS.ProcessEnv = process.env) =>
  new URL(env.AIDENHQ_BOARD_ORIGINS?.split(",")[0]?.trim() || env.BOARD_LAN_URL || "http://localhost:3121").origin;

export function createMcpAuth(auth: Pick<KernelAuth, "mcpGrant">, adminUrl: string, board: string = boardOrigin(), now: () => number = Date.now) {
  const checked = new Map<string, { at: number; who: AccountSession; client: string }>();
  /** The origin this request reached the board by (only to tell a foreign page's Origin apart). */
  const origin = (req: Pick<IncomingMessage, "headers">) => `${forwardedProto(req)}://${String(req.headers.host ?? "").toLowerCase()}`;
  const issuer = new URL(adminUrl).origin;
  return {
    origin,
    board,
    /** The audience of this board's tokens: its own /mcp. */
    resource: () => `${board}/mcp`,
    /** RFC 9728: where the client finds the authorization server (the kernel's admin origin is the issuer). */
    metadata: () => ({ resource: `${board}/mcp`, authorization_servers: [issuer], bearer_methods_supported: ["header"] }),
    /** The 401's `WWW-Authenticate`: points an unauthenticated client at the metadata. */
    challenge: (error?: string) => `Bearer resource_metadata="${board}/.well-known/oauth-protected-resource"${error ? `, error="${error}"` : ""}`,
    bearer: (req: Pick<IncomingMessage, "headers">) => /^Bearer (\S{1,2000})$/.exec(String(req.headers.authorization ?? ""))?.[1],
    /** The session behind a bearer for this board's /mcp, or null. `fresh` (every write) skips the few seconds' belief. */
    async check(token: string, fresh: boolean, refused?: (why: string) => void): Promise<{ session: BoardSession; client: string } | null> {
      const resource = `${board}/mcp`;
      const key = `${resource} ${token}`;
      const hit = checked.get(key);
      let who: { who: AccountSession | null; client: string };
      if (!fresh && hit && now() - hit.at < CHECK_MS) who = { who: hit.who, client: hit.client };
      else {
        const g = await auth.mcpGrant(token, resource, refused);
        who = { who: g ? { account: g.account, session: { id: "mcp", expiresAt: g.expires }, ready: true, token } : null, client: g?.client ?? "" };
        if (checked.size > 1000) for (const [k, v] of checked) if (now() - v.at >= CHECK_MS) checked.delete(k);
        if (who.who) checked.set(key, { at: now(), who: who.who, client: who.client });
        else checked.delete(key);
      }
      const session = accountSession(who.who);
      return session ? { session, client: who.client } : null;
    },
  };
}
export type McpAuth = ReturnType<typeof createMcpAuth>;
