// github.setup (module.yaml writes.setup): a reviewed setup PR for another module (code review's deepsec setup). The code host
// files this record itself when the kernel brokers the `setup` op (service.ts setupOp) and runs it only once the record is
// approved, so what is pushed is exactly the approved repo, branch, tip and files. One commit adds the allowlisted files the
// repo is missing (never overwriting one), on the branch's tip or, for a new branch, the default branch's head (never the commit a
// review read). It is always a branch and a PR, in every org; nothing here merges. The whole PR diff against the default branch
// must hold allowlisted paths only, or it refuses. The grant's path globs (`*` is one path segment) come with the args.
import { withFooter, withTrailer } from "./aidenhq-sdk/attribution.ts";

export type Api = (method: string, path: string, body?: unknown) => Promise<any>;
export type SetupArgs = { repo: string; branch: string; expected_tip: string | null; files: Record<string, string>; allow: string[]; title: string; body: string };
const fail = (status: number, message: string) => Object.assign(new Error(message), { status });
const enc = (path: string) => path.split("/").map(encodeURIComponent).join("/");
const SHA = /^[0-9a-f]{40}$/;

/** A grant path as a matcher: literal, except `*` is one path segment. */
export const globs = (allow: string[]) => allow.map((g) => new RegExp(`^${g.split("*").map((x) => x.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[\\w.-]+")}$`));

/** The args, checked again here: the record is the authority, whatever filed it. */
export function check(a: SetupArgs): SetupArgs {
  if (!/^[\w.-]+\/[\w.-]+$/.test(String(a.repo))) throw fail(400, `${String(a.repo)} is not owner/name`);
  if (!/^aidenhq\/[\w.-]{1,80}$/.test(String(a.branch))) throw fail(400, "the branch is aidenhq/<name>");
  if (a.expected_tip !== null && !SHA.test(String(a.expected_tip))) throw fail(400, "expected_tip is a commit sha or null");
  const paths = Object.keys(a.files ?? {});
  if (!paths.length || paths.length > 8 || !Array.isArray(a.allow) || !a.allow.length) throw fail(400, "files is 1 to 8 paths, with the grant's allowlist");
  const ok = globs(a.allow);
  for (const p of paths) if (!/^[\w.][\w./-]{0,499}$/.test(p) || p.split("/").some((x) => /^\.+$/.test(x)) || !ok.some((re) => re.test(p))) throw fail(403, `${p.slice(0, 200)} isn't an allowed setup path`);
  return a;
}

/** The repo's default branch and its head, the branch's tip (null: no such branch) and which files the parent lacks. */
async function read(api: Api, a: SetupArgs) {
  const def = String((await api("GET", `/repos/${a.repo}`)).default_branch ?? "");
  if (!def) throw fail(502, `${a.repo} has no default branch`);
  const head = String((await api("GET", `/repos/${a.repo}/branches/${enc(def)}`)).commit?.sha ?? "");
  const tip = await api("GET", `/repos/${a.repo}/branches/${enc(a.branch)}`).then((b) => String(b.commit?.sha ?? ""), (e: Error) => { if (/ 404\b/.test(e.message)) return null; throw e; });
  if (tip !== a.expected_tip) throw fail(409, `${a.branch} is at ${tip ? tip.slice(0, 12) : "nothing"}, not ${a.expected_tip ? a.expected_tip.slice(0, 12) : "a new branch"}: ask again`);
  const parent = tip ?? head;
  const missing: string[] = [];
  for (const p of Object.keys(a.files)) {
    const has = await api("GET", `/repos/${a.repo}/contents/${enc(p)}?ref=${parent}`).then(() => true, (e: Error) => { if (/ 404\b/.test(e.message)) return false; throw e; });
    if (!has) missing.push(p);
  }
  return { def, head, tip, parent, missing };
}

