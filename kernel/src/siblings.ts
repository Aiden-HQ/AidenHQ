// The task's other PRs already merged into this change's base, as the AI reviewer reads them (reviewer@1 `siblings`), and a
// follow-up's note on them appended to the request chain (the old runner's siblings.ts, 03ecfcda4^). The code host's plan reads
// the rows (modules/github/service/src/siblings.mjs: GitHub's own merge, the base's files since) and the record keeps them
// (records.context.siblings); this renders them. Every PR-chosen name is encoded, so the blocks are safe inside their fences.

/** A task PR merged into the change's base: `files` its own (undefined: not read), `changed` those the base changed again since (undefined: not read). */
export type Sibling = { repo: string; number: number; base: string; mergeCommit: string; files?: string[]; changed?: string[] };

/** The grading module's marker on its notes (modules/grading grader/evidence.ts GRADER_MARKER). */
export const GRADER_MARKER = "<!-- aidenhq:grader -->";

/**
 * Percent-encodes every character outside the kind's allowlist, so a PR-controlled name can never emit `<`, `>`, whitespace,
 * a newline or readable prose into the prompt: paths keep `[A-Za-z0-9._/-]`, branches also `+`, commits `[0-9a-f]`.
 */
export function encodeName(value: unknown, kind: "path" | "branch" | "commit" = "path") {
  const allowed = { path: /^[A-Za-z0-9._/-]$/, branch: /^[A-Za-z0-9._/+-]$/, commit: /^[0-9a-f]$/ }[kind];
  let out = "";
  for (const ch of String(value ?? "")) {
    if (allowed.test(ch)) out += ch;
    else for (const byte of Buffer.from(ch, "utf8")) out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

/** The block's budget (the reviewer's MAX_SIBLINGS): whole entries only. */
export const MAX_SIBLING_CHARS = 2_000;

/** Two lines per sibling inside the budget: the PR and its merge commit, then what the base did to its files since. */
export function siblingBlock(siblings: Sibling[] = [], max = MAX_SIBLING_CHARS) {
  const out: string[] = [];
  let used = 0;
  for (const [i, s] of siblings.entries()) {
    const text = entry(s);
    if (used + text.length + 2 > max - 120) {
      const left = siblings.length - i;
      out.push(`(${left} more sibling PR${left === 1 ? "" : "s"} not named: over this block's ${max}-character budget)`);
      break;
    }
    used += text.length + 2;
    out.push(text);
  }
  return out.join("\n\n");
}

function entry(s: Sibling) {
  const base = encodeName(s.base, "branch");
  const first = `- ${encodeName(s.repo, "path")}#${s.number} at ${encodeName(s.mergeCommit.slice(0, 12), "commit")} into ${base}`;
  let second: string;
  if (!Array.isArray(s.files)) second = "  files not read, so which of them the base still has is unknown";
  else if (!Array.isArray(s.changed)) second = "  changes on the base since its merge not read";
  else if (!s.files.length) second = "  no files read, so there are none to name";
  else if (!s.changed.length) second = `  its files unchanged on ${base} since the merge`;
  else second = `  changed again on ${base} since: ${s.changed.map((f) => encodeName(f, "path")).join(", ")}`;
  return `${first}\n${second}`;
}

/**
 * The grader's notes on a task, oldest first: only those the kernel posted (the board key's user, `owner`, which is how the
 * grading module's verdict reaches the task through /v1/checks) carrying its marker. An agent's comment is never one.
 */
export function graderNotes(comments: { body?: string | null; authorType?: string; authorUserId?: string | null; createdAt?: string }[], owner: string) {
  if (!owner) return [];
  return comments
    .filter((c) => c.authorType === "user" && c.authorUserId === owner && String(c.body ?? "").includes(GRADER_MARKER))
    .sort((a, b) => String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? "")))
    .map((c) => String(c.body ?? ""));
}

/** Whether a grader note sent the work back (its own `**Graded: needs revision.**` line). */
export const sentBack = (note: string) => /^\*\*Graded: needs revision/im.test(note);

