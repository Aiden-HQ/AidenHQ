// The task's other PRs already merged into this PR's base. The reviewer judges a card against the whole request chain, but
// it sees only this card's diff: when the chain's first half merged as an earlier PR, a follow-up that does not contain it
// was rejected for something no follow-up can contain. A sibling PR is PR text (a branch name, a path), so every name here
// is encoded and the block is fenced as data.
import { findPrs } from "../../../modules/engineering/src/merge-queue.mjs";

/**
 * Percent-encodes every character outside the kind's allowlist, so a PR-controlled name can never emit `<`, `>`,
 * whitespace, a newline or readable prose into the prompt. It is a bijection on UTF-8 bytes, not a list of known-bad
 * characters: paths keep `[A-Za-z0-9._/-]`, branches also `+`, commits `[0-9a-f]`, and everything else becomes `%XX`.
 */
export function encodeName(value: unknown, kind: "path" | "branch" | "commit" = "path") {
  const allowed = { path: /^[A-Za-z0-9._/-]$/, branch: /^[A-Za-z0-9._/+-]$/, commit: /^[0-9a-f]$/ }[kind];
  if (!allowed) throw new Error(`unknown name kind: ${kind}`);
  let out = "";
  for (const ch of String(value ?? "")) {
    if (allowed.test(ch)) out += ch;
    else for (const byte of Buffer.from(ch, "utf8")) out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

/** A task PR already merged into a base; `baseTip` and `after` are filled by siblingsOf. */
export interface Sibling { repo: string; number: number; base: string; mergeCommit: string; mergedAt: string; files: string[] | undefined; baseTip?: string; after?: string[] }

/**
 * One PR as the sibling block sees it, from the canonical PR read (merges.PR_QUERY), or undefined when it isn't merged.
 * Merged-ness is only GitHub's own indicator: `mergedAt`, or REST's `merged: true`. A `state` string is never enough — a
 * REST read of a merged PR is `{state: "closed", merged: true}`, and comparing to "MERGED" silently claims nothing.
 * The merge commit is `mergeCommit.oid`. A paged file list (hasNextPage) is not read: `files` stays undefined.
 */
export function siblingFromPr(pr: any, repo?: unknown): Sibling | undefined {
  if (!pr) return undefined;
  const merged = Boolean(pr.mergedAt) || pr.merged === true;
  if (!merged) return undefined;
  const number = Number(pr.number);
  if (!Number.isInteger(number) || number <= 0) return undefined;
  // No file list, or one GitHub paged: not read (undefined), never an empty list that would read as "the merge changed nothing".
  const files = !pr.files || pr.files.pageInfo?.hasNextPage ? undefined : (pr.files.nodes ?? []).map((f: any) => f?.path).filter((p: unknown) => typeof p === "string");
  return {
    repo: String(repo ?? ""),
    number,
    base: typeof pr.baseRefName === "string" ? pr.baseRefName : "",
    mergeCommit: typeof pr.mergeCommit?.oid === "string" ? pr.mergeCommit.oid : "",
    mergedAt: typeof pr.mergedAt === "string" ? pr.mergedAt : "",
    files,
  };
}

/**
 * Which base a card's siblings are read against. `existing` is whether the branch has a PR at all; `pr` is that PR's
 * canonical read, undefined when the read failed. No PR: the branch opens into the default branch, which is a real base.
 * A PR (or a read that may have missed one): only the base GitHub reports, and empty when it can't be read — falling back
 * to the default branch would attach `main`'s merged siblings to a stacked PR, the guess the own-base filter prevents.
 */
export function cardBase({ existing, pr, defaultBranch }: { existing?: boolean; pr?: any; defaultBranch?: unknown }) {
  if (existing === false) return typeof defaultBranch === "string" ? defaultBranch : "";
  const base = pr?.baseRefName;
  return typeof base === "string" ? base : "";
}

/** The siblings merged into exactly `base`: same repo, GitHub says merged, with a merge commit. No known base, nothing. */
export function mergedSiblings({ prs = [], base, repo }: { prs?: any[]; base?: string; repo?: string } = {}): Sibling[] {
  if (!base) return [];
  return prs
    .map((p) => siblingFromPr(p.pr ?? p, p.repo ?? repo))
    .filter((s) => s && s.base === base && s.mergeCommit && (!repo || !s.repo || s.repo.toLowerCase() === String(repo).toLowerCase())) as Sibling[];
}

/**
 * The sibling's own files that the base changed again after its merge: `sibling.after` is the base's changed paths since
 * `mergeCommit` (undefined when the compare was capped or unread), and `baseTip` is the base branch's tip. `[]` only while
 * the base still sits at that merge commit; anything unread is undefined, which renders as "not read", never "unchanged".
 */
export function changedSinceMerge(sibling: Sibling | null | undefined, baseTip: string | undefined) {
  if (!baseTip || !sibling?.mergeCommit) return undefined;
  if (baseTip === sibling.mergeCommit) return [];
  if (!Array.isArray(sibling.files) || !Array.isArray(sibling.after)) return undefined;
  const after = new Set(sibling.after);
  return sibling.files.filter((f: string) => after.has(f));
}

/** The block's budget: whole entries only, so a long list can never cut an entry in half. */
export const MAX_SIBLING_CHARS = 2_000;

/**
 * Two lines per sibling inside the budget: the PR and its merge commit, then what the base did to its files since. Code's
 * own words are prose; every PR-chosen name is encoded, so the block is safe inside its fence.
 */
export function siblingBlock(siblings: Sibling[] | null | undefined, { max = MAX_SIBLING_CHARS }: { max?: number } = {}) {
  const entries: string[][] = [];
  for (const s of siblings ?? []) entries.push(entry(s, changedSinceMerge(s, s.baseTip)));
  const out: string[] = [];
  let used = 0;
  for (const [i, lines] of entries.entries()) {
    const text = lines.join("\n");
    // Room for the closing count, so what is emitted plus that line still fits.
    if (used + text.length + 2 > max - 120) {
      out.push(`(${entries.length - i} more sibling PR${entries.length - i === 1 ? "" : "s"} not named: over this block's ${max}-character budget)`);
      break;
    }
    used += text.length + 2;
    out.push(text);
  }
  return out.join("\n\n");
}

/** One sibling as its two lines: what merged it, and what the base did to its files since. */
function entry(s: Sibling, changed: string[] | undefined) {
  const base = s.base;
  const ref = `${encodeName(s.repo, "path")}#${s.number}`;
  const into = base ? ` into ${encodeName(base, "branch")}` : "";
  const commit = encodeName(s.mergeCommit.slice(0, 12), "commit");
  const first = `- ${ref} at ${commit}${into}`;
  let second: string;
  if (!Array.isArray(s.files)) second = "  files not read: its file list was paged, so which of them the base still has is unknown";
  else if (!base) second = "  base not read, so what it changed since is not read";
  else if (changed === undefined) second = "  changes on the base since its merge not read";
  else if (!s.files.length) second = "  no files read, so there are none to name";
  else if (!changed.length) second = `  its files unchanged on ${encodeName(base, "branch")} since the merge`;
  else second = `  changed again on ${encodeName(base, "branch")} since: ${changed.map((f: string) => encodeName(f, "path")).join(", ")}`;
  return [first, second];
}

/**
 * The base's files and tip, from a merge commit: `files` is what the base changed between `mergeCommit` and its tip, and
 * undefined when the list is paged (hasNextPage) or the read failed — the renderer then says "not read", never "unchanged".
 * `tip` is the base branch's head, so a base that still sits at the merge commit is known to be unchanged.
 */
export const BASE_FILES_QUERY = `query($owner: String!, $repo: String!, $base: String!, $oid: GitObjectID!) {
  repository(owner: $owner, name: $repo) {
    ref(qualifiedName: $base) { target { oid } }
    object(oid: $oid) { ... on Commit { compare(headRef: $base) { files(first: 100) { pageInfo { hasNextPage } nodes { path } } } } }
  }
}`;

/** BASE_FILES_QUERY's data as { tip, files }, or undefined when the read has nothing usable. */
export function baseFilesSince(data: any): { tip: string; files: string[] | undefined } | undefined {
  const r = data?.repository;
  const tip = r?.ref?.target?.oid;
  if (typeof tip !== "string" || !tip) return undefined;
  const files = r?.object?.compare?.files;
  if (!files) return { tip, files: undefined };
  if (files.pageInfo?.hasNextPage) return { tip, files: undefined };
  return { tip, files: (files.nodes ?? []).map((f: any) => f?.path).filter((p: unknown) => typeof p === "string") };
}

/**
 * The task's other PRs already merged into a given base: `read(repo, number)` is the canonical PR read
 * (merges.PR_QUERY's data), `baseTip(repo, base)` the base branch's head, `filesSince(repo, base, oid)` the files it
 * changed after `oid`. Bases are never guessed: whatever `cardBase` returned is used as it is, and an empty base reads
 * nothing. A failed read of one PR leaves that sibling out rather than inventing its merge state.
 */
export async function siblingsOf({ prs = [], base, repo, read, filesSince }: { prs?: any[]; base?: string; repo?: string; read: (repo: string, number: number) => Promise<any>; filesSince: (repo: string, base: string, oid: string) => Promise<{ tip?: string; files?: string[] } | undefined> }) {
  if (!base) return [];
  const known: { repo: string; pr: any }[] = [];
  for (const p of prs) {
    const number = Number(p.number ?? p);
    if (!Number.isInteger(number) || number <= 0) continue;
    const slug = p.repo ? String(p.repo) : String(repo ?? "");
    if (!slug) continue;
    const data = await read(slug, number).catch(() => undefined);
    // A failed read is left out, never guessed: the sibling is absent rather than assumed merged.
    if (data?.repository?.pullRequest) known.push({ repo: slug, pr: data.repository.pullRequest });
  }
  // One filter for "merged into exactly this base" (mergedSiblings), so the bulk helper and the card can never disagree.
  const out: Sibling[] = [];
  for (const s of mergedSiblings({ prs: known, base, repo })) {
    const files = await filesSince(s.repo, base, s.mergeCommit).catch(() => undefined);
    s.baseTip = files?.tip;
    s.after = files?.files;
    out.push(s);
  }
  return out;
}

/** A branch's PR from `gh pr list --head`: whether it has one at all, and which (the open one, else the newest). */
export function pickBranchPr(list: unknown): { existing: boolean; number?: number } {
  if (!Array.isArray(list)) return { existing: true }; // unread: may exist, so never "no PR"
  const mine = list.map((p) => ({ number: Number(p?.number), state: String(p?.state ?? "") })).filter((p) => Number.isInteger(p.number) && p.number > 0);
  if (!mine.length) return { existing: false };
  const open = mine.filter((p) => p.state === "OPEN").map((p) => p.number);
  return { existing: true, number: open.length ? Math.max(...open) : Math.max(...mine.map((p) => p.number)) };
}

/**
 * The PRs a card may call siblings: every PR named in the task chain's branch records, less the card's own (its branch's PR,
 * or a merge card's PRs). Order is kept, duplicates dropped.
 */
export function siblingCandidates(runs: any[] = [], own = new Set<string>()) {
  const out: { repo: string; number: number }[] = [];
  for (const b of runs) {
    for (const p of findPrs(b?.pr_url ?? "")) {
      const key = `${p.repo.toLowerCase()}#${p.number}`;
      if (own.has(key) || out.some((x) => `${x.repo.toLowerCase()}#${x.number}` === key)) continue;
      out.push(p);
    }
  }
  return out;
}

/** How much of a merged sibling's file list the follow-up note names: whole paths only, so a long merge never floods the prompt. */
export const MAX_SCOPE_FILES = 40;

/**
 * The runner's own grader notes on a task (grade.ts `GRADER_MARKER`), newest last, from its comments. Only a note the runner
 * itself posted is read: Paperclip stores every comment the runner makes (`comment`, `setStatus`) as the runner's own user
 * (`authorType: "user"`, `authorUserId` = the runner's id), and no agent's comment carries that id. A note an agent or a
 * stranger wrote, whatever marker it copies, is not one. `authorUserId` is passed in, so an unread runner id reads nothing.
 */
export function graderNotes(comments: any[] = [], { authorUserId, marker }: { authorUserId?: string; marker: string }) {
  if (!authorUserId) return [];
  return (Array.isArray(comments) ? comments : [])
    .filter((c) => c?.authorType === "user" && String(c.authorUserId ?? "") === String(authorUserId) && String(c.body ?? "").includes(marker))
    .sort((a, b) => String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? "")))
    .map((c) => String(c.body ?? ""));
}

