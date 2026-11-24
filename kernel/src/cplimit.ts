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

/** The largest answer the kernel reads from the control plane: refused while it streams in, never buffered past this. */
export const MAX_ANSWER = 32 * 1024 * 1024;
export class TooLarge extends Error { status = 502; code = "too_large"; constructor() { super("the control plane's answer is too large"); } }

/** A response's body, read up to `max` bytes: a longer one is cancelled where it stands and refused (TooLarge). */
export async function readCapped(r: Response, max = MAX_ANSWER): Promise<Buffer> {
  if (Number(r.headers.get("content-length") ?? 0) > max) { await r.body?.cancel().catch(() => {}); throw new TooLarge(); }
  if (!r.body) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let n = 0;
  for await (const c of r.body) {
    n += c.length;
    if (n > max) throw new TooLarge(); // leaving the loop cancels the stream
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

// The reads that rarely change (an agent, a company, its agents, labels and projects): kept a few seconds, shared by every
// caller of every shareReads wrapper (each entry keyed by its credential, so one caller never reads another's answer).
const STATIC = [/^\/api\/agents\/[^/]+$/, /^\/api\/companies\/[^/]+$/, /^\/api\/companies\/[^/]+\/(agents|labels|projects)$/];
const STATIC_MS = 15_000;
type Held = { status: number; statusText: string; headers: [string, string][]; body: Buffer };
const statics = new Map<string, { at: number; v: Held }>();
/** Every cached static read goes: a write that may change one (an agent, a label, a project) was made. */
export const forgetStatic = () => statics.clear();

/**
 * `f` with identical GETs shared: one in flight per URL, credential and accept (each caller gets its own copy of the answer),
 * the static reads above kept STATIC_MS (any write to an agent or a company's labels, projects or agents drops them), and
 * every answer read under MAX_ANSWER while it streams. Attachment content passes through untouched.
 */
export function shareReads(f: typeof fetch, now = Date.now): typeof fetch {
  const flying = new Map<string, Promise<Held>>();
  const answer = (h: Held) => new Response(h.status === 204 || h.status === 304 ? null : new Uint8Array(h.body), { status: h.status, statusText: h.statusText, headers: h.headers });
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const method = String(init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    if (method !== "GET") {
      if (/^\/api\/(agents\/|companies\/[^/]+\/(agents|labels|projects)$)/.test(url.pathname)) forgetStatic();
      return f(input, init);
    }
    if (url.pathname.endsWith("/content")) return f(input, init);
    const h = new Headers(init?.headers);
    const key = `${url}\n${h.get("authorization") ?? ""}\n${h.get("accept") ?? ""}`;
    const isStatic = STATIC.some((re) => re.test(url.pathname));
    const hit = isStatic ? statics.get(key) : undefined;
    if (hit && now() - hit.at < STATIC_MS) return answer(hit.v);
    let p = flying.get(key);
    if (!p) {
      p = (async () => {
        const r = await f(input, init);
        return { status: r.status, statusText: r.statusText, headers: [...r.headers], body: await readCapped(r) };
      })();
      flying.set(key, p);
      const mine = p;
      void p.then((v) => { if (isStatic && v.status === 200) { if (statics.size > 1000) statics.clear(); statics.set(key, { at: now(), v }); } }, () => {}).finally(() => { if (flying.get(key) === mine) flying.delete(key); });
    }
    return answer(await p);
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
