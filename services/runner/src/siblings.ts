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
  return criteriaWhere(note, "**not met**");
}

/**
 * The criteria a grader note marks met ("- met: …"), each the grader's own words followed by the evidence it relied on.
 * This is the only thing that ties the merged work to a requirement: a merged PR's file list says where that work is, never
 * which requirement it satisfied.
 */
export function metCriteria(note: string): string[] {
  return criteriaWhere(note, "met");
}

/** The grader note's own footer line (grade.ts `gradeNote`): `_Grader: <model>; version <v>. The grader's words, not the owner's._` */
const GRADER_VERSION = /^_Grader:[^;\n]*; version (.*?)\. The grader's words, not the owner's\._$/m;

/** A revision a grader note says it graded: one PR at one commit. */
export interface GradedRevision { repo: string; number: number; sha: string }

/**
 * The revisions a grader note says it graded, from the version in its footer: the PR evidence binds one `repo#n@<sha>+<hash>`
 * per graded PR it read (evidence.ts `prEvidence`), `<sha>` being the merge commit of a merged PR and the head of an open one
 * (a deployed app appends its own sha, which is dropped here). So this is what ties the note's verdicts to a specific
 * revision: a criterion was marked there, on that commit, and nowhere else. The sha is a full 40-hex commit, as GitHub's own
 * read gives it: a short prefix names no single commit, so it is not read at all. A version that is a digest (`prs:<hash>`,
 * several PRs bound), or one the note cut short, reads as no revision and ties nothing.
 */
export function gradedRevisions(note: string): GradedRevision[] {
  const version = GRADER_VERSION.exec(String(note ?? ""))?.[1] ?? "";
  const out: GradedRevision[] = [];
  for (const token of version.trim().split(/\s+/)) {
    const m = /^(.+)#(\d+)@([0-9a-f]{40})(?:\+[0-9a-f]*)*$/.exec(token);
    const repo = m?.[1], number = Number(m?.[2]), sha = m?.[3];
    if (!repo || !sha || !Number.isInteger(number) || out.some((r) => r.repo === repo && r.number === number && r.sha === sha)) continue;
    out.push({ repo, number, sha });
  }
  return out;
}

/** One grader note's `- <label>: …` lines, each on a single line and once, in the grader's words. */
function criteriaWhere(note: string, label: string) {
  const out: string[] = [];
  const wanted = `- ${label}: `;
  for (const line of String(note ?? "").split("\n")) {
    const text = line.trim();
    if (!text.startsWith(wanted)) continue;
    const criterion = text.slice(wanted.length).trim();
    if (criterion && !out.includes(criterion)) out.push(criterion);
  }
  return out;
}

/**
 * What a follow-up's reviewer is told about the work that already merged, appended to the request chain rather than in place of
 * it. Without it the reviewer saw the whole request and a diff that cannot hold its earlier half, and read that half as missing:
 * the merged-PR table names a sibling's files only when the base changed them again, so a merge nothing else touched named none.
 *
 * What ties a merged change to a requirement is the task's grader, not the change's file list: a path says where work sits,
 * never which criterion it met. So this note carries both, and claims only what each supports:
 * - the merged PRs (GitHub says merged into this base, with a merge commit and an unpaged file list), named for where the
 *   work is and explicitly not for what it did;
 * - the grader's own verdicts on the work as it stood when it was sent back, which are the evidence: the criteria it marked
 *   met, with the evidence it relied on, and the ones it marked still unmet, which this change owes.
 *
 * Those verdicts are also what lets the note narrow the scope, which is the point of it: the met criteria are the account for
 * the requirements being taken as given, so the change is judged against what remains unmet rather than against work already
 * verified on the base. A verdict settles only the revision it was read on, which the note's own version names
 * (gradedRevisions): the criteria are claimed for a sibling only when the grader read that PR at that sibling's merge commit,
 * so a verdict about an earlier or a different commit never excuses work the merge does not hold. A rubric holds a few
 * checkable criteria, not every requirement a request states, so a requirement the grader never assessed is not settled by
 * it and stays owed: the note says so in as many words, and the whole request stays above it as context. With no `met`
 * verdict nothing ties the merge to any requirement, so nothing is claimed and the note is empty: the reviewer then judges the
 * whole chain as before.
 *
 * Plain text, and no fence delimiter in it: the block goes inside the reviewer's own REQUEST_CHAIN fence, and the grader's
 * words are the text a stranger most likely wrote (`- met: …` lines come from a model reading the task). Every `<<<`/`>>>`
 * they hold is encoded to `%3C%3C%3C`/`%3E%3E%3E` by `quoted` before it is numbered, so the block cannot close that fence
 * early or open another one whether or not the fence itself also rewrites them: the reviewer reads one chain, not a second
 * block of the author's making.
 */
