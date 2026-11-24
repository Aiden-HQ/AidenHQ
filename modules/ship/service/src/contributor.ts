// The contributor_prs duty (moved from the Maintainer's watcher, lane C): on each maintained repo with `contributor_prs` on,
// `prTick` (at most hourly) reads its open PRs through github-mcp and files a nudge task for a quiet human PR, then a close task
// once it stayed quiet after the nudge (`prDue`); an author's activity in between clears the nudge. The tasks go to the
// Maintainer's role (its handbook's "A nudge task" and "A close task"); ship only decides when they are due.
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
/** The PR pass's one state value (main.ts keeps it in a file). */
export type Kv = { meta(key: string): string | undefined; setMeta(key: string, value: string): void };
type Log = { info(o: object, m: string): void; warn(o: object, m: string): void };

/** One open PR as github-mcp's pr_list reads it (no title or body: they are a stranger's text). */
export interface PrRow {
  number: number;
  author_kind: "bot" | "fleet" | "human";
  draft: boolean;
  last_author_activity: string;
  review_requested: boolean;
  waiting_on_author: string | null;
}
/** Each repo with `contributor_prs` on: its quiet window and its open PRs, or why they couldn't be read. */
export interface MaintainerPrBatch {
  repos: { repo: string; stale_days: number; prs?: PrRow[]; error?: string }[];
}
type Prs = () => Promise<MaintainerPrBatch>;
/** What the Maintainer is asked about one PR: a nudge, or the close that follows a nudge the author never answered. */
export interface PrTask {
  number: number;
  kind: "nudge" | "close";
  /** What waits on the author (a red check, a requested change, a conflict), or null for a draft with nothing asked yet. */
  waiting: string | null;
  /** The date the PR closes if the author stays quiet (the nudge's promise), YYYY-MM-DD. */
  close_by: string;
  /** The author's latest activity: part of the task's source, so a later quiet spell is a new nudge. */
  activity: string;
}
type FirePr = (repo: string, task: PrTask) => Promise<boolean>;
interface Nudge {
  at: string;
  author_activity_at: string;
  /** The close task was filed: it is not filed twice. */
  closed?: true;
}

/**
 * What a quiet PR is due: a human's PR on which the author is the one being waited on (a review asked of someone, or a ready
 * PR with nothing asked of its author, is a maintainer's to answer, not the author's silence). Quiet is no author activity
 * for `staleDays` (a draft: twice that). A nudge is due once; after it, a close once the author stayed quiet for another
 * such spell. Author activity after the nudge clears it (the caller drops the nudge): nothing is due then.
 */
export function prDue(pr: PrRow, nudge: Nudge | undefined, staleDays: number, now: number): "nudge" | "close" | undefined {
  if (pr.author_kind !== "human" || pr.review_requested || (!pr.draft && pr.waiting_on_author === null)) return undefined;
  const window = staleDays * DAY * (pr.draft ? 2 : 1);
  if (!nudge) return now - Date.parse(pr.last_author_activity) >= window ? "nudge" : undefined;
  if (Date.parse(pr.last_author_activity) > Date.parse(nudge.author_activity_at)) return undefined;
  return !nudge.closed && now - Date.parse(nudge.at) >= window ? "close" : undefined;
}

const PR_STATE_KEY = "maintainer_prs";
/** The PR pass runs at most this often: the quiet windows are days, and each human PR costs several GitHub reads. */
const PR_EVERY = 60 * MIN;
interface PrState {
  at?: number;
  repos?: Record<string, { nudged: Record<number, Nudge> }>;
}

/**
 * One look at every repo with `contributor_prs` on (at most hourly): files a nudge or close task for each PR that is due,
 * once, and drops a nudge the author answered or whose PR is gone. A refused filing is retried on the next look. Returns how
 * many tasks were filed.
 */
