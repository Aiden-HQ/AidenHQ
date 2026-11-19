// The board's client of the code-review module's state service (types and the page's checks: reviews.ts).
import { readFileSync } from "node:fs";
import type { Profile, RepoRow, Review, ReviewerRow, Run } from "./reviews.js";

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
  repos(): Promise<{ repos: RepoRow[] }>;
  reviewers(): Promise<{ reviewers: ReviewerRow[] }>;
  /** Repos the GitHub sign-in can read, for the picker (`q` filters by name). */
  available(q: string): Promise<{ repos: { repo: string; private: boolean; pushed_at?: string }[] }>;
  /** Recent open PRs the instance can read, for "Try on a recent PR". */
  recent(): Promise<{ prs: { url: string; repo: string; number: number; title: string }[] }>;
}

/** CODE_REVIEW_URL and CODE_REVIEW_BOARD_KEY_FILE come from the module's board_env; without them the page says the module is off. */
export function createReviews({ url = process.env.CODE_REVIEW_URL, keyFile = process.env.CODE_REVIEW_BOARD_KEY_FILE, fetchFn = fetch }: { url?: string; keyFile?: string; fetchFn?: typeof fetch } = {}): Reviews | undefined {
  if (!url || !keyFile) return undefined;
  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetchFn(`${url!.replace(/\/+$/, "")}${path}`, {
      method,
      headers: { authorization: `Bearer ${readFileSync(keyFile!, "utf8").trim()}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    }).catch((e: Error) => {
      throw new ReviewsUnavailable(`the code-review service didn't answer (${e.message})`);
    });
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    // The service's refusals (a PR it can't read, a reviewer whose engine isn't built) reach the owner in its words.
    if (res.status >= 400 && res.status < 500) throw new ReviewsRefused(res.status, String(data.error ?? `refused (${res.status})`).slice(0, 500));
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
