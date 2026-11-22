// Whether a rubric criterion claims that a repository file's contents lack something. The grader sees the diff, not the
// resulting tree, so no diff can show a token is gone from a whole file: the claim is refused wherever a rubric is written
// (an agent's filing, a module's filing, an amendment), from this one parser.
//
// Canonical copy: services/shared/absence.ts. The grading service and the task tools each hold a byte-identical copy
// (scripts/sync-shared.ts), because each is its own Docker build context.
const ABSENT = /\b(?:contains?|containing|includes?|including|holds?|holding)\s+no\b|\b(?:does|do|did)(?:n't| not)\s+(?:contain|include|hold|mention|name|reference|list)\b|\b(?:has|have)\s+no\b|\b(?:is|are|was|were)\s+absent\s+from\b/i;
/** The one alternative whose subject follows the claim ("the line is absent from docs/a.md"). */
const ABSENT_FROM = /\babsent\s+from\b/i;
const REPO_FILE = /\b(?:files?|handbooks?|docs?|documents?|trees?|repos?(?:itories)?|sources?|modules?|readme|codebase)\b|[\w./-]+\.[a-z]{1,5}\b/i;
const ATTACHED = /\battach(?:ed|ment|ments)\b/i;
const DIFF_SUBJECT = /\b(?:pr|pull requests?|diff|patch|changes?|commits?|merge[ds]?)\b/i;
const PAGE_PATH = /(?<![\w:/.~-])\/[A-Za-z0-9._~-]/;
// A sentence ends at a full stop, and an independent clause at a contrast ("but", "while", "whereas"): those start a new claim.
// A comma, a semicolon and "and"/"or" only coordinate within one: "docs/a.md, docs/b.md and the attached report contain no X"
// is one claim about three subjects, and each is judged on its own.
const SENTENCE_BREAK = /[.;]\s+/g;
const CLAUSE_BREAK = /\b(?:but|while|whereas)\s+/gi;
const COORDINATION = /\s*(?:,|\band\b|\bor\b|&|\bplus\b)\s*/gi;
/**
 * The subjects an absence claim is about, never its object: the coordinated parts before the claim in its own clause ("docs/a.md
 * and the attached report contain no X" is a claim about both), or, for "is absent from", what follows it. So "the /slipped
 * page has no `Linus` row and docs/a.md has the heading" is a claim about the page (a later clause is not its subject), and
 * "the /totals page has no README.md link" is a claim about the page (the object is what is missing, not where it is missing).
 */
function absenceSubjects(c: string, claim: RegExpExecArray): string[] {
  const [at, length] = [claim.index, claim[0].length];
  if (ABSENT_FROM.test(claim[0])) {
    const after = c.slice(at + length);
    const end = after.search(SENTENCE_BREAK);
    return after.slice(0, end < 0 ? after.length : end).split(COORDINATION).map((p) => p.trim()).filter(Boolean);
  }
  const head = c.slice(0, at);
  let start = 0;
  for (const m of head.matchAll(SENTENCE_BREAK)) start = Math.max(start, (m.index ?? 0) + m[0].length);
  for (const m of head.slice(start).matchAll(CLAUSE_BREAK)) start += (m.index ?? 0) + m[0].length;
  return head.slice(start).split(COORDINATION).map((p) => p.trim()).filter(Boolean);
}
/** Whether any subject of a claim names a repository file its evidence can't show. */
const absenceRefuses = (subjects: string[]) =>
  subjects.some((part) => REPO_FILE.test(part) && !ATTACHED.test(part) && !PAGE_PATH.test(part) && !DIFF_SUBJECT.test(part));
/**
 * The first criterion claiming a repository file's contents lack something, or undefined. A claim about an attached file (its
 * contents are evidence), a rendered page path, or what a PR's diff does not add is decidable and stays allowed; a `file`
 * deliverable is the attachment itself, so nothing is refused for it.
 */
export function uncheckableAbsence(rubric: string[], kind?: string): string | undefined {
  if (kind === "file") return undefined;
  return rubric.find((c) => {
    // "the diff removes X and docs/a.md contains no Y": each claim is judged on its own subject, never on another clause,
    // and an exemption for one coordinated part ("the attached report") never covers another ("docs/a.md").
    for (const claim of c.matchAll(new RegExp(ABSENT.source, "gi"))) {
      if (absenceRefuses(absenceSubjects(c, claim))) return true;
    }
    return false;
  });
}
