// The on-server code host (docs/design/codehost-local.md §3-§5): the org `local`'s repositories are bare repos under
// <data dir>/codehost/<org>/<name>.git, written only by the runner (the data dir is hidden from every job). A change
// request is git refs in its bare repo, never a database:
//   refs/changes/<n>/head    the change's current head       refs/changes/<n>/merged  the squash commit, once merged
//   refs/changes/<n>/base    the base tip it was opened on   refs/changes/<n>/closed  written when it is closed
//   refs/changes/<n>/meta    a blob { title, body, branch, base, task, opened_at, draft }
// Checks are a receipt in `git notes --ref=checks` on the head commit: [{ name, change, base, ok, pending?, at, log_tail }].
// Each entry is keyed by the change and the base it was run against as well as the head (the note's commit), so a run of the
// same head for another change or another base never stands in for this one; a missing check is not passed. The merge is landOnMain's squash, pushed to the bare repo
// without force: receive-pack's ref lock refuses a non-fast-forward, so that push is the compare-and-swap.
//
// `host(deps)` returns the code host role's shape (codehost-github/src/host.mjs documents it) plus the local extras the
// runner and the apps platform read: changes(slug), updateChange(slug, n, fields), writeCheck(slug, sha, entry).
import { execFile } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { ISOLATED_ENV, SAFE_GIT_ARGS, ensureClone, git, landOnMain } from "../../codehost-github/src/git.mjs";
import { DEFAULT_IDENTITY, identityEnv } from "../../codehost-github/src/github-app.ts";

const run = promisify(execFile);
/** The org this host owns (codehost-github's plan.mjs tiers it as an agents org). */
export const LOCAL_ORG = "local";
const ZERO = "0".repeat(40);
const SEGMENT = /^[a-z0-9][a-z0-9._-]{0,99}$/i;
const SHA = /^[0-9a-f]{40}$/;
// A ref and a repo path `read` takes: no option, no revision syntax beyond a plain name.
const SAFE_REF = /^(?!-)[A-Za-z0-9._\/-]{1,200}$/;
const SAFE_PATH = /^(?![-/])(?!.*\.\.)[A-Za-z0-9._\/-]{1,300}$/;
/** The checks a change needs green on its head before it merges (the CI template's `tests` and `secrets` jobs). */
export const REQUIRED = ["tests", "secrets"];
/** A change request's URL (kernel/src/kinds.ts accepts it beside a GitHub PR's). */
export const changeUrl = (slug, n) => `codehost:${slug}/change/${n}`;
const URL_RE = /^codehost:([\w.-]+\/[\w.-]+)\/change\/(\d+)$/;
/** { slug, number } of a change request's URL, or undefined. */
export function parseChangeUrl(url) {
  const m = URL_RE.exec(String(url ?? "").trim());
  return m ? { slug: m[1], number: Number(m[2]) } : undefined;
}

/**
 * deps: { dataDir (the instance's data dir: repos live in <dataDir>/codehost), workDir (the runner's: its cache clones under
 * repos/), repoSources (slug → a bare repo elsewhere: setup's local/aidenhq-instance), identity (commit author) }.
 */
