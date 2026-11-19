// The task's other PRs already merged into this change's base, as the AI reviewer reads them (reviewer@1 `siblings`; the old
// runner's siblings.ts, 03ecfcda4^). The code host's plan reads the rows (modules/github/service/src/siblings.mjs: GitHub's own
// merge, the base's files since) and the record keeps them (records.context.siblings); this renders them. Every PR-chosen name
// is encoded, so the block is safe inside its fence.

/** A task PR merged into the change's base: `files` its own (undefined: not read), `changed` those the base changed again since (undefined: not read). */
export type Sibling = { repo: string; number: number; base: string; mergeCommit: string; files?: string[]; changed?: string[] };

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
