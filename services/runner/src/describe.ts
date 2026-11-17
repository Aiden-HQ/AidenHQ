// Pull request titles and descriptions, written for the repository's reviewers. They know nothing
// about how a change was made, so nothing about AidenHQ, Paperclip, task numbers, the agents or
// this machine may appear in what we publish (PR #44 on legacy-techdocs said "Draft opened by
// AidenHQ for Paperclip task PEN-406"). A short Codex call writes it; code checks for leaks.
import { askCodex } from "./intake.ts";
import { fence } from "./thread.ts";

export const PR_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["title", "body"],
  properties: { title: { type: "string" }, body: { type: "string" } },
};

const INTERNAL = /aidenhq|paperclip|\bPEN-\d+\b|\/home\/|~\/|\bworktree\b|\bopencode\b|\bopenrouter\b|claude code|\bcodex\b/i;

/** True when text mentions our tooling, task numbers or local paths. */
export const leaksInternal = (text: unknown) => INTERNAL.test(String(text ?? ""));
/** Another repository in the same GitHub org as `ref` (the product repo): its modules and distro are ours too. */
export const sameOrg = (slug: string | undefined, ref: string | undefined) => Boolean(slug && ref) && slug!.split("/")[0]!.toLowerCase() === ref!.split("/")[0]!.toLowerCase();

/** The first internal name in text, for telling the agent what to reword. */
export const leakIn = (text: unknown) => String(text ?? "").match(INTERNAL)?.[0];

/** Claude Code ends PR descriptions with its own footer out of habit; the reviewers don't need it. */
export const stripAttribution = (body: unknown) => String(body ?? "").replace(/^[^\S\n]*(?:🤖[^\S\n]*)?Generated with \[?Claude Code\]?(?:\([^)\n]*\))?[^\S\n]*$/gim, "").trim();

/** Commit messages (\x1e-separated, oldest first) without trailers from older runner versions. */
export function cleanMessages(raw: unknown) {
  return String(raw ?? "")
    .split("\x1e")
    .map((m) => m.split("\n").filter((l) => !/^\s*Paperclip task:/i.test(l)).join("\n").trim())
    .filter(Boolean);
}

/** The safe fallback: the commit messages themselves. */
export function fallbackDescription(messages: string[]) {
  const [first, ...rest] = messages;
  const bodyOf = (m: string) => m.split("\n").slice(1).join("\n").trim();
  if (!rest.length) return bodyOf(first ?? "") || "";
  return ["## Changes", "", ...messages.map((m) => `- ${m.split("\n")[0]}${bodyOf(m) ? `\n\n  ${bodyOf(m).replace(/\n/g, "\n  ")}` : ""}`)].join("\n");
}

export function describePrompt({ repo, base, request, messages, stat, diff, report }: { repo: string; base: string; request: unknown; messages: string[]; stat: unknown; diff: unknown; report: unknown }) {
  return `Write the title and description of a GitHub pull request for ${repo} (into ${base}), for the repository's reviewers. Answer with JSON. Do not run any tools.

Rules:
- If the request below specifies the PR title or body (for example "Title: …" and "Body: …"), use them exactly, filled in for this repository.
- Otherwise: the title is a Conventional Commit subject (\`type(scope): summary\`, type one of feat, fix, docs, chore, test, refactor, perf, ci, build; at most 72 characters), unless the commits clearly follow another style. Body in markdown: why the change is needed and what changed, in a few sentences or bullets, then "Testing" with only checks the report says were actually run. No "Summary of the run", no step-by-step story.
- The reviewers can't see the request, the report or any tool. Never mention them, or any task tracker, ticket number, agent, AI tool, local file path or machine. Don't link to local files.
- Only describe what the diff and commits show.

${fence("REQUEST", request, 24000)}

${fence("COMMITS", messages.join("\n\n---\n\n"), 4000)}

${fence("DIFFSTAT", stat, 2000)}

${fence("DIFF", diff, 15000)}

${fence("REPORT", report, 4000)}`;
}

/**
 * Title and body for a new PR. Falls back to the commit messages when the call fails or its answer
 * mentions anything internal; generated tells which one it is.
 */
export async function writePrDescription({ cfg, repo, base, request, messages, stat, diff, report, fallbackTitle }: { cfg: any; repo: string; base: string; request: unknown; messages: string[]; stat: unknown; diff: unknown; report: unknown; fallbackTitle: string }) {
  const fallback = { title: fallbackTitle, body: fallbackDescription(messages), generated: false };
  try {
    const raw = await askCodex(cfg, describePrompt({ repo, base, request, messages, stat, diff, report }), PR_SCHEMA);
    const title = String(raw?.title ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
    const body = String(raw?.body ?? "").trim().slice(0, 20_000);
    if (!title || !body || leaksInternal(title) || leaksInternal(body)) return { ...fallback, rejected: Boolean(title || body) };
    return { title, body, generated: true };
  } catch {
    return fallback;
  }
}

/** The open PR gh refused to duplicate ("a pull request for branch … already exists: <url>"), when it is in `repo`. */
export function existingPrUrl(stderr: unknown, repo: unknown) {
  if (!/already exists/i.test(String(stderr ?? ""))) return undefined;
  const url = String(stderr).match(/https:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/pull\/\d+/);
  return url && url[1]!.toLowerCase() === String(repo).toLowerCase() ? url[0] : undefined;
}