export function host({ dataDir, workDir, repoSources = {}, identity = DEFAULT_IDENTITY } = {}) {
  const root = join(dataDir, "codehost");
  const parts = (slug) => {
    const [org, name, ...rest] = String(slug).split("/");
    if (rest.length || !SEGMENT.test(org ?? "") || !SEGMENT.test(name ?? "") || name.endsWith(".git") || /^\.+$/.test(name)) throw new Error(`not a repository: ${slug}`);
    return { org, name, slug: `${org}/${name}` };
  };
  const bare = (slug) => repoSources[slug] ?? join(root, parts(slug).org, `${parts(slug).name}.git`);
  const env = { ...ISOLATED_ENV, ...identityEnv(identity) };
  const g = (slug, args, input) => {
    const p = run("git", [...SAFE_GIT_ARGS, "--git-dir", bare(slug), ...args], { env, maxBuffer: 32 * 1024 * 1024 });
    if (input !== undefined) p.child.stdin.end(input);
    return p.then((o) => o.stdout.trim());
  };
  const rev = (slug, ref) => g(slug, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).catch(() => "");
  const blob = (slug, text) => g(slug, ["hash-object", "-w", "--stdin"], text);
  // The runner is the only writer: one write at a time per repo (change numbers, notes) inside this process.
  const locks = new Map();
  const locked = (slug, fn) => {
    const prev = locks.get(slug) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    locks.set(slug, next.catch(() => {}));
    return next;
  };
  const numbers = async (slug) => [...new Set((await g(slug, ["for-each-ref", "--format=%(refname)", "refs/changes/"])).split("\n").map((r) => Number(/^refs\/changes\/(\d+)\//.exec(r)?.[1])).filter((n) => n > 0))].sort((a, b) => a - b);
  const meta = async (slug, n) => JSON.parse((await g(slug, ["cat-file", "blob", `refs/changes/${n}/meta`]).catch(() => "")) || "{}");
  const transaction = (slug, lines) => g(slug, ["update-ref", "--stdin"], `start\n${lines.join("\n")}\nprepare\ncommit\n`);

  const self = {
    name: "codehost-local",
    orgs: [LOCAL_ORG],
    bare,
    async source(slug) {
      return bare(slug);
    },
    async exists(slug) {
      return existsSync(join(bare(slug), "HEAD")) && existsSync(join(bare(slug), "objects"));
    },
    async defaultBranch(slug) {
      return (await g(slug, ["symbolic-ref", "HEAD"])).replace(/^refs\/heads\//, "");
    },
    /** A new bare repo with a README on main; refs/heads/main is created only if absent, so an existing repo is never touched. */
    async createRepo(slug) {
      const { org, name } = parts(slug);
      if (await self.exists(slug)) return "exists";
      mkdirSync(join(root, org), { recursive: true });
      await run("git", [...SAFE_GIT_ARGS, "init", "--quiet", "--bare", "-b", "main", bare(slug)], { env });
      const readme = await blob(slug, `# ${name}\n`);
      const tree = await g(slug, ["mktree"], `100644 blob ${readme}\tREADME.md\n`);
      const commit = await g(slug, ["commit-tree", tree, "-m", "Initial commit"]);
      await g(slug, ["update-ref", "refs/heads/main", commit, ZERO]);
      return "created";
    },
    /** Push `sha` from the clone at `path` to the branch: fast-forward only, or replacing exactly `lease`. */
    async publish({ path, slug, sha, branch, lease }) {
      await git(path, "push", "--quiet", "--no-verify", ...(lease ? [`--force-with-lease=refs/heads/${branch}:${lease}`] : []), bare(slug), `${sha}:refs/heads/${branch}`);
    },
    /**
     * Opens a change request for `branch` into `base`, or, when the branch already has an open one, moves that one to the
     * branch's tip (and its text, when given). Returns { number, url }.
     */
    openChange({ slug, branch, base, title, body, task, draft = true }) {
      return locked(slug, async () => {
        const head = await rev(slug, `refs/heads/${branch}`);
        if (!head) throw new Error(`${slug} has no branch ${branch}`);
        for (const n of (await numbers(slug)).reverse()) {
          const m = await meta(slug, n);
          if (m.branch === branch && (await self.readChange(slug, n)).state === "open") {
            await self.updateChange(slug, n, { head, ...(title ? { title, body } : {}) }, true);
            return { number: n, url: changeUrl(slug, n) };
          }
        }
        const baseSha = await rev(slug, `refs/heads/${base}`);
        if (!baseSha) throw new Error(`${slug} has no branch ${base}`);
        const n = ((await numbers(slug)).at(-1) ?? 0) + 1;
        const m = await blob(slug, JSON.stringify({ title: String(title ?? branch), body: String(body ?? ""), branch, base, task: task ?? null, opened_at: new Date().toISOString(), draft }));
        await transaction(slug, [`create refs/changes/${n}/head ${head}`, `create refs/changes/${n}/base ${baseSha}`, `create refs/changes/${n}/meta ${m}`]);
        return { number: n, url: changeUrl(slug, n) };
      });
    },
    /**
     * Moves an open change's head (and its base to its target branch's tip now, so a rebased change shows only its own
     * work) and/or rewrites its title, body or draft flag.
     */
    updateChange(slug, n, { head, ...fields }, held = false) {
      const work = async () => {
        if ((await self.readChange(slug, n)).state !== "open") throw new Error(`${changeUrl(slug, n)} isn't open`);
        const lines = [];
        if (head) {
          if (!SHA.test(head)) throw new Error("not a commit");
          lines.push(`update refs/changes/${n}/head ${head}`);
          const into = await rev(slug, `refs/heads/${(await meta(slug, n)).base}`);
          if (into) lines.push(`update refs/changes/${n}/base ${into}`);
        }
        const keep = Object.fromEntries(Object.entries(fields).filter(([k, v]) => ["title", "body", "draft"].includes(k) && v !== undefined));
        if (Object.keys(keep).length) lines.push(`update refs/changes/${n}/meta ${await blob(slug, JSON.stringify({ ...(await meta(slug, n)), ...keep }))}`);
        if (lines.length) await transaction(slug, lines);
      };
      return held ? work() : locked(slug, work);
    },
    async readChange(slug, n) {
      const head = await rev(slug, `refs/changes/${n}/head`);
      if (!head) throw new Error(`${changeUrl(slug, n)} doesn't exist`);
      const base = await rev(slug, `refs/changes/${n}/base`);
      const merged = await rev(slug, `refs/changes/${n}/merged`);
      const closed = merged ? "" : await rev(slug, `refs/changes/${n}/closed`);
      const m = await meta(slug, n);
      const files = (await g(slug, ["-c", "core.quotePath=false", "diff", "--no-ext-diff", "--no-textconv", "--name-only", `${base}...${head}`])).split("\n").filter(Boolean);
      return { number: n, url: changeUrl(slug, n), state: merged ? "merged" : closed ? "closed" : "open", head, base, branch: m.branch, into: m.base, files, title: m.title, body: m.body, draft: m.draft, task: m.task, opened_at: m.opened_at, ...(merged ? { merged } : {}) };
    },
    /** One file's text at `ref` (a branch or commit); throws when there is none. */
    async read(slug, ref, path) {
      if (!SAFE_REF.test(ref) || !SAFE_PATH.test(path)) throw new Error("not a ref or a path");
      return g(slug, ["show", `${ref}:${path}`]);
    },
    /** Every change request of the repo, newest first (state: open, merged or closed). */
    async changes(slug) {
      return Promise.all((await numbers(slug)).reverse().map((n) => self.readChange(slug, n)));
    },
    /** The change's diff, base...head; `head`: the commit a card is bound to (never whatever the change's ref says by now). */
    async diff(slug, n, { head } = {}) {
      const c = await self.readChange(slug, n);
      if (head !== undefined && !SHA.test(head)) throw new Error("not a commit");
      return g(slug, ["diff", "--no-ext-diff", "--no-textconv", `${c.base}...${head ?? c.head}`]);
    },
    close(slug, n) {
      return locked(slug, async () => {
        const c = await self.readChange(slug, n);
        if (c.state !== "open") return c.state;
        await transaction(slug, [`create refs/changes/${n}/closed ${c.head}`]);
        return "closed";
      });
    },
    /**
     * The receipt on `sha`: [{ name, ok, pending, skipped }]; nothing when no check ran on it. With `change` and `base`, only
     * the entries run for that change against that base.
     */
    async checks(slug, sha, { change, base } = {}) {
      return (await receipt(slug, sha)).filter((c) => (change === undefined || c.change === change) && (base === undefined || c.base === base)).map((c) => ({ name: c.name, ok: c.ok === true && !c.pending, pending: Boolean(c.pending), skipped: false }));
    },
    /**
     * Writes one check's entry ({ name, change, base, ok, pending?, log_tail? }) into the receipt on `sha`, replacing only the
     * entry of that name for that change and base.
     */
    writeCheck(slug, sha, entry) {
      return locked(slug, async () => {
        if (!SHA.test(sha) || !SHA.test(String(entry.base ?? "")) || !Number.isInteger(entry.change)) throw new Error("a check entry names its change and base");
        const list = (await receipt(slug, sha)).filter((c) => !(c.name === entry.name && c.change === entry.change && c.base === entry.base));
        list.push({ name: String(entry.name), change: entry.change, base: entry.base, ok: entry.ok === true, ...(entry.pending ? { pending: true } : {}), at: new Date().toISOString(), log_tail: String(entry.log_tail ?? "").slice(-4000) });
        await g(slug, ["notes", "--ref=checks", "add", "-f", "-F", "-", sha], JSON.stringify(list));
      });
    },
    /**
     * Squash-merges change n onto its base branch, only while its head is `head` and every `required` check is green in
     * the receipt on that head, run for this change against its current base (`guard(main)`: landOnMain's condition on the exact main it lands on). Returns { sha }, or throws with `code`: head-moved, checks-not-green, conflict, not-open.
     */
    merge(slug, n, head, { required = REQUIRED, note, guard } = {}) {
      return locked(slug, async () => {
        const c = await self.readChange(slug, n);
        const refuse = (code, why) => Object.assign(new Error(why), { code });
        if (c.state !== "open") throw refuse("not-open", `${c.url} is ${c.state}`);
        if (c.head !== head) throw refuse("head-moved", `${c.url} moved since it was asked for: ask again for its new head`);
        const got = await self.checks(slug, head, { change: n, base: c.base });
        const missing = required.filter((name) => !got.some((x) => x.name === name && x.ok));
        if (missing.length) throw refuse("checks-not-green", `${c.url}: ${missing.length} required check(s) not green on the head`);
        const { org, name } = parts(slug);
        const clone = await ensureClone(workDir, { org, name, slug }, bare(slug));
        await git(clone, "fetch", "--quiet", bare(slug), `+refs/changes/${n}/head:refs/aidenhq/change`);
        const sha = await landOnMain(clone, c.into, head, note ?? `${c.title} (change ${n})`, { identity, guard });
        if (!sha) throw refuse("conflict", `${c.url} conflicts with ${c.into} as it is now: rebase it and publish again`);
        await transaction(slug, [`create refs/changes/${n}/merged ${sha}`]);
        await g(slug, ["update-ref", "-d", `refs/heads/${c.branch}`, head]).catch(() => {});
        return { sha };
      });
    },
  };
  async function receipt(slug, sha) {
    const text = await g(slug, ["notes", "--ref=checks", "show", sha]).catch(() => "");
    try {
      const list = JSON.parse(text || "[]");
      return Array.isArray(list) ? list.filter((c) => c && typeof c.name === "string") : [];
    } catch {
      return [];
    }
  }
  return self;
}
