// The control plane (Paperclip) admits at most 8 issue-list reads in flight per caller (its actor plus client IP and
// user agent) and answers 429 beyond that. Every owner-key read the kernel makes, its own and the ones it serves the board
// and the modules, is that one caller, so a page that lists many things at once used to see "Too many concurrent
// issue-list requests". The kernel keeps itself under the cap instead: one queue for every owner-key issue list.

const LIST = /^\/api\/companies\/[^/]+\/issues$/;

/** `f` with at most `max` company issue-list GETs in flight; the rest wait their turn in order. */
export function limitIssueLists(f: typeof fetch, max = 6): typeof fetch {
  let busy = 0;
  const waiting: (() => void)[] = [];
  const release = () => {
    const next = waiting.shift();
    if (next) next();
    else busy--;
  };
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    if (method !== "GET" || !LIST.test(url.pathname)) return f(input, init);
    if (busy < max) busy++;
    else await new Promise<void>((r) => waiting.push(r));
    try {
      return await f(input, init);
    } finally {
      release();
    }
  }) as typeof fetch;
}

/** A request header the owner's own typed words carry to the owner-key caller (stripped before the control plane). */
export const TYPED = "x-aidenhq-typed";
/** The marker every other comment written with the owner key carries: code wrote it, so it is never the owner's words. */
export const CODE_MARK = "<!-- aidenhq-code -->";
const COMMENT = /^\/api\/issues\/[^/]+\/comments$/, ISSUE = /^\/api\/issues\/[^/]+$/;

/**
 * `f`, the one owner-key caller, with every comment it writes (a POST of `body` to an issue's comments, a PATCH of an issue
 * with a `comment`) marked CODE_MARK unless the request carries TYPED: owner (the board's compose box and crew instructions,
 * the owner's channel message) or the text already carries an aidenhq marker. Every owner-key write passes here (the
 * kernel's own and the board's, cp.ts createBoardCp), so no code-written comment reads as the owner's (review-loop.ts authorOf).
 */
export function markCode(f: typeof fetch): typeof fetch {
  return (async (input: string | URL | Request, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    const typed = headers.get(TYPED) === "owner";
    headers.delete(TYPED);
    const method = String(init.method ?? "GET").toUpperCase();
    const path = new URL(input instanceof Request ? input.url : input).pathname;
    const field = method === "POST" && COMMENT.test(path) ? "body" : method === "PATCH" && ISSUE.test(path) ? "comment" : undefined;
    let body = init.body;
    if (field && !typed && (typeof body === "string" || body instanceof Uint8Array)) {
      const text = typeof body === "string" ? body : Buffer.from(body).toString("utf8");
      let json: Record<string, unknown> | undefined;
      try { json = JSON.parse(text); } catch { json = undefined; }
      const c = json?.[field];
      if (json && typeof c === "string" && !/<!--\s*aidenhq/.test(c)) body = JSON.stringify({ ...json, [field]: `${c}\n\n${CODE_MARK}` });
    }
    return f(input, { ...init, headers, body });
  }) as typeof fetch;
}
