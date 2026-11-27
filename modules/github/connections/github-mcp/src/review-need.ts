// What github-mcp's /internal/review/* route answers when its own GitHub call can't serve a post. A need only the owner can
// fix (client.ts GitHubNeed: restricted, expired, sso, scope, not connected) leaves in the kernel's needs_owner shape
// (vendor/needs.ts), so the code-review executor carries it out of this process and the one-off summary can name its one fix.
// A vendor outage or rate limit stays a plain error (never needs_owner: the owner can't fix those). A GitHubRefused, a Zod
// error or malformed JSON is still the request's own 400.
import { z } from "zod";
import { GitHubRefused } from "./github.js";
import { GitHubNeed, needError } from "./client.js";

export type ReviewErrorAnswer = { status: number; body: Record<string, unknown> };

/** The status and body the route sends for an error. */
export function reviewErrorAnswer(err: unknown): ReviewErrorAnswer {
  if (err instanceof GitHubNeed) {
    const n = err.need, detail = err.message.slice(0, 300);
    if (err.ownerFixable) {
      const need = { cause: n.cause, detail, ...(n.cause === "scope" ? { scope: n.scope } : {}), ...(n.cause === "sso" || n.cause === "restricted" ? { org: n.org, url: n.url } : {}) };
      return { status: 502, body: { error: "needs_owner", need } };
    }
    return { status: 502, body: { error: needError(n), detail } };
  }
  const refused = err instanceof GitHubRefused || err instanceof z.ZodError || err instanceof SyntaxError;
  const detail = err instanceof z.ZodError ? err.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") : String((err as Error)?.message ?? err).slice(0, 300);
  return { status: refused ? 400 : 502, body: { error: refused ? "refused" : "github_error", detail } };
}
