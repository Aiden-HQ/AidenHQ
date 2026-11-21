// Code review's deepsec setup (docs/design/code-review.md): the code-review module's executor, for an approved `code-review.setup`
// record, calls /internal/setup. It puts exactly ONE new commit of the allowlisted `.deepsec/` files on a branch under aidenhq/
// (on `base` when the branch is new, on `expected_tip` when it exists) and opens the branch's PR, or reuses the open one. The PR
// targets the default branch and nothing here merges it (outside the agents org a PR is all the owner's sign-in ever does).
// The branch only ever moves forward, only from the tip the record was approved against; github.ts `guard` pins the paths, the
// branch namespace and never a force, whatever this file asks.
import { z } from "zod";
import { withFooter, withTrailer } from "./aidenhq-sdk/attribution.js";
import { GitHub, GitHubRefused, SETUP_PATHS } from "./github.js";

const SHA = /^[0-9a-f]{40}$/;
const Body = z.object({
  repo: z.string().regex(/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/),
  base: z.string().regex(SHA),
  branch: z.string().regex(/^aidenhq\/[A-Za-z0-9._-]{1,80}$/, "the branch is aidenhq/<name>"),
  expected_tip: z.string().regex(SHA).nullable(),
  files: z.record(z.string(), z.string().max(1_000_000)),
  title: z.string().min(1).max(200),
  body: z.string().max(20_000),
}).strict();
export type SetupBody = z.infer<typeof Body>;
const AGENT = "Aiden";
const MESSAGE = "Add the deepsec setup files";

export async function setup(gh: GitHub, input: unknown): Promise<{ pr_url: string; tip: string; objects: string[] }> {
  const b = Body.parse(input);
  const paths = Object.keys(b.files);
  if (!paths.length) throw new GitHubRefused("no files to commit");
  const outside = paths.find((p) => !(SETUP_PATHS as readonly string[]).includes(p));
  if (outside) throw new GitHubRefused(`${outside} isn't one of the setup files (${SETUP_PATHS.join(", ")})`);
  const api = `/repos/${b.repo}`;
  const [owner] = b.repo.split("/");

  // The branch must be where the record said it was: new (null) or at its tip. Anything else is a change nobody approved over.
  const tip = await gh.request<{ commit: { sha: string } }>("GET", `${api}/branches/${encodeURIComponent(b.branch)}`).then((r) => r.commit.sha, (e: Error) => {
    if (/^GitHub 404/.test(e.message)) return null;
    throw e;
  });
  if (tip !== b.expected_tip) throw new GitHubRefused(`${b.branch} is at ${tip ? tip.slice(0, 12) : "nothing"}, not the ${b.expected_tip ? b.expected_tip.slice(0, 12) : "new branch"} this setup was approved against`);

  const parent = tip ?? b.base;
  const base = await gh.request<{ commit: { tree: { sha: string } } }>("GET", `${api}/commits/${parent}`);
  const tree = await gh.request<{ sha: string }>("POST", `${api}/git/trees`, { body: { base_tree: base.commit.tree.sha, tree: paths.map((path) => ({ path, mode: "100644", type: "blob", content: b.files[path]! })) } });
  const commit = await gh.request<{ sha: string }>("POST", `${api}/git/commits`, { body: { message: withTrailer(MESSAGE, AGENT), tree: tree.sha, parents: [parent] } });
  if (tip) await gh.request("PATCH", `${api}/git/refs/heads/${b.branch}`, { body: { sha: commit.sha } });
  else await gh.request("POST", `${api}/git/refs`, { body: { ref: `refs/heads/${b.branch}`, sha: commit.sha } });

  const open = await gh.request<{ html_url: string; number: number }[]>("GET", `${api}/pulls`, { query: { state: "open", head: `${owner}:${b.branch}` } });
  if (open[0]) return { pr_url: open[0].html_url, tip: commit.sha, objects: [] };
  const def = (await gh.request<{ default_branch: string }>("GET", api)).default_branch;
  const pr = await gh.request<{ html_url: string; number: number }>("POST", `${api}/pulls`, { body: { title: b.title, body: withFooter(b.body, AGENT), head: b.branch, base: def } });
  return { pr_url: pr.html_url, tip: commit.sha, objects: [`github:${b.repo.toLowerCase()}#${pr.number}`] };
}