/** A grader note's `- <label>: …` lines, once each, in the grader's words (`**not met**` or `met`). */
function criteria(note: string, label: string) {
  const out: string[] = [];
  for (const line of note.split("\n")) {
    const text = line.trim();
    if (!text.startsWith(`- ${label}: `)) continue;
    const c = text.slice(label.length + 4).trim();
    if (c && !out.includes(c)) out.push(c);
  }
  return out;
}

/**
 * The revisions a grader note graded, from its footer's version (`repo#n@<40-hex sha>+<hash>` per PR, grading evidence.ts
 * prEvidence): a criterion was marked on that commit and nowhere else. A digest version (`prs:<hash>`) ties nothing.
 */
export function gradedRevisions(note: string) {
  const version = /^_Grader:[^;\n]*; version (.*?)\. The grader's words, not the owner's\._$/m.exec(note)?.[1] ?? "";
  const out: { repo: string; number: number; sha: string }[] = [];
  for (const token of version.trim().split(/\s+/)) {
    const m = /^(.+)#(\d+)@([0-9a-f]{40})(?:\+[0-9a-f]*)*$/.exec(token);
    if (m) out.push({ repo: m[1]!, number: Number(m[2]), sha: m[3]! });
  }
  return out;
}

/** Grader words, one numbered line each, `%`, `<` and `>` encoded so no fence delimiter can form. */
const oneLine = (xs: string[]) => [...new Set(xs.map((c) => c.replace(/\s*\n\s*/g, " ").replace(/%/g, "%25").replace(/</g, "%3C").replace(/>/g, "%3E").trim()).filter(Boolean))];
const numbered = (xs: string[]) => xs.map((c, i) => `${i + 1}. ${c}`).join("\n");
/** How many of a merged sibling's files the note names. */
const MAX_SCOPE_FILES = 40;

/**
 * What a follow-up's reviewer is told about the work already merged, appended to the request chain. Only from the grader note
 * that sent this version back, and only for a sibling the grader read at its merge commit: the criteria it marked met there
 * are settled by the merge, the ones still unmet are what this change owes, and anything the rubric never assessed stays owed.
 * With no such sibling or no met criterion, nothing is claimed and the note is empty.
 */
export function followUpNote(siblings: Sibling[], note: string, base: string) {
  if (!base || !sentBack(note)) return "";
  const revisions = gradedRevisions(note);
  const proved = siblings.filter((s) => s.base === base && Array.isArray(s.files) && s.files.length && revisions.some((r) => r.number === s.number && r.repo.toLowerCase() === s.repo.toLowerCase() && r.sha === s.mergeCommit.toLowerCase()));
  const met = oneLine(criteria(note, "met"));
  if (!proved.length || !met.length) return "";
  const owed = oneLine(criteria(note, "**not met**"));
  const b = encodeName(base, "branch");
  const at = (s: Sibling) => `${encodeName(s.repo, "path")}#${s.number} at ${encodeName(s.mergeCommit.slice(0, 12), "commit")}`;
  let left = MAX_SCOPE_FILES;
  const lines: string[] = [];
  for (const s of proved) {
    if (left <= 0) break;
    const take = s.files!.slice(0, left);
    left -= take.length;
    const more = s.files!.length - take.length;
    lines.push(`- ${at(s)}, merged into ${b}: ${take.map((f) => encodeName(f, "path")).join(", ")}${more > 0 ? ` (${more} more not named)` : ""}`);
  }
  const out = [
    `Parts of this request are already on ${b}, from these merged pull requests. The files named are where that work is, which is not by itself what it satisfied:\n${lines.join("\n")}`,
    `The task's grader read that work at ${proved.map(at).join(" and ")}, the merged revision named above and not an earlier one, and marked these met at that revision, giving the evidence it relied on (the grader's words):\n${numbered(met)}`,
  ];
  if (!owed.length) out.push("The whole request above is what this change is judged against: the grader named no criterion still unmet, so none is settled here.");
  else out.push(
    `It marked these still not met, and they are what this change owes (the grader's words):\n${numbered(owed)}`,
    "So what this change owes is two things: the criteria the grader marked still unmet, above, and every requirement of the request above that the grader's rubric never assessed, which this note does not settle either way. Only the criteria it marked met are settled by the merged work, and those are not expected in this diff again.",
  );
  return out.join("\n\n");
}
