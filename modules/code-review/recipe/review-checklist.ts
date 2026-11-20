// The reliability checklist's matcher: code, not the model, picks the items whose trigger a diff matches, so a reviewer
// checks the few that apply (usually 3 to 10) instead of remembering every past outage. The checklist is always read from
// the base (the deployed product for the AI reviewer; the base commit for CI's code review), never from the change.
//
// An item: { id, trigger: { paths?: [glob], lines?: regex }, check, why }. It matches when one file in the diff has a path
// matching one of `paths` (any path when absent) and, when `lines` is set, a changed line in that same file matches it.
// Changed lines are the added and removed lines plus git's own file headers (new file, deleted file, rename, `+++ /dev/null`);
// paths come from git's own file headers, never from a changed line (diffFiles).
// Globs: `**` any path segments, `*` within one segment, `?` one character.
//
// Canonical copy: ci/template/.github/review-checklist.ts (MIT, the CI template's). The AI reviewer module holds a
// byte-identical copy (the product's scripts/sync-shared.ts).

/** A glob as an anchored regex. */
export function globRe(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      i++;
      if (glob[i + 1] === "/") (i++, (re += "(?:.*/)?"));
      else re += ".*";
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

/** A path as git prints it in a header: plain, or quoted with C escapes (octal bytes, \t, \", \\) and decoded as UTF-8. */
export function gitPath(text) {
  const t = String(text).replace(/\t.*$/, "");
  if (!t.startsWith('"')) return t;
  const bytes = [];
  const esc = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13 };
  for (let i = 1; i < t.length - 1; i++) {
    if (t[i] !== "\\") bytes.push(...Buffer.from(t[i]));
    else if (/[0-7]/.test(t[i + 1])) (bytes.push(parseInt(t.slice(i + 1, i + 4), 8)), (i += 3));
    else bytes.push(esc[t[i + 1]] ?? t.charCodeAt(i + 1)), i++;
  }
  return Buffer.from(bytes).toString("utf8");
}

/** The path a header line names after its prefix (`b/` or `a/`, quoted or not), or undefined. */
const named = (rest, side) => {
  const p = gitPath(rest);
  return p.startsWith(`${side}/`) ? p.slice(2) : undefined;
};

/**
 * A diff's files: [{ path, lines }], `lines` its changed lines and git's file headers. A file starts at its `diff --git`
 * line; its path comes from git's own headers before its first `@@` (`+++ b/<path>`, else `rename to`, else `--- a/<path>`
 * for a deletion), the `diff --git` line only as a fallback (ambiguous when a path holds " b/"). Every line after the first
 * `@@` is content, so a changed line that looks like a header (`+++ b/other`) can never re-point the lines after it.
 * `diff --git` and the runner's `### ` headings start at column 0, which no content line does (each starts with +, - or a
 * space). A diff with no `diff --git` line is one file, path "".
 */
export function diffFiles(diff) {
  const files = [];
  let cur;
  let header = false;
  let minus;
  for (const line of String(diff ?? "").split("\n")) {
    if (line.startsWith("diff --git ")) {
      const rest = line.slice(11);
      const same = /^a\/(.+) b\/\1$/.exec(rest);
      const quoted = /^("(?:[^"\\]|\\.)*"|\S+) ("(?:[^"\\]|\\.)*")$/.exec(rest);
      const path = same ? same[1] : quoted ? named(quoted[2], "b") ?? "" : (/ b\/(.+)$/.exec(rest)?.[1] ?? "");
      files.push((cur = { path, lines: [] }));
      header = true;
      minus = undefined;
      continue;
    }
    if (line.startsWith("### ")) {
      cur = undefined;
      header = false;
      continue;
    }
    if (line.startsWith("@@")) {
      header = false;
      continue;
    }
    if (header) {
      // Git's own headers name the path; the others are kept as lines (a trigger can read `deleted file mode`, `rename
      // from`, `+++ /dev/null`).
      if (line.startsWith("+++ ") && named(line.slice(4), "b") !== undefined) cur.path = named(line.slice(4), "b");
      else if (line.startsWith("--- ") && named(line.slice(4), "a") !== undefined) minus = named(line.slice(4), "a");
      else if (line.startsWith("rename to ")) (cur.path = gitPath(line.slice(10))), cur.lines.push(line);
      else if (!line.startsWith("index ")) {
        if (line.startsWith("+++ /dev/null") && minus !== undefined) cur.path = minus;
        cur.lines.push(line);
      }
      continue;
    }
    if (!line.startsWith("+") && !line.startsWith("-")) continue;
    if (!cur) files.push((cur = { path: "", lines: [] }));
    cur.lines.push(line);
  }
  return files;
}

/** The checklist items a diff triggers, in the checklist's order. */
export function matchChecklist(items, diff) {
  const files = diffFiles(diff);
  return (items ?? []).filter((item) => {
    const paths = (item.trigger?.paths ?? []).map(globRe);
    const lines = item.trigger?.lines ? new RegExp(item.trigger.lines) : undefined;
    return files.some((f) => (!paths.length || paths.some((re) => re.test(f.path))) && (!lines || f.lines.some((l) => lines.test(l))));
  });
}

/** The matched items as the reviewer reads them, one per line ("" when none). */
export const checklistText = (items) => items.map((i) => `- ${i.id}: ${i.check}${i.why ? ` (Why: ${i.why})` : ""}`).join("\n");
