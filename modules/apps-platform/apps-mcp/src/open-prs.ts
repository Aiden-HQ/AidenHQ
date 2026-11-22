/** One open PR in the rows the Fleet Steward's `pr` check reads; `ready_at` is when a draft was last marked ready, where the warehouse saw it. */
export type OpenPr = { repo: string; number: number; opened_at: string; draft: boolean; ready_at?: string | null; preview_url?: string };

/**
 * The open PRs the fleet opened: this server's own change requests, and the GitHub ones the kernel's records name (any repo). The two
 * are read independently: a failed GitHub read still returns the local rows, marked `github_error` so the detector keeps its open
 * GitHub incidents open instead of reporting them recovered. A PR made by hand has no record and is never listed.
 */
export async function openPrs(local: () => Promise<OpenPr[]>, github: () => Promise<OpenPr[]>, warn: (err: unknown) => void, deadlineMs = 10_000): Promise<{ prs: OpenPr[]; github_error?: true }> {
  const own = await local();
  try {
    // The caller gives up after 20 s: the GitHub read answers within its own deadline so the local rows still go back.
    const late = new Promise<never>((_, no) => setTimeout(() => no(new Error(`the GitHub read took over ${deadlineMs} ms`)), deadlineMs).unref());
    return { prs: [...(await Promise.race([github(), late])), ...own] };
  } catch (err) {
    warn(err);
    return { prs: own, github_error: true };
  }
}

type Recorded = { repo: string; number: number };
/** A row of the warehouse's `src_github.issues` for a recorded PR, open or not. */
export type WarehousePr = OpenPr & { state: string };

/**
 * The open GitHub PRs among the ones the kernel recorded: state from the warehouse's row where it has one, else from the code host's
 * list of the repo's open PRs (one call per repo; the warehouse syncs only the configured orgs, and lags by up to 15 minutes). A PR
 * absent from that list is closed. The caller's own deadline covers every call.
 */
export async function recordedOpenPrs(ours: Recorded[], rows: WarehousePr[], listOpen: (repo: string) => Promise<{ number: number; draft?: boolean; created_at?: string | null }[]>): Promise<OpenPr[]> {
  const key = (r: Recorded) => `${r.repo.toLowerCase()}#${r.number}`;
  const known = new Set(rows.map(key));
  const missing = new Map<string, Set<number>>();
  for (const o of ours) if (!known.has(key(o))) missing.set(o.repo, (missing.get(o.repo) ?? new Set()).add(o.number));
  const listed: OpenPr[] = [];
  for (const [repo, numbers] of missing)
    for (const p of await listOpen(repo)) if (numbers.has(p.number) && p.created_at) listed.push({ repo, number: p.number, opened_at: p.created_at, draft: !!p.draft });
  return [...rows.filter((r) => r.state === "open").map(({ state: _state, ...r }) => r), ...listed];
}
