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
/** A row of the warehouse's `src_github.issues` for a recorded issue or PR, open or not. */
export type WarehouseRow = OpenPr & { kind: string; state: string };
const LIST_LIMIT = 500; // the code host's open-PR list stops here (ops.ts): a number missing from a full list is read on its own

/** A repo this module can't read or that is gone: the kernel's 403/404, or the code host's 502 wrapping GitHub's own 404/410/451 (`GitHub GET /repos/o/r/pulls: 404 Not Found`). */
const notReadable = (err: unknown) => {
  const e = err as { status?: number; message?: string };
  return e.status === 403 || e.status === 404 || /\bGitHub GET \S+: (404|410|451)\b/.test(String(e.message ?? ""));
};

/**
 * The open GitHub PRs among the refs the kernel recorded (issues included): state from the warehouse's row where it has one, else from
 * the code host's list of the repo's open PRs (one call per repo; the warehouse syncs only the configured orgs and lags by up to 15
 * minutes). A recorded PR absent from that list is closed; when the list is full (cut at its limit) each missing PR is read on its own.
 * A repo outside the module's read grant or gone (notReadable) is not looked up; any other failure throws. A PR's repo is GitHub's own
 * spelling (the warehouse row's, or the code host's `nameWithOwner`/`full_name`): the same incident key whichever source answers.
 */
export async function recordedOpenPrs(ours: Recorded[], rows: WarehouseRow[], listOpen: (repo: string) => Promise<{ number: number; draft?: boolean; created_at?: string | null; repo?: string | null }[]>, readPr: (repo: string, number: number) => Promise<{ nameWithOwner?: string | null; state: string; isDraft: boolean; createdAt: string } | null>): Promise<OpenPr[]> {
  const key = (r: Recorded) => `${r.repo.toLowerCase()}#${r.number}`;
  const known = new Set(rows.map(key));
  const missing = new Map<string, Set<number>>();
  for (const o of ours) if (!known.has(key(o))) missing.set(o.repo.toLowerCase(), (missing.get(o.repo.toLowerCase()) ?? new Set()).add(o.number));
  const listed: OpenPr[] = [];
  for (const [repo, numbers] of missing) {
    try {
      const list = await listOpen(repo);
      const found = list.filter((p) => numbers.has(p.number));
      for (const p of found) if (p.created_at) listed.push({ repo: p.repo ?? repo, number: p.number, opened_at: p.created_at, draft: !!p.draft });
      if (list.length < LIST_LIMIT) continue;
      // The list stops at its limit: a recorded PR missing from it may be open past it.
      for (const n of numbers) {
        if (found.some((p) => p.number === n)) continue;
        const pr = await readPr(repo, n);
        if (pr?.state === "OPEN") listed.push({ repo: pr.nameWithOwner ?? repo, number: n, opened_at: pr.createdAt, draft: pr.isDraft });
      }
    } catch (err) {
      if (!notReadable(err)) throw err;
    }
  }
  return [...rows.filter((r) => r.kind === "pr" && r.state === "open").map(({ kind: _k, state: _s, ...r }) => r), ...listed];
}
