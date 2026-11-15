// Branch names follow the repository's own conventions from the start: the task's worktree is created
// on a branch named in the repository's style, because the repos we work in have nothing to do with
// AidenHQ. A short Codex call picks the name from the contributing guide, recent branch
// names and the request; code checks it and falls back to <type>/<slug>. Branches from before this
// (aidenhq/<task>) are renamed on their next run or push, unless already on GitHub.
import { askCodex } from "./intake.ts";
import { leaksInternal } from "./describe.ts";
import { fence } from "./thread.ts";

export const BRANCH_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["branch"],
  properties: { branch: { type: "string" } },
};

/** Local task branches: never pushed under this name. */
export const isLocalBranch = (branch: unknown) => /^aidenhq\//.test(String(branch ?? ""));

/** Lines about branches from contributing guides and agent instructions in the repository. */
export function branchGuidance(files: Iterable<[string, unknown]>) {
  const out: string[] = [];
  for (const [name, text] of files) {
    const lines = String(text ?? "").split("\n");
    const keep = new Set<number>();
    lines.forEach((l, i) => {
      if (/\bbranch(es)?\b/i.test(l) && !/\bbranch protection\b/i.test(l)) for (let j = Math.max(0, i - 1); j <= Math.min(lines.length - 1, i + 2); j++) keep.add(j);
    });
    if (keep.size) out.push(`${name}:\n${[...keep].sort((a, b) => a - b).map((i) => lines[i]).join("\n")}`);
  }
  return out.join("\n\n").slice(0, 3000);
}

/** Recent PR branches by people (no bots, none of ours), the user's own first. */
export function exampleBranches(prs: any[] | null | undefined, { login, base }: { login?: string; base?: string }) {
  const seen = new Set<string>();
  const mine: string[] = [];
  const others: string[] = [];
  for (const pr of prs ?? []) {
    const name = String(pr?.headRefName ?? "");
    const author = String(pr?.author?.login ?? "");
    if (!name || seen.has(name) || name === base || isLocalBranch(name) || pr?.author?.is_bot || /^app\/|\[bot\]$/.test(author) || /^(dependabot|renovate|release-please)/.test(name)) continue;
    seen.add(name);
    (login && author.toLowerCase() === login.toLowerCase() ? mine : others).push(name);
  }
  return { mine: mine.slice(0, 15), others: others.slice(0, 30) };
}

export function branchPrompt({ repo, login, guidance, examples, request, messages }: { repo: string; login?: string; guidance?: string; examples: { mine: string[]; others: string[] }; request: unknown; messages: string[] }) {
  return `Name the git branch for a change to ${repo}, following that repository's conventions. Answer with JSON. Do not run any tools.

Rules:
- Follow the branch naming rules in the contributing guide below, if there are any.
- Otherwise follow the pattern of ${login ? `${login}'s own recent branches (the user, who opens this PR), then of ` : ""}the repository's recent branches: the same prefix style (for example "feat/…", "fix/…", "<username>/…"${login ? `, with the username ${login}` : ""}), separators and casing.
- If there is no clear pattern, use "<type>/<short-description>" with a conventional commit type (feat, fix, chore, docs, refactor, test, ci).
- The description part says what the change does in a few kebab-case words. At most 60 characters in total.
- Never mention a task tracker, ticket number, agent, AI tool, or this machine.

${fence("CONTRIBUTING", guidance || "(none found)", 3000)}

${fence(login ? `RECENT_BRANCHES_BY_${login}` : "RECENT_BRANCHES_BY_USER", examples.mine.join("\n") || "(none)", 1500)}

${fence("RECENT_BRANCHES_BY_OTHERS", examples.others.join("\n") || "(none)", 2000)}

${fence("COMMITS", messages.join("\n\n---\n\n") || "(none yet: name it from the request)", 3000)}

${fence("REQUEST", request, 4000)}`;
}

/** A usable branch name, or "" when it isn't one we would push. */
export function checkBranchName(raw: unknown, { base, defaultBranch }: { base?: string; defaultBranch?: string }) {
  const name = String(raw ?? "").trim().replace(/^refs\/heads\//, "");
  if (!name || name.length > 80) return "";
  if (!/^[A-Za-z0-9][A-Za-z0-9._\/-]*$/.test(name) || /\/\/|\.\.|\.lock(\/|$)|[./]$|\/\./.test(name)) return "";
  if (leaksInternal(name) || isLocalBranch(name)) return "";
  if ([base, defaultBranch, "main", "master", "develop", "HEAD"].includes(name)) return "";
  return name;
}

/** `feat: add X` → `feat/add-x`; anything else → `chore/<slug>`. */
export function fallbackBranchName(subject: unknown) {
  const m = String(subject ?? "").match(/^(\w+)(?:\([^)]*\))?!?:\s*(.*)$/);
  const type = m && /^(feat|fix|chore|docs|refactor|test|ci|build|perf|style)$/i.test(m[1]!) ? m[1]!.toLowerCase() : "chore";
  const slug = String(m ? m[2] : subject ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50)
    .replace(/-+$/, "");
  const name = `${type}/${slug || "update"}`;
  return leaksInternal(name) ? `${type}/update` : name;
}

/**
 * The task branch's name. `taken(name)` says whether a name is already in use (locally or on
 * GitHub); a taken name gets -2, -3, … appended. `ask` answers the prompt (a Codex call by default).
 * Without commits yet, the fallback comes from `title` (the task's).
 */
export async function chooseBranchName({ cfg, repo, base, defaultBranch, login, guidance, prs, request, messages, title = "", taken, ask = (prompt) => askCodex(cfg, prompt, BRANCH_SCHEMA) }: { cfg?: any; repo: string; base?: string; defaultBranch?: string; login?: string; guidance?: string; prs?: any[]; request: unknown; messages: string[]; title?: string; taken: (name: string) => boolean | Promise<boolean>; ask?: (prompt: string) => Promise<any> }) {
  const subject = messages.at(-1)?.split("\n")[0] || title;
  let name = "";
  let generated = false;
  try {
    const examples = exampleBranches(prs, { login, base });
    const raw = await ask(branchPrompt({ repo, login, guidance, examples, request, messages }));
    name = checkBranchName(raw?.branch, { base, defaultBranch });
    generated = Boolean(name);
  } catch {
    /* fall back below */
  }
  if (!name) name = checkBranchName(fallbackBranchName(subject), { base, defaultBranch }) || "chore/update";
  let free = name;
  for (let n = 2; await taken(free); n++) free = `${name}-${n}`;
  return { name: free, generated };
}
