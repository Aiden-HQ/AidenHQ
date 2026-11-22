// github.setup (module.yaml writes.setup): a reviewed setup PR for another module (code review's deepsec setup). The code host
// files this record itself when the kernel brokers the `setup` op (service.ts setupOp) and runs it only once the record is
// approved, so what is pushed is exactly the approved repo, branch, tip and files. One commit adds the allowlisted files the
// repo is missing (never overwriting one), on the branch's tip or, for a new branch, the default branch's head (never the commit a
// review read). It is always a branch and a PR, in every org; nothing here merges. The whole PR diff against the default branch
// must hold allowlisted paths only, or it refuses. The grant's path globs (`*` is one path segment) come with the args.
import { withFooter, withTrailer } from "./aidenhq-sdk/attribution.ts";

export type Api = (method: string, path: string, body?: unknown) => Promise<any>;
export type SetupArgs = { repo: string; branch: string; expected_tip: string | null; files: Record<string, string>; allow: string[]; title: string; body: string; base_head?: string };
const fail = (status: number, message: string) => Object.assign(new Error(message), { status });
const enc = (path: string) => path.split("/").map(encodeURIComponent).join("/");
const SHA = /^[0-9a-f]{40}$/;
const COMMIT = "mutation($input: CreateCommitOnBranchInput!) { createCommitOnBranch(input: $input) { commit { oid } } }";
/** The most the files may weigh, serialised: the kernel checks the same (codehost.ts), and an executor request holds 1 MB in all. */
export const SETUP_BYTES = 800_000;

/** A grant path as a matcher: literal, except `*` is one path segment. */
export const globs = (allow: string[]) => allow.map((g) => new RegExp(`^${g.split("*").map((x) => x.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[\\w.-]+")}$`));

/** The args, checked again here: the record is the authority, whatever filed it. */
export function check(a: SetupArgs): SetupArgs {
  if (!/^[\w.-]+\/[\w.-]+$/.test(String(a.repo))) throw fail(400, `${String(a.repo)} is not owner/name`);
  if (!/^aidenhq\/[\w.-]{1,80}$/.test(String(a.branch))) throw fail(400, "the branch is aidenhq/<name>");
  if (a.expected_tip !== null && !SHA.test(String(a.expected_tip))) throw fail(400, "expected_tip is a commit sha or null");
  if (a.base_head !== undefined && !SHA.test(String(a.base_head))) throw fail(400, "base_head is a commit sha");
  const paths = Object.keys(a.files ?? {});
  if (!paths.length || paths.length > 8 || !Array.isArray(a.allow) || !a.allow.length) throw fail(400, "files is 1 to 8 paths, with the grant's allowlist");
  if (Buffer.byteLength(JSON.stringify(a.files)) > SETUP_BYTES) throw fail(413, `the setup files are at most ${SETUP_BYTES} bytes in all`);
  const ok = globs(a.allow);
  for (const p of paths) if (!/^[\w.][\w./-]{0,499}$/.test(p) || p.split("/").some((x) => /^\.+$/.test(x)) || !ok.some((re) => re.test(p))) throw fail(403, `${p.slice(0, 200)} isn't an allowed setup path`);
  return a;
}

