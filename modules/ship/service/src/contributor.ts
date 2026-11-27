// The quiet_pr_days duty (a field of a repo's ship entry): on each repo whose entry sets it, `prTick` (at most hourly) reads its
// open PRs through github-mcp and nudges a quiet human PR, then closes it once it stayed quiet after the nudge (`prDue`); an
// author's activity in between clears the nudge. Ship posts both itself (contributorPrAct), in fixed words.
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
/** Each repo with `quiet_pr_days` set: its quiet window and its open PRs, or why they couldn't be read. */
export interface MaintainerPrBatch {
  repos: { repo: string; quiet_pr_days: number; prs?: PrRow[]; error?: string }[];
}
type Prs = () => Promise<MaintainerPrBatch>;
/** What is due on one PR: a nudge, or the close that follows a nudge the author never answered. */
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
  /** The date the nudge promised the PR closes (a draft's window at the time it was posted), so a later change to the repo's
   * `quiet_pr_days` never moves a deadline the author was told. */
  close_at?: string;
  /** The close task was filed: it is not filed twice. */
  closed?: true;
}

/**
 * What a quiet PR is due: a human's PR on which the author is the one being waited on (a review asked of someone, or a ready
 * PR with nothing asked of its author, is a maintainer's to answer, not the author's silence). Quiet is no author activity
 * for `staleDays` (a draft: twice that). A nudge is due once; after it, a close at the deadline the nudge itself carried
 * (`close_at`), not one recomputed from today's setting, so lowering `quiet_pr_days` never closes a PR before the date the
 * author was told. A nudge from before `close_at` was recorded falls back to `at` plus the current window. Author activity
 * after the nudge clears it (the caller drops the nudge): nothing is due then.
 */
export function prDue(pr: PrRow, nudge: Nudge | undefined, staleDays: number, now: number): "nudge" | "close" | undefined {
  if (pr.author_kind !== "human" || pr.review_requested || (!pr.draft && pr.waiting_on_author === null)) return undefined;
  const window = staleDays * DAY * (pr.draft ? 2 : 1);
  if (!nudge) return now - Date.parse(pr.last_author_activity) >= window ? "nudge" : undefined;
  if (Date.parse(pr.last_author_activity) > Date.parse(nudge.author_activity_at)) return undefined;
  const closes = nudge.close_at ? Date.parse(nudge.close_at) : Date.parse(nudge.at) + window;
  return !nudge.closed && now >= closes ? "close" : undefined;
}

/** The date a nudge filed now promises the PR closes: the window in force when it is posted. */
export const nudgeDeadline = (now: number, staleDays: number, draft: boolean) => now + staleDays * DAY * (draft ? 2 : 1);

const PR_STATE_KEY = "maintainer_prs";
/** The PR pass runs at most this often: the quiet windows are days, and each human PR costs several GitHub reads. */
const PR_EVERY = 60 * MIN;
interface PrState {
  at?: number;
  repos?: Record<string, { nudged: Record<number, Nudge> }>;
}

/**
 * One look at every repo with `quiet_pr_days` set (at most hourly): files a nudge or close task for each PR that is due,
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
      const due = prDue(pr, nudged[pr.number], b.quiet_pr_days, now);
      if (!due) continue;
      const deadline = due === "nudge" ? nudgeDeadline(now, b.quiet_pr_days, pr.draft) : Date.parse(nudged[pr.number]!.close_at ?? "") || Date.parse(nudged[pr.number]!.at) + b.quiet_pr_days * DAY * (pr.draft ? 2 : 1);
      const task = { number: pr.number, kind: due, waiting: pr.waiting_on_author, close_by: new Date(deadline).toISOString().slice(0, 10), activity: pr.last_author_activity };
      if (!(await d.firePr(b.repo, task).catch(() => false))) {
        d.log.warn({ repo: b.repo, pr: pr.number, kind: due }, "maintainer PR task not filed; the next look retries it");
        continue;
      }
      nudged[pr.number] = due === "nudge" ? { at: new Date(now).toISOString(), author_activity_at: pr.last_author_activity, close_at: new Date(deadline).toISOString() } : { ...nudged[pr.number]!, closed: true };
      count++;
    }
  }
  d.store.setMeta(PR_STATE_KEY, JSON.stringify({ at: now, repos }));
  return count;
}

/** github-mcp's internal read of each repo's open PRs (Ship's entries with `quiet_pr_days` set, which `repos` names), as this module. */
export function contributorPrs(o: { url: string; token: () => string; repos: () => { repo: string; quiet_pr_days: number }[] }): Prs {
  return async () => {
    const repos = o.repos();
    if (!repos.length) return { repos: [] };
    const res = await fetch(o.url, { method: "POST", headers: { authorization: `Bearer ${o.token()}`, "content-type": "application/json" }, body: JSON.stringify({ repos }), signal: AbortSignal.timeout(120_000) });
    if (!res.ok) throw new Error(`github-mcp: ${res.status} ${(await res.text()).slice(0, 200)}`);
    return (await res.json()) as MaintainerPrBatch;
  };
}

/** The nudge's words: fixed text naming only what waits and the date (a PR's title, body and comments are a stranger's words). */
export const nudgeText = (t: PrTask) => `This pull request is waiting on its author: ${t.waiting ?? "it is still a draft"}. Still working on this? Push or reply by ${t.close_by} to keep it open.`;
export const closeText = (repo: string) => `Closed for inactivity. Reopen it if you pick it back up. If the change is still wanted, [file an issue](https://github.com/${repo}/issues/new) describing it.`;

/**
 * Ship's own nudge and close of a quiet PR, as the owner through github's ship routes (the comment and the close those routes
 * allow on the repos ship covers): a nudge is one comment; a close is a comment, then the PR closed. Answers whether it was done.
 */
export function contributorPrAct(o: { comment: (repo: string, n: number, text: string) => Promise<boolean>; close: (repo: string, n: number) => Promise<boolean> }): FirePr {
  return async (repo, t) => t.kind === "nudge" ? o.comment(repo, t.number, nudgeText(t)) : (await o.comment(repo, t.number, closeText(repo))) && o.close(repo, t.number);
}
