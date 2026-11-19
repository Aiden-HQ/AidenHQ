// The board's client of the code-review module's state service (types and the page's checks: reviews.ts).
import type { Profile, ReposView, Review, ReviewerRow, Run } from "./reviews.js";

export class ReviewsUnavailable extends Error {}
export class ReviewsRefused extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export interface Reviews {
  list(q: { repo?: string; status?: string; limit?: number }): Promise<{ runs: Run[] }>;
  get(id: string): Promise<{ run: Run; review: Review | null }>;
  run(body: { pr_url: string; reviewer?: string; focus?: string; full?: boolean }): Promise<{ run: Run }>;
  trial(body: { reviewer: Profile; pr_url: string }): Promise<{ run: Run }>;
  repos(): Promise<ReposView>;
  reviewers(): Promise<{ reviewers: ReviewerRow[] }>;
  /** Repos the GitHub sign-in can read, for the picker (`q` filters by name). */
  available(q: string): Promise<{ repos: { repo: string; private: boolean; pushed_at?: string }[] }>;
  /** Recent open PRs the instance can read, for "Try on a recent PR". */
  recent(): Promise<{ prs: { url: string; repo: string; number: number; title: string }[] }>;
}

/**
 * The service through the kernel (GET|POST /v1/board-api/code-review/<path>, the board's key; the module declares
 * providers.board), so the board needs no network to it. Without the kernel's key the page says the module is off.
 */
export function createReviews({ kernel, fetchFn = fetch }: { kernel?: { url: string; token: string }; fetchFn?: typeof fetch } = {}): Reviews | undefined {
  if (!kernel) return undefined;
  const url = `${kernel.url.replace(/\/+$/, "")}/v1/board-api/code-review`;
  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetchFn(`${url}${path}`, {
      method,
      headers: { authorization: `Bearer ${kernel!.token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    }).catch((e: Error) => {
      throw new ReviewsUnavailable(`the code-review service didn't answer (${e.message})`);
    });
    const data = (await res.json().catch(() => ({}))) as { error?: string; detail?: string };
    // The service's refusals (a PR it can't read, a reviewer whose engine isn't built) reach the owner in its words.
    if (res.status >= 400 && res.status < 500) throw new ReviewsRefused(res.status, String(data.detail ?? data.error ?? `refused (${res.status})`).slice(0, 500));
    if (!res.ok) throw new ReviewsUnavailable(`the code-review service failed (${res.status})`);
    return data as T;
  }
  const qs = (o: Record<string, string | number | undefined>) => {
    const p = new URLSearchParams(Object.entries(o).flatMap(([k, v]) => (v === undefined || v === "" ? [] : [[k, String(v)]])));
    return p.size ? `?${p}` : "";
  };
  return {
    list: (q) => call("GET", `/reviews${qs(q)}`),
    get: (id) => call("GET", `/reviews/${encodeURIComponent(id)}`),
    run: (body) => call("POST", "/reviews", body),
    trial: (body) => call("POST", "/reviews/try", body),
    repos: () => call("GET", "/repos"),
    reviewers: () => call("GET", "/reviewers"),
    available: (q) => call("GET", `/github/repos${qs({ q })}`),
    recent: () => call("GET", "/github/prs"),
  };
}