/** The repo's default branch and its head, the branch's tip (null: no such branch) and which files the parent lacks. */
async function read(api: Api, a: SetupArgs) {
  const owner = a.repo.split("/")[0]!;
  const def = String((await api("GET", `/repos/${a.repo}`)).default_branch ?? "");
  if (!def) throw fail(502, `${a.repo} has no default branch`);
  if (def === a.branch) throw fail(409, `${a.branch} is ${a.repo}'s default branch: a setup only opens a pull request into it`);
  const head = String((await api("GET", `/repos/${a.repo}/branches/${enc(def)}`)).commit?.sha ?? "");
  const tip = await api("GET", `/repos/${a.repo}/branches/${enc(a.branch)}`).then((b) => String(b.commit?.sha ?? ""), (e: Error) => { if (/ 404\b/.test(e.message)) return null; throw e; });
  if (tip !== a.expected_tip) throw fail(409, `${a.branch} is at ${tip ? tip.slice(0, 12) : "nothing"}, not ${a.expected_tip ? a.expected_tip.slice(0, 12) : "a new branch"}: ask again`);
  const parent = tip ?? head;
  // What the branch already carries against the default branch head it read (by sha, never the moving branch name, so the diff, the path tier and the bound head are one snapshot): the reviewer reads it whole with the files to add, and the push
  // refuses any path outside the allowlist; the record binds the tip, so what runs is what was read.
  const carried: { filename: string; previous_filename?: string; status?: string; patch?: string }[] = [];
  if (tip) {
    const cmp = await api("GET", `/repos/${a.repo}/compare/${head}...${tip}`);
    const files = (cmp.files ?? []) as typeof carried;
    if (files.length >= 300) throw fail(409, `${a.branch}'s diff is too large to verify`);
    // Every file reaching a box is read by the reviewer: one GitHub gives no text for (binary, too large, a bare rename) can't be, so
    // the branch is refused until it is reset.
    const unread = files.find((f) => typeof f.patch !== "string");
    if (unread) throw fail(409, `${a.branch} carries ${unread.filename} with no text diff the reviewer could read: reset the branch (delete it) and ask again`);
    carried.push(...files);
  }
  // Any open PR from the branch must be into the default branch: one into another base refuses, never reused or sidestepped.
  const open = tip ? ((await api("GET", `/repos/${a.repo}/pulls?state=open&head=${encodeURIComponent(`${owner}:${a.branch}`)}`)) as { html_url: string; base?: { ref?: string } }[]) : [];
  const other = open.find((p) => p.base?.ref !== def);
  if (other) throw fail(409, `${a.branch} already has a pull request into ${other.base?.ref ?? "another branch"}, not ${def}: ${other.html_url}`);
  const missing: string[] = [];
  for (const p of Object.keys(a.files)) {
    const has = await api("GET", `/repos/${a.repo}/contents/${enc(p)}?ref=${parent}`).then(() => true, (e: Error) => { if (/ 404\b/.test(e.message)) return false; throw e; });
    if (!has) missing.push(p);
  }
  return { def, head, tip, parent, missing, carried, into: open[0] };
}

/** The plan: what the reviewer reads (the files to add, whole) and what the record binds (the branch's tip and the base's head). */
export async function plan(api: Api, input: SetupArgs, leak?: (text: string) => string | undefined) {
  const a = check(input);
  const s = await read(api, a);
  const bad = leak?.(`${a.title}\n${a.body}`);
  if (bad) throw fail(422, `Not done: the PR title or description mentions "${bad}"; reword it and ask again.`);
  const add = s.missing;
  // The reviewed default-branch head goes into the record's args: what runs is off exactly that head, or it refuses.
  const bound: SetupArgs = { ...a, base_head: s.head };
  const diff = [
    ...s.carried.map((f) => `--- already on ${a.branch}: ${f.filename} (${f.status ?? "changed"}${f.previous_filename ? `, from ${f.previous_filename}` : ""}) ---\n${f.patch ?? "(no text diff)"}`),
    ...add.map((p) => `--- new file ${p} ---\n${a.files[p]}`),
    `--- the pull request as it will be published ---\n${a.title}\n\n${a.body}`,
  ].join("\n\n");
  return {
    args: bound,
    // The files this changes, as push and PR plans return them: the kernel raises the tier by the path inventory.
    paths: [{ repo: a.repo, files: [...new Set([...s.carried.flatMap((f) => [f.filename, f.previous_filename].filter(Boolean) as string[]), ...add])].map((path) => ({ path })) }],
    targets: { [`${a.repo} ${a.branch}`]: { repo: a.repo, ref: a.branch, commit: s.tip, base_sha: s.head } },
    facts: {
      target: `${a.repo} ${a.branch}`,
      sentence: add.length
        ? `Add ${add.length} setup file${add.length === 1 ? "" : "s"} (${add.join(", ")}) to ${a.repo} on \`${a.branch}\` (${s.tip ? `from its tip ${s.tip.slice(0, 12)}` : `new, off ${s.def} at ${s.head.slice(0, 12)}`}) and open a pull request "${a.title}" into ${s.def}. Nothing is merged; files the repo already has are never overwritten.`
        : s.tip && (s.into || s.carried.length)
        ? `Open a pull request "${a.title}" from \`${a.branch}\` into ${s.def} on ${a.repo}: every setup file is already there, so no commit is made.`
        : `Nothing to do on ${a.repo}: ${s.def} already has every setup file, so no branch and no pull request are made.`,
      diff,
    },
  };
}