const OUTCOME_LINE = /^\*\*Graded: ([^*]+)\*\*/m;
/** One grader note's outcome as its own words name it: needs_revision (the only one with criteria left to do), satisfied, or another. */
export function gradeOutcome(note: string) {
  const said = OUTCOME_LINE.exec(String(note ?? ""))?.[1]?.trim() ?? "";
  return /^needs revision/i.test(said) ? "needs_revision" : /^done/i.test(said) ? "satisfied" : said ? "other" : "";
}

/**
 * The criteria a grader note names as not met ("- **not met**: …"), each on one line, the grader's own words. `**not
 * shown**` is not read: the grader couldn't check it, which is no instruction to anyone.
 */
export function unmetCriteria(note: string): string[] {
  const out: string[] = [];
  for (const line of String(note ?? "").split("\n")) {
    const m = /^- \*\*not met\*\*: (.+)$/.exec(line.trim());
    const text = m?.[1]?.trim();
    if (text && !out.includes(text)) out.push(text);
  }
  return out;
}

/**
 * What a follow-up's reviewer is told about the work that already merged, appended to the request chain rather than in place of
 * it. Without it the reviewer saw the whole request and a diff that cannot hold its earlier half, and read that half as missing:
 * the merged-PR table names a sibling's files only when the base changed them again, so a merge nothing else touched named none.
 * Two parts, both in code's words: the merged part (a PR is named only when GitHub says it merged into this base, with its merge
 * commit and the files it changed, each read as a path, so the work is recognisable), and the criteria the task's grader named
 * as still unmet when it sent the work back (its words, as data). The chain stays whole: a rubric holds a few checkable criteria
 * (grading's own rule), not every requirement the request states, so narrowing to them would leave the rest unchecked. Plain
 * text, because it goes inside the reviewer's own REQUEST_CHAIN fence, which neutralises any marker text it holds. Empty when
 * nothing proves the merged part: no sibling in this base, or no path to name.
 */
