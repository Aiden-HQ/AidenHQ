// github.setup (module.yaml writes.setup): a reviewed setup PR for another module (code review's deepsec setup). The code host
// files this record itself when the kernel brokers the `setup` op (service.ts setupOp) and runs it only once the record is
// approved. One commit adds the allowlisted files the default branch is missing (never overwriting one), off the default
// branch's head the reviewer read (name and sha, bound in the record), on a new branch named from that commit (aidenhq/setup-<sha>):
// created atomically at the commit, so the PR is open on exactly it. One PR per repo: an earlier setup PR is closed when this one
// opens (only the PRs, at the heads, the reviewer was shown). It is always a branch and a PR, in every org; nothing here merges. The grant's path globs (`*` is one path segment) come
// with the args.
import { withFooter, withTrailer } from "./aidenhq-sdk/attribution.ts";

export type Api = (method: string, path: string, body?: unknown) => Promise<any>;
export type SetupArgs = { repo: string; files: Record<string, string>; allow: string[]; title: string; body: string; base?: string; base_head?: string; supersede?: { number: number; head: string }[] };
const fail = (status: number, message: string) => Object.assign(new Error(message), { status });
const enc = (path: string) => path.split("/").map(encodeURIComponent).join("/");
const SHA = /^[0-9a-f]{40}$/;
/** A setup PR's branch name starts with this. */
export const BRANCH = "aidenhq/setup-";
/** The most the files may weigh, serialised: the kernel checks the same (codehost.ts), and an executor request holds 1 MB in all. */
export const SETUP_BYTES = 800_000;

/** A grant path as a matcher: literal, except `*` is one path segment. */
export const globs = (allow: string[]) => allow.map((g) => new RegExp(`^${g.split("*").map((x) => x.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[\\w.-]+")}$`));

/** The args, checked again here: the record is the authority, whatever filed it. */
export function check(a: SetupArgs): SetupArgs {
  if (!/^[\w.-]+\/[\w.-]+$/.test(String(a.repo))) throw fail(400, `${String(a.repo)} is not owner/name`);
  if (a.base !== undefined && !/^[\w./-]{1,255}$/.test(String(a.base))) throw fail(400, "base is a branch name");
  if (a.base_head !== undefined && !SHA.test(String(a.base_head))) throw fail(400, "base_head is a commit sha");
  if (a.supersede !== undefined && (!Array.isArray(a.supersede) || a.supersede.some((p) => !Number.isInteger(p?.number) || !SHA.test(String(p?.head))))) throw fail(400, "supersede lists { number, head } of the PRs the reviewer saw");
  const paths = Object.keys(a.files ?? {});
  if (!paths.length || paths.length > 8 || !Array.isArray(a.allow) || !a.allow.length) throw fail(400, "files is 1 to 8 paths, with the grant's allowlist");
  if (Buffer.byteLength(JSON.stringify(a.files)) > SETUP_BYTES) throw fail(413, `the setup files are at most ${SETUP_BYTES} bytes in all`);
  const ok = globs(a.allow);
  for (const p of paths) if (!/^[\w.][\w./-]{0,499}$/.test(p) || p.split("/").some((x) => /^\.+$/.test(x)) || !ok.some((re) => re.test(p))) throw fail(403, `${p.slice(0, 200)} isn't an allowed setup path`);
  return a;
}

/** The default branch (name and head), the files its head lacks, and the open setup PRs into it (this one replaces them). */
async function read(api: Api, a: SetupArgs) {
  const def = String((await api("GET", `/repos/${a.repo}`)).default_branch ?? "");
  if (!def) throw fail(502, `${a.repo} has no default branch`);
  const head = String((await api("GET", `/repos/${a.repo}/branches/${enc(def)}`)).commit?.sha ?? "");
  if (!SHA.test(head)) throw fail(502, `${a.repo}'s ${def} has no head to branch from`);
  // A path under a directory that is a file there can't be added: refused here, not at the tree call.
  const dirs = [...new Set(Object.keys(a.files).flatMap((p) => p.split("/").slice(0, -1).map((_, i, parts) => parts.slice(0, i + 1).join("/"))))];
  const found = await Promise.all(dirs.map((d) => api("GET", `/repos/${a.repo}/contents/${enc(d)}?ref=${head}`).then((r) => r, (e: Error) => { if (/ 404\b/.test(e.message)) return null; throw e; })));
  const blocker = dirs.find((_, i) => found[i] && !Array.isArray(found[i]));
  if (blocker) throw fail(409, `${blocker} is a file on ${def}, so nothing can be added under it`);
  const lacks = await Promise.all(Object.keys(a.files).map((p) => api("GET", `/repos/${a.repo}/contents/${enc(p)}?ref=${head}`).then(() => false, (e: Error) => { if (/ 404\b/.test(e.message)) return true; throw e; })));
  const missing = Object.keys(a.files).filter((_, i) => lacks[i]);
  const open = (await api("GET", `/repos/${a.repo}/pulls?state=open&per_page=100`)) as { number: number; html_url: string; title: string; head: { ref: string; sha: string; repo?: { full_name?: string } | null }; base: { ref: string } }[];
  const earlier = open.filter((p) => p.base.ref === def && p.head.ref.startsWith(BRANCH) && p.head.repo?.full_name?.toLowerCase() === a.repo.toLowerCase());
  return { def, head, missing, earlier };
}

