// Community pull requests (the product repository's CONTRIBUTING.md, "For agent contributors"): the CLA check and the triage comment.
// Run by .github/workflows/community.yml on pull_request_target from the BASE checkout, on a GitHub-hosted runner; a PR's
// text is untrusted data here (matched, never echoed or executed). Triage informs the maintainer; it never approves.
import { readFileSync } from "node:fs";

const API = "https://api.github.com";
const MARKER = "<!-- aidenhq-triage -->";
const LABEL = "community";
const TITLE = /^(feat|fix|docs|chore|test|refactor|perf|ci|build|style|revert)(\([a-z0-9][a-z0-9._/-]*\))?!?: \S/;
const GATE = [/^\.github\//];

const strip = (body) => (body ?? "").replace(/<!--[\s\S]*?-->/g, "");

// The CLA box is the signature (CLA.md): ticked in the PR body.
export const claTicked = (body) => /^\s*[-*]\s*\[[xX]\][^\n]*CLA\.md/m.test(strip(body));

// Maintainers (same-repo branches, write access) and bots sign nothing here.
export const exempt = (pr, base) => pr.user?.type === "Bot" || pr.head.repo?.full_name === base;

// What the PR body says under a `## <name>` heading, comments removed.
export const section = (body, name) => {
  const m = strip(body).match(new RegExp(`^##\\s+${name}\\s*\\n([\\s\\S]*?)(?=^##\\s|(?![\\s\\S]))`, "mi"));
  return (m?.[1] ?? "").trim();
};

export function triageComment({ pr, files }) {
  const body = pr.body ?? "";
  const gate = files.filter((f) => GATE.some((re) => re.test(f)));
  const rows = [
    [TITLE.test(pr.title), "Title is a Conventional Commit"],
    [claTicked(body), "CLA box ticked"],
    [section(body, "Origin") !== "", "Origin named (instance and agent, or `human`)"],
    [section(body, "Evidence") !== "", "Evidence given"],
    [section(body, "Why") !== "", "Why given"],
    [gate.length === 0, gate.length ? `Touches gate or CI files (${gate.length}): extra maintainer review` : "Touches no gate or CI files"],
  ];
  return `${MARKER}
**Community PR triage.** This is an automatic checklist, not a review and not an approval. Only the maintainer merges.

${rows.map(([ok, text]) => `- [${ok ? "x" : " "}] ${text}`).join("\n")}

Fork PRs run CI on GitHub-hosted runners. The maintainer reviews this separately; unchecked boxes above are what to fix first.`;
}

async function gh(path, token, init = {}) {
  const res = await fetch(`${API}${path}`, { ...init, headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", ...init.headers } });
  if (!res.ok && res.status !== 404) throw new Error(`${init.method ?? "GET"} ${path}: ${res.status}`);
  return res;
}
const json = (body) => ({ body: JSON.stringify(body), headers: { "content-type": "application/json" } });

async function main(mode) {
  const token = process.env.GITHUB_TOKEN;
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
  const pr = event.pull_request;
  const repo = event.repository.full_name;
  if (exempt(pr, repo)) return console.log("maintainer or bot PR: nothing to do");

  if (mode === "cla") {
    if (claTicked(pr.body)) return console.log("CLA box ticked");
    console.log("::error::Tick the CLA box in the PR description (you agree to CLA.md), then this check re-runs.");
    process.exit(1);
  }

  const files = [];
  for (let page = 1; ; page++) {
    const batch = await (await gh(`/repos/${repo}/pulls/${pr.number}/files?per_page=100&page=${page}`, token)).json();
    files.push(...batch.map((f) => f.filename));
    if (batch.length < 100) break;
  }
  if ((await gh(`/repos/${repo}/labels/${LABEL}`, token)).status === 404) {
    await gh(`/repos/${repo}/labels`, token, { method: "POST", ...json({ name: LABEL, color: "0e8a16", description: "A pull request from outside the maintainers" }) });
  }
  await gh(`/repos/${repo}/issues/${pr.number}/labels`, token, { method: "POST", ...json({ labels: [LABEL] }) });

  const text = triageComment({ pr, files });
  const comments = await (await gh(`/repos/${repo}/issues/${pr.number}/comments?per_page=100`, token)).json();
  const mine = comments.find((c) => c.body?.startsWith(MARKER) && c.user?.type === "Bot");
  if (mine) await gh(`/repos/${repo}/issues/comments/${mine.id}`, token, { method: "PATCH", ...json({ body: text }) });
  else await gh(`/repos/${repo}/issues/${pr.number}/comments`, token, { method: "POST", ...json({ body: text }) });
  console.log(`labelled ${LABEL} and ${mine ? "updated" : "posted"} the triage comment`);
}

if (process.argv[1] === new URL(import.meta.url).pathname) await main(process.argv[2]);