export function followUpNote({ siblings = [], criteria = [], base }: { siblings?: Sibling[]; criteria?: string[]; base?: string }) {
  const proved = (siblings ?? []).filter((s) => s.mergeCommit && base && s.base && s.base.toLowerCase() === String(base).toLowerCase() && Array.isArray(s.files));
  if (!base || !proved.length) return "";
  const named = proved.filter((s) => s.files!.length).flatMap((s) => s.files!);
  if (!named.length) return "";
  const lines: string[] = [];
  let left = MAX_SCOPE_FILES;
  for (const s of proved) {
    if (!s.files!.length) continue;
    const take = s.files!.slice(0, left);
    const more = s.files!.length - take.length;
    if (take.length) lines.push(`- ${encodeName(s.repo, "path")}#${s.number} at ${encodeName(s.mergeCommit.slice(0, 12), "commit")}, merged into ${encodeName(base, "branch")}: ${take.map((f) => encodeName(f, "path")).join(", ")}${more > 0 ? ` (${more} more not named)` : ""}`);
    left -= take.length;
    if (left <= 0) break;
  }
  const merged = `Parts of this request are already on ${encodeName(base, "branch")} from these merged pull requests, with the files each one changed. That work is done, and it is not missing from this diff:\n${lines.join("\n")}`;
  if (!(criteria ?? []).length) return merged;
  // The grader's own words, one line each: a newline inside a criterion becomes a space, so a criterion can never read as a
  // line of this block's own (numbered, at the start of a line).
  const grader = `The task's grader named these criteria as not met when it sent the work back, one per line (the grader's words; the rest of the request is not narrowed to them):\n${criteria.map((c, i) => `${i + 1}. ${String(c).replace(/\s*\n\s*/g, " ").trim()}`).join("\n")}`;
  return `${merged}\n\n${grader}`;
}
