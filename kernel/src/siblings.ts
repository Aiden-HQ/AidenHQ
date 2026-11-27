// Names an agent chose (a branch, a path, a commit), encoded so they can't emit markup or prose into a rendered block. The AI reviewer no longer reads the task's merged sibling PRs (owner, 2026-11-22: malice only).

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