export function followUpNote({ siblings = [], criteria = [], met = [], revisions = [], base }: { siblings?: Sibling[]; criteria?: string[]; met?: string[]; revisions?: GradedRevision[]; base?: string }) {
  // A sibling whose merge commit the grader's note names: GitHub's merge read back off the base, and the revision the verdicts
  // were read on. Either one missing and nothing is claimed for that PR.
  const graded = (s: Sibling) =>
    (revisions ?? []).some((r) => r.number === s.number && r.repo.toLowerCase() === s.repo.toLowerCase() && r.sha.length === 40 && s.mergeCommit.toLowerCase() === r.sha.toLowerCase());
  const proved = (siblings ?? []).filter((s) => s.mergeCommit && base && s.base && s.base.toLowerCase() === String(base).toLowerCase() && Array.isArray(s.files) && graded(s));
  if (!base || !proved.length) return "";
  const named = proved.filter((s) => s.files!.length).flatMap((s) => s.files!);
  if (!named.length) return "";
  // The grader's verdicts are the tie between the merged work and the request; with none there is no claim to make.
  const metLines = oneLine(met);
  if (!metLines.length) return "";
  const owedLines = oneLine(criteria);
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
  const merged = `Parts of this request are already on ${encodeName(base, "branch")}, from these merged pull requests. The files named are where that work is, which is not by itself what it satisfied:\n${lines.join("\n")}`;
  const at = proved.filter((s) => s.files!.length).map((s) => `${encodeName(s.repo, "path")}#${s.number} at ${encodeName(s.mergeCommit.slice(0, 12), "commit")}`).join(" and ");
  const satisfied = `The task's grader read that work at ${at}, the merged revision named above and not an earlier one, and marked these met at that revision, giving the evidence it relied on (the grader's words):\n${numbered(metLines)}`;
  const out = [merged, satisfied];
  // The narrowing, and what justifies it: the met verdicts are the account for the requirements being set aside, so this
  // change is judged against what the grader marked still unmet, not against work it has already verified. A requirement the
  // rubric never assessed is not settled by the note, and the whole request stays above it as context either way.
  if (!owedLines.length) {
    out.push("The whole request above is what this change is judged against: the grader named no criterion still unmet, so none is settled here.");
    return out.join("\n\n");
  }
  out.push(`It marked these still not met, and they are what this change owes (the grader's words):\n${numbered(owedLines)}`);
  out.push("So what this change owes is two things: the criteria the grader marked still unmet, above, and every requirement of the request above that the grader's rubric never assessed, which this note does not settle either way. Only the criteria it marked met are settled by the merged work, and those are not expected in this diff again.");
  return out.join("\n\n");
}

/**
 * Grader words, one numbered line each: a newline inside one becomes a space, so it can never start a line this block did not
 * number, and every `<` and `>` becomes its percent-encoded byte, so a criterion quoting `<<<REQUEST_CHAIN` cannot close the
 * reviewer's fence or open another one — no delimiter of any length can form. `%` is encoded first, so an encoded delimiter
 * can never read back as a raw one.
 */
const oneLine = (xs: string[]) => [
  ...new Set(
    (xs ?? [])
      .map((c) =>
        String(c ?? "")
          .replace(/\s*\n\s*/g, " ") // one numbered line per criterion, whatever the grader wrote
          .replace(/%/g, "%25") // the escape's own byte first, so an encoded delimiter can never be mistaken for a raw one
          .replace(/</g, "%3C")
          .replace(/>/g, "%3E") // no delimiter of any length can form, so this block can neither close nor open a fence
          .trim(),
      )
      .filter(Boolean),
  ),
];
const numbered = (xs: string[]) => xs.map((c, i) => `${i + 1}. ${c}`).join("\n");