/** The approved write. Refuses when the branch moved or the PR's whole diff would hold a path outside the allowlist. */
export async function run(api: Api, input: SetupArgs, signedAs = "Aiden"): Promise<{ ok: boolean; text: string; objects?: string[] }> {
  const a = check(input);
  const s = await read(api, a);
  if (a.base_head !== s.head) throw fail(409, `${s.def} moved from the ${a.base_head ? a.base_head.slice(0, 12) : "unrecorded"} head the setup was reviewed on to ${s.head.slice(0, 12)}: ask again`);
  const ok = globs(a.allow);
  // The PR's whole diff against the default branch: what the branch already carries plus what this commit adds.
  const carried = s.carried.flatMap((f) => [f.filename, f.previous_filename].filter(Boolean) as string[]);
  const out = [...carried, ...s.missing].find((p) => !ok.some((re) => re.test(p)));
  if (out) return { ok: false, text: `Refused: the pull request would change ${out}, which isn't an allowed setup path.` };
  const into = s.into;
  let tip = s.tip;
  if (s.missing.length) {
    // The commit is made by GitHub's createCommitOnBranch with expectedHeadOid, a real compare-and-swap: it refuses when the branch is
    // anywhere but the reviewed parent (the tip, or for a new branch the reviewed default-branch head the ref is created at).
    if (!s.tip) await api("POST", `/repos/${a.repo}/git/refs`, { ref: `refs/heads/${a.branch}`, sha: s.parent });
    const [headline, ...rest] = withTrailer(`Add the setup files (${s.missing.join(", ")})`, signedAs).split("\n");
    const r = await api("POST", "/graphql", { query: COMMIT, variables: { input: {
      branch: { repositoryNameWithOwner: a.repo, branchName: a.branch }, expectedHeadOid: s.parent,
      message: { headline: headline!, body: rest.join("\n").trim() },
      fileChanges: { additions: s.missing.map((path) => ({ path, contents: Buffer.from(a.files[path]!).toString("base64") })) } } } });
    if (r?.errors?.length) throw fail(409, `${a.branch} wasn't committed to (it moved from ${s.parent.slice(0, 12)}, or GitHub refused): ${String(r.errors[0]?.message ?? "").slice(0, 200)}: ask again`);
    tip = String(r?.data?.createCommitOnBranch?.commit?.oid ?? "");
    if (!SHA.test(tip)) throw fail(502, "GitHub named no commit for the setup files");
  } else if (!tip || (!into && !s.carried.length)) return { ok: true, text: JSON.stringify({ pr_url: null, tip, nothing_to_add: true }) };
  if (into) return { ok: true, text: JSON.stringify({ pr_url: into.html_url, tip }) };
  // The PR opens from whatever the branch holds then: it is bound to the reviewed tip by checking the opened PR's head (the branch can move
  // between the read and this call) and closing it unreported when another writer got in.
  const pr = await api("POST", `/repos/${a.repo}/pulls`, { title: a.title, body: withFooter(a.body, signedAs), head: a.branch, base: s.def });
  if (String(pr.head?.sha ?? "") !== tip) {
    await api("PATCH", `/repos/${a.repo}/pulls/${Number(pr.number)}`, { state: "closed" });
    throw fail(409, `${a.branch} moved from ${String(tip).slice(0, 12)} to ${String(pr.head?.sha ?? "").slice(0, 12)} while the pull request opened (closed ${pr.html_url}): ask again`);
  }
  return { ok: true, text: JSON.stringify({ pr_url: pr.html_url, tip }), objects: [`github:${a.repo.toLowerCase()}#${Number(pr.number)}`] };
}