export async function prTick(d: { prs: Prs; firePr: FirePr; store: Kv; log: Log; now?: number }): Promise<number> {
  const now = d.now ?? Date.now();
  let state: PrState = {};
  try {
    state = JSON.parse(d.store.meta(PR_STATE_KEY) ?? "{}") as PrState;
  } catch {}
  if (state.at && now - state.at < PR_EVERY) return 0;
  let batch: MaintainerPrBatch;
  try {
    batch = await d.prs();
  } catch (err) {
    d.log.warn({ err: String(err instanceof Error ? err.message : err).slice(0, 300) }, "maintainer PRs not read; the next look asks again");
    return 0;
  }
  const repos: NonNullable<PrState["repos"]> = {};
  let count = 0;
  for (const b of batch.repos) {
    const nudged = { ...(state.repos?.[b.repo]?.nudged ?? {}) };
    repos[b.repo] = { nudged };
    if (b.error || !b.prs) {
      d.log.warn({ repo: b.repo, err: b.error ?? "no PRs" }, "maintainer PRs not read for this repo; the next look asks again");
      continue;
    }
    const open = new Set(b.prs.map((p) => p.number));
    for (const n of Object.keys(nudged)) if (!open.has(Number(n))) delete nudged[Number(n)];
    for (const pr of b.prs) {
      const before = nudged[pr.number];
      if (before && Date.parse(pr.last_author_activity) > Date.parse(before.author_activity_at)) delete nudged[pr.number];
      const due = prDue(pr, nudged[pr.number], b.stale_days, now);
      if (!due) continue;
      const window = b.stale_days * DAY * (pr.draft ? 2 : 1);
      const task = { number: pr.number, kind: due, waiting: pr.waiting_on_author, close_by: new Date((due === "nudge" ? now : Date.parse(nudged[pr.number]!.at)) + window).toISOString().slice(0, 10), activity: pr.last_author_activity };
      if (!(await d.firePr(b.repo, task).catch(() => false))) {
        d.log.warn({ repo: b.repo, pr: pr.number, kind: due }, "maintainer PR task not filed; the next look retries it");
        continue;
      }
      nudged[pr.number] = due === "nudge" ? { at: new Date(now).toISOString(), author_activity_at: pr.last_author_activity } : { ...nudged[pr.number]!, closed: true };
      count++;
    }
  }
  d.store.setMeta(PR_STATE_KEY, JSON.stringify({ at: now, repos }));
  return count;
}

/** github-mcp's internal read of each repo's open PRs (the repos with `contributor_prs` on), as this module. */
export function contributorPrs(o: { url: string; token: () => string }): Prs {
  return async () => {
    const res = await fetch(o.url, { headers: { authorization: `Bearer ${o.token()}` }, signal: AbortSignal.timeout(120_000) });
    if (!res.ok) throw new Error(`github-mcp: ${res.status} ${(await res.text()).slice(0, 200)}`);
    return (await res.json()) as MaintainerPrBatch;
  };
}

/**
 * A quiet PR's nudge or close task, for the Maintainer's role: the text names the repo, the PR and the dates only (a PR's title,
 * body and comments are a stranger's words, read by the Maintainer itself). Keyed by source so a PR is never two tasks of one
 * kind for one quiet spell. `file` posts the kernel's POST /v1/tasks (role kernel.tasks) and answers whether it was filed.
 */
export function contributorPrWake(file: (task: { title: string; description: string; role: string; source: string }) => Promise<boolean>): FirePr {
  return (repo, t) => file(t.kind === "nudge"
    ? { role: "maintainer", title: `Maintainer: nudge ${repo}#${t.number}`, description: `${repo}#${t.number}

This pull request's author has been quiet, and what waits on them is: ${t.waiting ?? "nothing is named"}. Nudge it, as "A nudge task" in your instructions says, with the date it closes if they stay quiet: ${t.close_by}.`, source: `maintainer-pr-nudge:${repo}#${t.number}@${t.activity}` }
    : { role: "maintainer", title: `Maintainer: close quiet ${repo}#${t.number}`, description: `${repo}#${t.number}

This pull request was nudged and its author stayed quiet since. Close it, as "A close task" in your instructions says: read its author's activity and review requests again first, and close only if the author is still quiet and no review is waiting.`, source: `maintainer-pr-close:${repo}#${t.number}@${t.activity}` });
}
