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
