// Allowed: a repository listed in /opt/aidenhq/allowed (lines: `owner/*` for a whole org, or `owner/name`), named the same
// by the runner and by the event payload, and an event that runs code already on the default branch (a push or
// workflow_dispatch on it, a schedule) or a pull_request from a branch of this same repository. Everything else is
// refused: fork PRs, pull_request_target, issue_comment, workflow_run, release, repository_dispatch, merge_group and pushes
// to other branches (a merge train, main plus approved PRs that may come from forks). Each container takes one job (--ephemeral).
import { readFileSync } from "node:fs";
const { GITHUB_REPOSITORY: repo = "", GITHUB_EVENT_NAME: event = "", GITHUB_EVENT_PATH: path = "" } = process.env;
const refuse = (why) => { console.error(`::error::aidenhq runner refused this job: ${why}`); process.exit(1); };
const lc = (s) => String(s ?? "").toLowerCase();
const allowed = readFileSync("/opt/aidenhq/allowed", "utf8").split(/\s+/).map(lc).filter(Boolean);
const r = lc(repo);
if (!r || !allowed.some((a) => a === r || (a.endsWith("/*") && r.startsWith(a.slice(0, -1))))) refuse(`repository ${repo} is not served here`);
let payload;
try { payload = JSON.parse(readFileSync(path, "utf8")); } catch { refuse("no readable event payload"); }
if (lc(payload.repository?.full_name) !== r) refuse(`the event is for ${payload.repository?.full_name}, not ${repo}`);
if (event === "schedule") process.exit(0);
if (event === "push" || event === "workflow_dispatch") {
  const main = `refs/heads/${payload.repository?.default_branch}`;
  if (payload.repository?.default_branch && payload.ref === main) process.exit(0);
  refuse(`${event} to ${payload.ref || "an unknown ref"}, not ${main}`);
}
if (event !== "pull_request") refuse(`event ${event} is not allowed`);
const head = payload.pull_request?.head?.repo?.full_name;
if (lc(head) !== r) refuse(`pull request from ${head || "an unknown repository"}, not ${repo}`);