/** The plan: what the reviewer reads (the files to add, whole) and what the record binds (the branch's tip and the base's head). */
export async function plan(api: Api, input: SetupArgs, leak?: (text: string) => string | undefined) {
  const a = check(input);
  const s = await read(api, a);
  const bad = leak?.(`${a.title}\n${a.body}`);
  if (bad) throw fail(422, `Not done: the PR title or description mentions "${bad}"; reword it and ask again.`);
  const add = s.missing;
  const diff = add.map((p) => `--- new file ${p} ---\n${a.files[p]}`).join("\n\n");
  return {
    args: a,
    targets: { [`${a.repo} ${a.branch}`]: { repo: a.repo, ref: a.branch, commit: s.tip, base_sha: s.head } },
    facts: {
      target: `${a.repo} ${a.branch}`,
      sentence: add.length
        ? `Add ${add.length} setup file${add.length === 1 ? "" : "s"} (${add.join(", ")}) to ${a.repo} on \`${a.branch}\` (${s.tip ? `from its tip ${s.tip.slice(0, 12)}` : `new, off ${s.def} at ${s.head.slice(0, 12)}`}) and open a pull request "${a.title}" into ${s.def}. Nothing is merged; files the repo already has are never overwritten.`
        : `Open a pull request "${a.title}" from \`${a.branch}\` into ${s.def} on ${a.repo}: every setup file is already there, so no commit is made.`,
      diff,
    },
  };
}

/** The approved write. Refuses when the branch moved or the PR's whole diff would hold a path outside the allowlist. */
export async function run(api: Api, input: SetupArgs, signedAs = "Aiden"): Promise<{ ok: boolean; text: string; objects?: string[] }> {
  const a = check(input);
  const s = await read(api, a);
  const ok = globs(a.allow);
  // The PR's whole diff against the default branch: what the branch already carries plus what this commit adds.
  const carried: string[] = [];
  if (s.tip) {
    const cmp = await api("GET", `/repos/${a.repo}/compare/${encodeURIComponent(s.def)}...${s.tip}`);
    const files = (cmp.files ?? []) as { filename: string; previous_filename?: string }[];
    if (files.length >= 300) throw fail(409, `${a.branch}'s diff is too large to verify`);
    carried.push(...files.flatMap((f) => [f.filename, f.previous_filename].filter(Boolean) as string[]));
  }
  const out = [...carried, ...s.missing].find((p) => !ok.some((re) => re.test(p)));
  if (out) return { ok: false, text: `Refused: the pull request would change ${out}, which isn't an allowed setup path.` };
  let tip = s.tip;
  if (s.missing.length) {
    const base = await api("GET", `/repos/${a.repo}/commits/${s.parent}`);
    const tree = await api("POST", `/repos/${a.repo}/git/trees`, { base_tree: base.commit.tree.sha, tree: s.missing.map((path) => ({ path, mode: "100644", type: "blob", content: a.files[path] })) });
    const commit = await api("POST", `/repos/${a.repo}/git/commits`, { message: withTrailer(`Add the setup files (${s.missing.join(", ")})`, signedAs), tree: tree.sha, parents: [s.parent] });
    tip = String(commit.sha);
    // Never forced: a branch that moved since the read refuses here, not over the other change.
    if (s.tip) await api("PATCH", `/repos/${a.repo}/git/refs/heads/${a.branch}`, { sha: tip });
    else await api("POST", `/repos/${a.repo}/git/refs`, { ref: `refs/heads/${a.branch}`, sha: tip });
  } else if (!tip) return { ok: true, text: JSON.stringify({ pr_url: null, tip: null, nothing_to_add: true }) };
  const owner = a.repo.split("/")[0]!;
  const open = (await api("GET", `/repos/${a.repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${a.branch}`)}`)) as { html_url: string }[];
  if (open[0]) return { ok: true, text: JSON.stringify({ pr_url: open[0].html_url, tip }) };
  const pr = await api("POST", `/repos/${a.repo}/pulls`, { title: a.title, body: withFooter(a.body, signedAs), head: a.branch, base: s.def });
  return { ok: true, text: JSON.stringify({ pr_url: pr.html_url, tip }), objects: [`github:${a.repo.toLowerCase()}#${Number(pr.number)}`] };
}
