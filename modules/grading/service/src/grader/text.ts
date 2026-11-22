// Small helpers the grader reads: task-text and PR-text helpers.
/** Remove HTML comments: hidden text never counts as the user's words. */
export const stripHidden = (s: unknown) => String(s ?? "").replace(/<!--[\s\S]*?-->/g, "");

/**
 * Remove a description's copies of a grade's rubric: each `Graded before done (…)` line and the numbered criteria under
 * it. A removed block is rubric material, not the request: the row's own rubric is the only criteria list the grader
 * answers (grade.ts), so extra criteria lines in the task's words must not reach the model as if they were criteria.
 */
export const stripRubric = (s: unknown) => {
  const text = String(s ?? "");
  const heading = /^[ \t]*Graded before done \([^)]*\):/;
  const criterion = /^[ \t]*\d+\.[ \t]/;
  const blank = /^[ \t]*$/;
  const kept: string[] = [];
  const lines = text.split("\n");
  let removed = false;
  for (let i = 0; i < lines.length; i++) {
    if (!heading.test(lines[i])) {
      kept.push(lines[i]);
      continue;
    }
    removed = true;
    // The heading and every criterion line after it; blank lines only when another criterion follows, so the request's
    // own text after the block stays as it was.
    while (i + 1 < lines.length) {
      if (criterion.test(lines[i + 1])) {
        i++;
        continue;
      }
      let k = i + 1;
      while (k < lines.length && blank.test(lines[k])) k++;
      if (k > i + 1 && k < lines.length && criterion.test(lines[k])) {
        i = k - 1;
        continue;
      }
      break;
    }
  }
  return removed ? kept.join("\n").replace(/\n{3,}/g, "\n\n").trim() : text;
};

export function findPrs(text: unknown) {
  const out: { repo: string; number: number; url: string }[] = [];
  const re = /(?:https?:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+))|(?:codehost:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/change\/(\d+))|(?<![\w./:-])([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)\b|(?<![\w./:-])([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#(\d+)\b/g;
  for (const m of String(text ?? "").replace(/\\(.)/g, "$1").matchAll(re)) {
    const [org, name, number] = m[1] ? [m[1], m[2], m[3]] : m[4] ? [m[4], m[5], m[6]] : m[7] ? [m[7], m[8], m[9]] : [m[10], m[11], m[12]];
    const repo = `${org}/${name}`;
    const url = org.toLowerCase() === "local" ? `codehost:${repo}/change/${number}` : `https://github.com/${repo}/pull/${number}`;
    if (!out.some((p) => p.repo.toLowerCase() === repo.toLowerCase() && p.number === Number(number))) out.push({ repo, number: Number(number), url });
  }
  return out;
}

export function staleHead(recorded: string | null | undefined, head: string | null | undefined): string | undefined {
  if (!head) return "GitHub couldn't read its head branch";
  if (String(head) === String(recorded ?? "")) return undefined;
  return `its head branch is \`${head}\`, not the task's \`${recorded ?? ""}\``;
}