/** The plan: what the reviewer reads (the files to add, whole, and the PR text) and what the record binds (the default branch's name and head). */
export async function plan(api: Api, input: SetupArgs, leak?: (text: string) => string | undefined) {
  const a = check(input);
  const s = await read(api, a);
  const bad = leak?.(`${a.title}\n${a.body}`);
  if (bad) throw fail(422, `Not done: the PR title or description mentions "${bad}"; reword it and ask again.`);
  const bound: SetupArgs = { ...a, base: s.def, base_head: s.head, supersede: s.earlier.map((p) => ({ number: p.number, head: p.head.sha })) };
  const diff = [
    ...s.missing.map((p) => `--- new file ${p} ---\n${a.files[p]}`),
    `--- the pull request as it will be published ---\n${a.title}\n\n${a.body}`,
  ].join("\n\n");
  const closing = s.earlier.length ? ` The earlier setup PR${s.earlier.length === 1 ? "" : "s"} (${s.earlier.map((p) => `"${p.title}" ${p.html_url}`).join(", ")}) will be closed.` : "";
  return {
    args: bound,
    // The files this adds, as push and PR plans return them: the kernel runs the platform check on them.
    paths: [{ repo: a.repo, files: s.missing.map((path) => ({ path })) }],
    targets: { [`${a.repo} ${s.def}`]: { repo: a.repo, ref: s.def, commit: s.head } },
    facts: {
      target: `${a.repo} ${s.def}`,
      sentence: s.missing.length
        ? `Add ${s.missing.length} setup file${s.missing.length === 1 ? "" : "s"} (${s.missing.join(", ")}) to ${a.repo} in one commit off ${s.def} at ${s.head.slice(0, 12)}, on a new ${BRANCH}<sha> branch, and open a pull request "${a.title}" into ${s.def}. Nothing is merged; files the repo already has are never overwritten.${closing}`
        : `Nothing to do on ${a.repo}: ${s.def} already has every setup file, so no branch and no pull request are made.`,
      diff,
    },
  };
}

/** The approved write. Refuses when the default branch is not the one (name and head) the reviewer read. */
export async function run(api: Api, input: SetupArgs, signedAs = "Aiden"): Promise<{ ok: boolean; text: string; objects?: string[] }> {
  const a = check(input);
  const s = await read(api, a);
  if (a.base !== s.def || a.base_head !== s.head) throw fail(409, `${a.base ?? "the default branch"} at ${a.base_head ? a.base_head.slice(0, 12) : "an unrecorded head"} is the setup's reviewed base, but the default branch is now ${s.def} at ${s.head.slice(0, 12)}: ask again`);
  if (!s.missing.length) return { ok: true, text: JSON.stringify({ pr_url: null, nothing_to_add: true }) };
  const base = await api("GET", `/repos/${a.repo}/commits/${s.head}`);
  const tree = await api("POST", `/repos/${a.repo}/git/trees`, { base_tree: base.commit.tree.sha, tree: s.missing.map((path) => ({ path, mode: "100644", type: "blob", content: a.files[path] })) });
  const commit = await api("POST", `/repos/${a.repo}/git/commits`, { message: withTrailer(`Add the setup files (${s.missing.join(", ")})`, signedAs), tree: tree.sha, parents: [s.head] });
  const tip = String(commit.sha);
  // The branch is named from the commit and created in the same call that points it there (it fails when the name exists), so
  // the PR opened from it is on exactly this commit.
  const branch = `${BRANCH}${tip.slice(0, 12)}`;
  await api("POST", `/repos/${a.repo}/git/refs`, { ref: `refs/heads/${branch}`, sha: tip });
  const pr = await api("POST", `/repos/${a.repo}/pulls`, { title: a.title, body: withFooter(a.body, signedAs), head: branch, base: s.def })
    .catch(async (e: Error) => { await api("DELETE", `/repos/${a.repo}/git/refs/heads/${branch}`).catch(() => {}); throw e; });
  // One PR per repo: those earlier setup PRs and their branches go. A failure here leaves one to be closed by the next setup.
  // Only the PRs the reviewer was shown, still open at the head they were shown at: anything else changed since and stays.
  for (const old of s.earlier.filter((p) => a.supersede?.some((r) => r.number === p.number && r.head === p.head.sha))) {
    await api("PATCH", `/repos/${a.repo}/pulls/${old.number}`, { state: "closed" }).catch(() => {});
    await api("DELETE", `/repos/${a.repo}/git/refs/heads/${old.head.ref}`).catch(() => {});
  }
  return { ok: true, text: JSON.stringify({ pr_url: pr.html_url, branch, tip }), objects: [`github:${a.repo.toLowerCase()}#${Number(pr.number)}`] };
}
