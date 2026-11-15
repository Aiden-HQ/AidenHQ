// Review requests you already acted on: a task asking you to review a GitHub PR closes itself
// once you've submitted a review after the ask, or the PR was merged or closed.
// Pure functions (unit-tested): the GitHub and Paperclip calls are in main.mjs.

const PR_URL = /https?:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)/g;

/** Distinct GitHub PR links in free text. */
/** A GitHub pull request, by owner, repo and number. */
export interface PrRef {
  owner: string;
  repo: string;
  number: number;
}
/** The Paperclip task fields a review ask is read from. */
interface ReviewIssue {
  title?: string | null;
  description?: string | null;
  createdAt?: string;
}
/** The PR as PR_QUERY returns it. */
export interface ReviewedPr {
  number: number;
  title?: string;
  url: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  merged?: boolean;
  mergedBy?: { login?: string } | null;
  reviews?: { nodes?: { author?: { login?: string } | null; state: string; submittedAt: string }[] };
}

export function prLinks(text: unknown): PrRef[] {
  const found = new Map<string, PrRef>();
  for (const m of String(text ?? "").matchAll(PR_URL)) {
    const pr = { owner: m[1]!, repo: m[2]!, number: Number(m[3]) };
    found.set(`${pr.owner}/${pr.repo}#${pr.number}`.toLowerCase(), pr);
  }
  return [...found.values()];
}

/**
 * The PR a task asks you to review, and when you were asked; undefined for any other task.
 * Either the description has a `PR: <link>` line (Slack Scout writes one for review requests), or
 * the title mentions a review and the task links exactly one PR. The ask time is the Slack message's
 * (from the source marker), else when the task was created.
 */
export function reviewTarget(issue: ReviewIssue | null | undefined): (PrRef & { asked: string | undefined }) | undefined {
  const description = String(issue?.description ?? "");
  const line = /^\s*PR:\s*<?(https?:\/\/github\.com\/\S+?)>?\s*$/im.exec(description);
  const links = prLinks(line ? line[1] : `${issue?.title ?? ""}\n${description}`);
  if (links.length !== 1 || (!line && !/\breview/i.test(issue?.title ?? ""))) return undefined;
  const ts = /<!-- source:(?:source:)?slack:[A-Z0-9]+:(\d{9,11})(?:\.\d+)? -->/.exec(description)?.[1];
  return { ...links[0]!, asked: ts ? new Date(Number(ts) * 1000).toISOString() : issue?.createdAt };
}

const DID: Record<string, string> = { APPROVED: "approved", CHANGES_REQUESTED: "requested changes on", COMMENTED: "reviewed", DISMISSED: "reviewed" };
const day = (t: string) => new Date(t).toISOString().slice(0, 16).replace("T", " ") + " UTC";

/**
 * What to do with the task, given the PR as GitHub's GraphQL API returns it (state, merged,
 * mergedBy, url, reviews { author, state, submittedAt }): undefined while it still needs you.
 */
export function reviewOutcome(pr: ReviewedPr | null | undefined, me: string, asked: string): { status: "done" | "cancelled"; comment: string } | undefined {
  if (!pr) return undefined;
  const link = `[${pr.title ? `#${pr.number} ${pr.title}` : `#${pr.number}`}](${pr.url})`;
  const mine = (pr.reviews?.nodes ?? [])
    .filter((r) => r.author?.login?.toLowerCase() === String(me).toLowerCase() && DID[r.state] && Date.parse(r.submittedAt) >= Date.parse(asked))
    .at(-1);
  if (mine) return { status: "done", comment: `You ${DID[mine.state]} ${link} on GitHub (${day(mine.submittedAt)}), so I closed this.` };
  if (pr.merged) return { status: "done", comment: `${link} was merged${pr.mergedBy?.login ? ` by ${pr.mergedBy.login}` : ""}, so it no longer needs your review. Closed.` };
  if (pr.state === "CLOSED") return { status: "cancelled", comment: `${link} was closed without merging, so it no longer needs your review. Closed.` };
  return undefined;
}

export const PR_QUERY = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      number title url state merged mergedBy { login }
      reviews(last: 50) { nodes { author { login } state submittedAt } }
    }
  }
}`;
