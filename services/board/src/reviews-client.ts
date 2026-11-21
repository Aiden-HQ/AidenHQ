// The board's client of the code-review module's state service (types and the page's checks: reviews.ts).
import type { Catalog, Combo, EngineCatalog, FindingRow, Gate, ReposView, Review, Run, TreeBatch, TreeRequest } from "./reviews.js";

export class ReviewsUnavailable extends Error {}
export class ReviewsRefused extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export interface Reviews {
  /** PR runs, and the whole-repo review batches next to them. */
  list(q: { repo?: string; status?: string; limit?: number }): Promise<{ runs: Run[]; batches?: TreeBatch[] }>;
  /** The options a repo review can run (at a commit, or the default branch's head). */
  catalog(q: { repo: string; commit?: string }): Promise<Catalog>;
  /** A whole-repo review at a commit with the ticked catalog options; one shared cap. */
  runTree(body: TreeRequest): Promise<{ batch: string }>;
  /** A batch's report, as markdown. */
  report(batch: string): Promise<{ markdown: string }>;
  get(id: string): Promise<{ run: Run; review: Review | null; findings: FindingRow[]; gate: Gate | null }>;
  /** The owner dismisses an open finding (it no longer holds the PR's merge). */
  dismiss(body: { repo: string; number: number; id: string; reason: string; by: string }): Promise<{ dismissed: string }>;
  /** One run per combo (the repo's on_open combos when none are given). */
  run(body: { pr_url: string; combos?: Combo[]; focus?: string; full?: boolean }): Promise<{ runs: Run[] }>;
  repos(): Promise<ReposView>;
  engines(): Promise<{ engines: EngineCatalog }>;
  /** Repos the GitHub sign-in can read, for the picker (`q` filters by name). */
  available(q: string): Promise<{ repos: { repo: string; private: boolean; pushed_at?: string }[] }>;
}

/**
 * The service through the kernel (GET|POST /v1/board-api/code-review/<path>, the board's key; the module declares
 * providers.board), so the board needs no network to it. Without the kernel's key the page says the module is off.
 */
export function createReviews({ kernel, fetchFn = fetch }: { kernel?: { url: string; token: string }; fetchFn?: typeof fetch } = {}): Reviews | undefined {
  if (!kernel) return undefined;
  const url = `${kernel.url.replace(/\/+$/, "")}/v1/board-api/code-review`;
  async function send(method: string, path: string, body?: unknown): Promise<Response> {
    const res = await fetchFn(`${url}${path}`, {
      method,
      headers: { authorization: `Bearer ${kernel!.token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    }).catch((e: Error) => {
      throw new ReviewsUnavailable(`the code-review service didn't answer (${e.message})`);
    });
    // The service's refusals (a PR it can't read, an engine that isn't built) reach the owner in its words.
    if (res.status >= 400 && res.status < 500) {
      const data = (await res.json().catch(() => ({}))) as { error?: string; detail?: string };
      throw new ReviewsRefused(res.status, String(data.detail ?? data.error ?? `refused (${res.status})`).slice(0, 500));
    }
    if (!res.ok) throw new ReviewsUnavailable(`the code-review service failed (${res.status})`);
    return res;
  }
  const call = async <T>(method: string, path: string, body?: unknown): Promise<T> => (await send(method, path, body)).json().catch(() => ({})) as Promise<T>;
  const qs = (o: Record<string, string | number | undefined>) => {
    const p = new URLSearchParams(Object.entries(o).flatMap(([k, v]) => (v === undefined || v === "" ? [] : [[k, String(v)]])));
    return p.size ? `?${p}` : "";
  };
  return {
    list: (q) => call("GET", `/reviews${qs(q)}`),
    get: (id) => call("GET", `/reviews/${encodeURIComponent(id)}`),
    catalog: (q) => call("GET", `/catalog${qs(q)}`),
    runTree: (body) => call("POST", "/reviews", body),
    report: async (batch) => ({ markdown: await (await send("GET", `/reviews/${encodeURIComponent(batch)}/report`)).text() }),
    run: (body) => call("POST", "/reviews", body),
    dismiss: (body) => call("POST", "/findings/dismiss", body),
    repos: () => call("GET", "/repos"),
    engines: () => call("GET", "/engines"),
    available: (q) => call("GET", `/github/repos${qs({ q })}`),
  };
}
