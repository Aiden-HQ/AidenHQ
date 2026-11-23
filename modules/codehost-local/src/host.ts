// The on-server code host (docs/design/codehost-local.md): the org `local`'s repos are bare repos on this host, written only
// by the kernel, which runs this module in process (it has no service). It is the executor of the codehost-local write kinds
// (executor@1's shape, kernel/sdk/src/executor.ts): the kernel files, tiers and revalidates their records as any module's, and
// plan.ts's git rules tier them, as they tier codehost-github's. Host git never runs in, or writes, a workspace: a box
// clones a repo from a bundle the kernel serves (`aidenhq clone`), and a job's commits come back as a bundle (git.ts ingest).
//
// A change request is git refs in its bare repo, never a database (apps-mcp's codehost.ts reads them for previews):
//   refs/changes/<n>/head    its head                      refs/changes/<n>/merged  the squash commit, once merged
//   refs/changes/<n>/base    the default branch's tip when the head last moved    refs/changes/<n>/closed  written when it is closed
//   refs/changes/<n>/opened  the default branch's tip when it was opened (never moved by a push): the grader's base commit
//   refs/changes/<n>/meta    { title, body, branch, base (the branch it merges into), task, opened_at, draft }
// Its URL is codehost:local/<name>/change/<n>. A job's commits come in as a bundle its box wrote (git.ts ingest). A merge needs the change's checks green on its exact head: the `change` check
// job (check_jobs in module.yaml, run in a credential-free box from a snapshot) with a receipt the kernel signed.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { planParts, plan as planRules } from "../../github/service/src/plan.ts";
import { fileContext, numstat } from "../../github/service/src/review-files.ts";
import { SOURCE_EXCEPTIONS_FILE, readCardSourceExceptions } from "../../github/service/src/sources.ts";
import { DEFAULT_CHURN_EXCLUDE, churnFromGit } from "../../../kernel/sdk/src/churn.ts";
import type { FactIn } from "../../../kernel/sdk/src/kernel-client.ts";
import { IDENTITY, bareOf, fail, git, ingest } from "./git.ts";
import { baseMoved, checksNotGreen, headMoved } from "./refuse.ts";

export { LOCAL_KINDS } from "./kinds.ts";

export const LOCAL_ORG = "local";
const ZERO = "0".repeat(40);
const IDENT = /^[A-Za-z][A-Za-z0-9]*-\d+$/;
/** A change request's URL. */
export const changeUrl = (repo: string, n: number) => `codehost:${repo}/change/${n}`;

/** Each change's checks, as plan.ts reads them ({ ok, pending }); the kernel's `change` check job on (repo, head, base). */
/** `retry`: run again a check that couldn't run (a new request); otherwise the one asked for before, as it stands. `summary`: its receipt's. */
export type ChangeChecks = (repo: string, head: string, base: string, retry?: boolean) => Promise<{ ok: boolean; pending: boolean; missing?: boolean; summary?: string }[]>;

export function localHost({ root, sources = {}, tasksDir, scratchDir, instanceRepo, productRepo, checks, fact = () => {}, waitMs = 30 * 60_000 }: {
  /** <data dir>/codehost: the org folders. */ root: string;
  /** Repos kept elsewhere (setup's instance repo): slug → bare git dir. */ sources?: Record<string, string>;
  /** The job workspaces (<work dir>/tasks): commits come in from there and clones go there. */ tasksDir: string;
  scratchDir: string; instanceRepo?: string; productRepo?: string;
  checks: ChangeChecks;
  /** Flow facts (kernel/src/codehost.ts localFacts): the same pr.* facts codehost-github emits, written by the kernel itself. */
  fact?: (f: FactIn) => void;
  /** How long an approved merge waits for its checks to finish. */ waitMs?: number;
}) {
  const bare = (repo: string) => bareOf(root, sources, repo);
  const g = (repo: string, args: string[], o: { input?: string; env?: Record<string, string> } = {}) => git(["--git-dir", bare(repo), ...args], o);
  const rev = (repo: string, ref: string) => g(repo, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`]).catch(() => "");
  const exists = (repo: string) => existsSync(join(bare(repo), "HEAD"));
  const defaultBranch = async (repo: string) => (await g(repo, ["symbolic-ref", "HEAD"])).replace(/^refs\/heads\//, "");
  // One write at a time per repo (change numbers, the merge's compare-and-swap) inside the kernel, the only writer.
  const locks = new Map<string, Promise<unknown>>();
  const locked = <T>(repo: string, fn: () => Promise<T>): Promise<T> => {
    const next = (locks.get(repo.toLowerCase()) ?? Promise.resolve()).then(fn, fn);
    locks.set(repo.toLowerCase(), next.catch(() => {}));
    return next;
  };
  const numbers = async (repo: string) => [...new Set((await g(repo, ["for-each-ref", "--format=%(refname)", "refs/changes/"])).split("\n").map((r) => Number(/^refs\/changes\/(\d+)\//.exec(r)?.[1])).filter((n) => n > 0))].sort((a, b) => a - b);
  const meta = async (repo: string, n: number) => JSON.parse((await g(repo, ["cat-file", "blob", `refs/changes/${n}/meta`]).catch(() => "")) || "{}");
  const refs = (repo: string, lines: string[]) => g(repo, ["update-ref", "--stdin"], { input: `start\n${lines.join("\n")}\nprepare\ncommit\n` });
  const diffText = async (repo: string, from: string, to: string, dir = bare(repo)) => {
    const d = await git(["--git-dir", dir, "-c", "core.attributesFile=/dev/null", "diff", "--no-ext-diff", "--no-textconv", "--text", "--no-renames", from, to], { raw: true });
    return d;
  };
  /** The same change counted by git itself (numstat): the reviewer checks the diff it gets against it (review-files.ts sameChanges). */
  const numstatOf = async (repo: string, from: string, to: string, dir = bare(repo)) => numstat(await git(["--git-dir", dir, "-c", "core.attributesFile=/dev/null", "diff", "--no-ext-diff", "--no-textconv", "--text", "--no-renames", "--numstat", from, to], { raw: true }));

  async function readChange(repo: string, n: number) {
    const head = await rev(repo, `refs/changes/${n}/head`);
    if (!head) throw fail(404, `${changeUrl(repo, n)} doesn't exist`);
    const merged = await rev(repo, `refs/changes/${n}/merged`);
    const closed = merged ? "" : await rev(repo, `refs/changes/${n}/closed`);
    const main = await rev(repo, `refs/heads/${await defaultBranch(repo)}`);
    const base = main ? await g(repo, ["merge-base", main, head]).catch(() => "") : "";
    // The base ref's commit recorded on the change: the default branch's tip when it was opened, as GitHub records `baseRefOid` on
    // a PR and does not move on a push. It is the grader's base commit; `base` above is the merge base and is never substituted.
    // `base` is not it: that ref was rewritten on every push before `opened` existed, so a change without `opened` (legacy) states
    // no base commit rather than passing the tip it was last pushed against off as the one it opened against.
    const baseRef = await rev(repo, `refs/changes/${n}/opened`);
    const files = (await g(repo, ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--name-only", "-z", base || "4b825dc642cb6eb9a060e54bf8d69288fbee4904", head])).split("\0").filter(Boolean);
    return { n, head, base, baseRef, main, files, state: merged ? "merged" : closed ? "closed" : "open", meta: await meta(repo, n) };
  }

  /** A branch's head moved in: fast-forward only on the default branch, a compare-and-swap with what was there on any other. */
  async function moveBranch(repo: string, branch: string, sha: string) {
    const old = await rev(repo, `refs/heads/${branch}`);
    if (old && branch === (await defaultBranch(repo)) && !(await g(repo, ["merge-base", "--is-ancestor", old, sha]).then(() => true, () => false))) throw fail(409, `${repo} \`${branch}\` isn't a fast-forward to ${sha.slice(0, 12)}`);
    await g(repo, ["update-ref", `refs/heads/${branch}`, sha, old || ZERO]);
  }

  /** The change request of `branch` (the open one moves to its new head), else a new one: its URL, its title, and the head an open one had (`before`). */
  function openChange(repo: string, branch: string, head: string, text: { title?: string; body?: string } | undefined, task: string) {
    return locked(repo, async () => {
      const into = await defaultBranch(repo), tip = await rev(repo, `refs/heads/${into}`);
      for (const n of (await numbers(repo)).reverse()) {
        const c = await readChange(repo, n);
        if (c.meta.branch !== branch || c.state !== "open") continue;
        // A push moves the head only: the recorded opening base (`opened`) stays the commit the change was opened against, as
        // GitHub's baseRefOid does, and `base` keeps tracking the tip the merge is checked against.
        // A repo with no default-branch commit yet has no base ref to move (as the creation path below says): git refuses an
        // update to an empty object id.
        const lines = [`update refs/changes/${n}/head ${head}`, ...(tip ? [`update refs/changes/${n}/base ${tip}`] : [])];
        // A republish that names no text, or only blank text, keeps the change's title and description (as on GitHub): a blank
        // body must never replace the one a reader depends on.
        const named = { ...(text?.title?.trim() ? { title: text.title } : {}), ...(text?.body?.trim() ? { body: text.body } : {}) };
        if (Object.keys(named).length) lines.push(`update refs/changes/${n}/meta ${await g(repo, ["hash-object", "-w", "--stdin"], { input: JSON.stringify({ ...c.meta, ...named }) })}`);
        await refs(repo, lines);
        // The title returned is the one the change now has: a blank one kept the stored title, so report that.
        return { url: changeUrl(repo, n), title: String(named.title ?? c.meta.title ?? branch), before: c.head };
      }
      const n = ((await numbers(repo)).at(-1) ?? 0) + 1;
      const first = { title: text?.title?.trim() ? text.title : branch, body: text?.body ?? "" };
      const m = await g(repo, ["hash-object", "-w", "--stdin"], { input: JSON.stringify({ ...first, branch, base: into, task, opened_at: new Date().toISOString(), draft: false }) });
      // `opened` is written once and never moved: it is the commit the change was opened against, which a push leaves alone (as
      // GitHub's baseRefOid does). A repo with no default-branch commit yet has none to record, so neither ref is written then.
      await refs(repo, [`create refs/changes/${n}/head ${head}`, ...(tip ? [`create refs/changes/${n}/base ${tip}`, `create refs/changes/${n}/opened ${tip}`] : []), `create refs/changes/${n}/meta ${m}`]);
      return { url: changeUrl(repo, n), title: first.title, before: undefined as string | undefined };
    });
  }

  /** The change squashed onto the default branch as one commit, a compare-and-swap on its ref; refused on a conflict. */
  function land(repo: string, n: number, head: string, checked?: { base: string; main: string }) {
    return locked(repo, async () => {
      const c = await readChange(repo, n);
      if (c.state !== "open") throw fail(409, `${changeUrl(repo, n)} is ${c.state}`);
      const moved = headMoved(changeUrl(repo, n), c.head, head);
      if (moved) throw fail(409, moved);
      if (!c.base) throw fail(409, `${changeUrl(repo, n)} shares no history with its default branch`);
      // Both the base the checks ran from and the destination commit they ran against: refused, never landed, when either moved.
      // Main can advance without changing the merge base (another change landed on a path this one doesn't touch), which is still
      // a tree nobody checked together; the run asks again and its checks run against what it would now merge onto.
      if (checked !== undefined && (checked.base !== c.base || checked.main !== c.main)) throw fail(409, `${changeUrl(repo, n)}: ${defaultBranch(repo)} moved while its checks ran, so they no longer cover the commit it would merge onto; ask for the merge again`);
      const def = await defaultBranch(repo);
      const tree = await g(repo, ["merge-tree", "--write-tree", `--merge-base=${c.base}`, c.main, head]).catch((e: { code?: number }) => (e.code === 1 ? "" : Promise.reject(e)));
      if (!tree) throw fail(409, `${changeUrl(repo, n)} conflicts with ${def} as it is now: rebase it and publish again`);
      const message = `${String(c.meta.title ?? "").replace(/[\p{Cc}\p{Cf}]/gu, " ").slice(0, 300) || c.meta.branch} (change ${n})\n\n${await g(repo, ["log", "-1", "--format=%B", head])}`;
      const sha = await g(repo, ["commit-tree", tree.split("\n")[0]!, "-p", c.main, "-m", message], { env: IDENTITY });
      // Compare-and-swap on the base ref, and the merged marker, in one transaction: a base that moved under the merge is refused,
      // never overwritten (its checks were run against the base read above, and nobody reviewed a merge onto another), and a
      // commit that reached the default branch always leaves the marker that says the change landed. A marker written on its
      // own could fail after the branch moved, leaving a landed change that still reads open.
      await refs(repo, [`update refs/heads/${def} ${sha} ${c.main}`, `create refs/changes/${n}/merged ${sha}`]).catch(async (e: { code?: number }) => {
        const clash = baseMoved(changeUrl(repo, n), c.main, await rev(repo, `refs/heads/${def}`));
        if (clash) throw fail(409, clash);
        throw e;
      });
      await g(repo, ["update-ref", "-d", `refs/heads/${c.meta.branch}`, head]).catch(() => {});
      return sha;
    });
  }

  const subject = (repo: string, n: number) => `pr:${repo.toLowerCase()}#${n}`;
  /** Churn of the repo's merged changes (the squash commits' `(change N)`), a cursor per repo in <root>/churn.json (kernel/sdk/src/churn.ts).
   * It runs on the kernel's thread, so the first pass reads only the last 500 commits. */
  async function churnLocal(repo: string) {
    const file = join(root, "churn.json");
    const cursors = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
    const key = repo.toLowerCase(), def = await defaultBranch(repo);
    const out = await churnFromGit((args) => g(repo, args), { rev: `refs/heads/${def}`, cursor: cursors[key], first: 500, windowDays: 30, exclude: DEFAULT_CHURN_EXCLUDE, prOf: (m) => { const n = /\(change (\d+)\)\s*$/.exec(m.split("\n")[0]!)?.[1]; return n ? `${key}#${n}` : undefined; } });
    const num = (pr: string) => Number(pr.slice(pr.lastIndexOf("#") + 1));
    const task = async (n: number) => ((await meta(repo, n)).task as string | undefined) ?? null;
    for (const [pr, lines] of Object.entries(out.added)) if (lines && out.fresh(out.mergedAt.get(pr)!)) fact({ type: "code.added", subject: subject(repo, num(pr)), version: "1", at: out.mergedAt.get(pr)!, task: await task(num(pr)), data: { pr, lines } });
    for (const r of out.rewritten) if (out.fresh(out.mergedAt.get(r.by_pr)!)) fact({ type: "code.rewritten", subject: subject(repo, num(r.pr)), version: r.by_pr, at: out.mergedAt.get(r.by_pr)!, task: await task(num(r.pr)), data: r });
    if (out.last) writeFileSync(file, JSON.stringify({ ...cursors, [key]: out.last }));
  }

  const parse = (url: string) => /^codehost:(local\/[\w.-]+)\/change\/(\d+)$/.exec(url);
  const base = (requester?: { roles?: string[] }) => ({ agentsOrgs: [LOCAL_ORG], allowedOrgs: [LOCAL_ORG], instanceRepo, productRepo, requester: { platform: (requester?.roles ?? []).includes("platform-engineer") } });

  /** The verified state plan.ts tiers a request on, and the card's diff: read from the bare repos and the workspace, never the args. */
  async function stateFor(action: string, a: any, requester?: { roles?: string[] }): Promise<{ state: any; target: string; sentence: string; diff: string; reads?: { name: string; read: () => Promise<string> }[]; changed?: { path: string; add?: number; del?: number }[]; bases?: { repo: string; base: string; read: (path: string) => Promise<string> }[] }> {
    // What the reviewer reads beside the diff: each changed file at the reviewed head, and the change's Evidence section.
    const reads: { name: string; read: () => Promise<string> }[] = [];
    const changed: { path: string; add?: number; del?: number }[] = [];
    // The bases the change targets (the repo's default branch here), each with a way to read a file there.
    const bases: { repo: string; base: string; read: (path: string) => Promise<string> }[] = [];
    if (action === "create_repo") return { state: { ...base(requester), repo: String(a.repo) }, target: String(a.repo), sentence: `Create the repository ${a.repo} on this server.`, diff: "" };
    if (action === "merge" || action === "close") {
      const prs = [];
      let diff = "";
      for (const p of a.prs ?? []) {
        if (!exists(p.repo)) throw fail(404, `${p.repo} isn't on this server`);
        const c = await readChange(p.repo, Number(p.number));
        if (c.state !== "open") throw fail(409, `${changeUrl(p.repo, c.n)} is ${c.state}`);
        if (action === "merge") {
          diff += await diffText(p.repo, c.base || "4b825dc642cb6eb9a060e54bf8d69288fbee4904", c.head);
          changed.push(...(await numstatOf(p.repo, c.base || "4b825dc642cb6eb9a060e54bf8d69288fbee4904", c.head)));
          for (const f of c.files) reads.push({ name: `${p.repo} ${f}`, read: () => git(["--git-dir", bare(p.repo), "show", `${c.head}:${f}`], { raw: true }) });
          bases.push({ repo: p.repo, base: c.main ? await defaultBranch(p.repo) : "", read: (path) => g(p.repo, ["show", `${c.main}:${path}`]) });
        }
        prs.push({ repo: p.repo, number: c.n, head: c.head, base: c.base, headMatches: !p.head || p.head === c.head, files: c.files, ownHead: true, dependabot: false, checks: action === "merge" ? (await checks(p.repo, c.head, c.base, true)).map(({ ok, pending }) => ({ ok, pending })) : [] });
      }
      const urls = prs.map((p) => changeUrl(p.repo, p.number)).join(", ");
      return { state: { ...base(requester), prs }, target: urls, sentence: `${action === "merge" ? "Merge" : "Close"} ${urls}${action === "merge" ? " at its approved head, once its checks are green" : ""}.`, diff, reads, changed, bases };
    }
    const branches = [];
    let diff = "";
    for (const b of a.only ?? []) {
      if (!exists(b.repo)) throw fail(404, `${b.repo} isn't on this server: create it first (aidenhq create-repo)`);
      const def = await defaultBranch(b.repo), main = await rev(b.repo, `refs/heads/${def}`);
      // What the rules refuse on the repo and branch alone (the instance or product repo, a branch namespace) is refused before
      // anything is read in: a refused push writes no objects and no refs.
      const early = planParts(action, { ...base(requester), workspace: a.workspace, branches: [{ repo: b.repo, branch: b.branch, sha: b.sha, files: [], defaultBranch: def, empty: !main }] }).flat().find((x: { reject?: boolean }) => x.reject);
      if (early) throw Object.assign(fail(422, early.reason), { rule: early.rule });
      // Planning reads the job's commits into a throwaway repo (the real one's objects as its alternates): only an approved,
      // executed push writes the repo itself.
      const tmp = mkdtempSync(join(scratchDir, "plan-")), dir = join(tmp, "plan.git");
      try {
        await git(["init", "--quiet", "--bare", dir]);
        writeFileSync(join(dir, "objects", "info", "alternates"), `${join(bare(b.repo), "objects")}\n`);
        const ref = await ingest(tasksDir, scratchDir, dir, a.workspace, b);
        const p = (args: string[]) => git(["--git-dir", dir, ...args]);
        const mb = main ? await p(["merge-base", main, ref]).catch(() => "") : "";
        const files = (await p(["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--name-only", "-z", mb || "4b825dc642cb6eb9a060e54bf8d69288fbee4904", b.sha])).split("\0").filter(Boolean);
        diff += await diffText(b.repo, mb || "4b825dc642cb6eb9a060e54bf8d69288fbee4904", b.sha, dir);
        changed.push(...(await numstatOf(b.repo, mb || "4b825dc642cb6eb9a060e54bf8d69288fbee4904", b.sha, dir)));
        bases.push({ repo: b.repo, base: main ? def : "", read: (path) => g(b.repo, ["show", `${main}:${path}`]) });
        // Read now: the throwaway repo goes below.
        for (const f of files) {
          const text = await p(["show", `${b.sha}:${f}`]).catch(() => undefined);
          reads.push({ name: `${b.repo} ${f}`, read: async () => { if (text === undefined) throw new Error("not read"); return text; } });
        }
        branches.push({ repo: b.repo, branch: b.branch, sha: b.sha, base: mb || undefined, files, defaultBranch: def, empty: !main });
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    }
    const names = branches.map((b) => `${b.repo} \`${b.branch}\``).join(", ");
    return { state: { ...base(requester), workspace: a.workspace, branches }, target: names, sentence: `${action === "pr" ? "Publish and open a change request for" : "Push"} ${names}.`, diff, reads, changed, bases };
  }

  /**
   * Waits until the change's checks are all green on this head and base (""), or refuses with why they aren't: a missing
   * check, a red one, or a run that didn't finish in the wait (refuse.ts `checksNotGreen`, the same rule plan.ts names).
   */
  async function green(repo: string, head: string, baseSha: string) {
    for (const until = Date.now() + waitMs; ;) {
      const cs = await checks(repo, head, baseSha, true);
      if (cs.length && cs.every((c) => c.ok)) return "";
      const why = checksNotGreen(cs, Date.now() > until);
      // Still green-able: nothing red or missing yet, so wait for the run.
      if (!why) { await new Promise((r) => setTimeout(r, 2000)); continue; }
      return why;
    }
  }

  const executor = {
    async plan(req: { kind: string; args: any; requester?: { roles?: string[] }; revalidate?: boolean }) {
      const action = String(req.kind).replace(/^codehost-local\./, "");
      const s = await stateFor(action, req.args ?? {}, req.requester);
      // plan.ts's rules, as codehost-github's: the bare action, so it reads the same parts.
      const planned = planRules({ kind: action, args: req.args }, s.state, { target: s.target, sentence: s.sentence, diff: s.diff });
      // The reviewer's context goes with the filing only, as codehost-github's (every changed file read whole).
      if (req.revalidate) return planned;
      const sources = await readCardSourceExceptions(s.bases ?? [], (repo: string, base: string) => s.bases!.find((b) => b.repo === repo && b.base === base)!.read(SOURCE_EXCEPTIONS_FILE));
      if (!s.reads?.length && !s.changed?.length && !sources) return planned;
      const files = [];
      for (const f of s.reads ?? []) files.push({ name: f.name, text: await f.read().catch(() => undefined) });
      return { ...planned, review: { ...(files.length || s.changed?.length ? { files: { ...fileContext(files), ...(s.changed?.length ? { changed: s.changed } : {}) } } : {}), ...(sources ? { sources } : {}) } };
    },
    async execute(rec: { kind: string; args: any }) {
      const a = rec.args ?? {}, action = rec.kind.replace(/^codehost-local\./, "");
      const done: string[] = [];
      if (action === "create_repo") {
        const repo = String(a.repo);
        if (exists(repo)) return { ok: true, text: `${repo}: exists` };
        mkdirSync(join(root, LOCAL_ORG), { recursive: true });
        await git(["init", "--quiet", "--bare", "-b", "main", bare(repo)]);
        const readme = await g(repo, ["hash-object", "-w", "--stdin"], { input: `# ${repo.split("/")[1]}\n` });
        const tree = await g(repo, ["mktree"], { input: `100644 blob ${readme}\tREADME.md\n` });
        await g(repo, ["update-ref", "refs/heads/main", await g(repo, ["commit-tree", tree, "-m", "Initial commit"], { env: IDENTITY }), ZERO]);
        return { ok: true, text: `${repo}: created` };
      }
      if (action === "push" || action === "pr") {
        for (const b of a.only) {
          await ingest(tasksDir, scratchDir, bare(b.repo), a.workspace, b);
          await moveBranch(b.repo, b.branch, b.sha);
          if (action === "pr") {
            const { url, title, before } = await openChange(b.repo, b.branch, b.sha, a.text, a.workspace);
            done.push(url);
            const n = Number(url.slice(url.lastIndexOf("/") + 1)), at = new Date().toISOString();
            // Every change here is an agent's write (author_kind agent); the author is the head commit's.
            const author = (await g(b.repo, ["log", "-1", "--format=%an", b.sha]).catch(() => "")) || IDENTITY.GIT_AUTHOR_NAME;
            if (!before) fact({ type: "pr.opened", subject: subject(b.repo, n), version: "2", at, task: a.workspace, data: { repo: b.repo.toLowerCase(), number: n, head: b.sha, branch: b.branch, title, author, author_kind: "agent" } });
            else if (before !== b.sha) fact({ type: "pr.pushed", subject: subject(b.repo, n), version: b.sha, at, task: a.workspace, data: { head: b.sha, before, forced: !(await g(b.repo, ["merge-base", "--is-ancestor", before, b.sha]).then(() => true, () => false)), author } });
            fact({ type: "pr.checks_started", subject: `${subject(b.repo, n)}@${b.sha}`, version: `${b.sha}:1`, at, task: a.workspace, data: { head: b.sha } });
            // Its checks start now, so the merge rarely waits.
            const main = await rev(b.repo, `refs/heads/${await defaultBranch(b.repo)}`);
            // A default branch that shares no history with the head (it got its first commit elsewhere after the change
            // opened) has no merge base: read it as readChange does, "" rather than failing the publish that already moved the refs.
            if (main) void checks(b.repo, b.sha, await g(b.repo, ["merge-base", main, b.sha]).catch(() => ""), true).catch(() => {});
          } else done.push(`${b.repo} ${b.branch} at ${b.sha.slice(0, 12)}`);
        }
        return { ok: true, text: `${action === "pr" ? "Change requests" : "Pushed"}: ${done.join(", ")}` };
      }
      if (action === "merge") {
        const merged: { repo: string; number: number; head: string; sha: string }[] = [];
        // The evidence line for whatever landed, on a failure as much as on success: a batch that landed one change before the
        // next failed must not read as "nothing merged".
        const evidence = () => (merged.length ? `merged-prs: ${JSON.stringify(merged)}\n` : "");
        // Every failure path through the batch carries the evidence: a read of a later change, its checks, or its land.
        const failed = (why: string) => new Error(`${evidence()}${why}`);
        try {
          for (const p of a.prs) {
            const c = await readChange(p.repo, Number(p.number));
            const t0 = Date.now(), task = (c.meta.task as string | undefined) ?? null;
            const why = await green(p.repo, p.head, c.base);
            const at = new Date().toISOString();
            // A wait on the checks, and CI's end on this head (the same facts as codehost-github's merge queue).
            if (Date.now() - t0 > 2000) { const since = new Date(t0).toISOString(); fact({ type: "work.waiting", subject: subject(p.repo, c.n), version: since, at: since, task, data: { reason: "checks" } }); fact({ type: "work.resumed", subject: subject(p.repo, c.n), version: since, at, task, data: { reason: "checks" } }); }
            fact({ type: "pr.checks_completed", subject: `${subject(p.repo, c.n)}@${p.head}`, version: `${p.head}:1`, at, task, data: { head: p.head, conclusion: why ? "failure" : "success", failed: why ? ["checks"] : [] } });
            // A batch that landed some of its PRs before one refused still reports them as merged: the evidence line comes first,
            // as the success text's does, so a run reading the outcome knows which heads did land.
            if (why) return { ok: false, text: `${evidence()}${changeUrl(p.repo, c.n)}: nothing merged${done.length ? ` after ${done.join(", ")}` : ""}; its checks on ${String(p.head).slice(0, 12)} ${why}` };
            const sha = await land(p.repo, c.n, p.head, { base: c.base, main: c.main });
            fact({ type: "pr.merged", subject: subject(p.repo, c.n), version: p.head, at: new Date().toISOString(), task: (c.meta.task as string | undefined) ?? null, data: { sha, head: p.head } });
            void churnLocal(p.repo).catch(() => {}); // churn never delays or fails a merge
            merged.push({ repo: p.repo, number: c.n, head: p.head, sha });
            done.push(`${changeUrl(p.repo, c.n)} as ${sha.slice(0, 12)}`);
          }
        } catch (e) {
          throw failed(`${(e as Error).message.slice(0, 300)}`);
        }
        // The first line as codehost-github's merge queue writes it (merges.ts MERGED_LINE): what the grader reads as merged.
        return { ok: true, text: `${evidence()}Merged: ${done.join(", ")}` };
      }
      if (action === "close") {
        for (const p of a.prs) {
          await locked(p.repo, async () => {
            const c = await readChange(p.repo, Number(p.number));
            if (c.state === "open") {
              await refs(p.repo, [`create refs/changes/${c.n}/closed ${c.head}`]);
              fact({ type: "pr.closed", subject: subject(p.repo, c.n), version: c.head, at: new Date().toISOString(), task: (c.meta.task as string | undefined) ?? null, data: { merged: false } });
            }
          });
          done.push(changeUrl(p.repo, Number(p.number)));
        }
        return { ok: true, text: `Closed: ${done.join(", ")}` };
      }
      return { ok: false, text: `no such kind ${rec.kind}` };
    },
  };

  /** The org `local`'s repos: the bare repos under the root, setup's instance repo included where sources names it. */
  async function repos() {
    const out: string[] = [];
    if (existsSync(root)) for (const org of readdirSync(root, { withFileTypes: true })) {
      if (!org.isDirectory() || org.name.toLowerCase() !== LOCAL_ORG) continue;
      for (const e of readdirSync(join(root, org.name), { withFileTypes: true })) {
        const name = e.name.endsWith(".git") ? e.name.slice(0, -4) : "";
        if (e.isDirectory() && name && existsSync(join(root, org.name, e.name, "HEAD"))) out.push(`${org.name}/${name}`);
      }
    }
    for (const repo of Object.keys(sources)) if (!out.includes(repo) && existsSync(join(bare(repo), "HEAD"))) out.push(repo);
    return out;
  }
  /** The changes still open (a head ref, no merged and no closed ref), each with its head, base and checks as they stand now. */
  async function open() {
    const out: { repo: string; number: number; url: string; head: string; base: string; task?: string; title?: string; checks: { ok: boolean; pending: boolean; missing?: boolean; summary?: string }[] }[] = [];
    for (const repo of await repos()) for (const n of (await numbers(repo)).reverse()) {
      const c = await readChange(repo, n);
      if (c.state !== "open") continue;
      out.push({ repo, number: c.n, url: changeUrl(repo, c.n), head: c.head, base: c.base, ...(typeof c.meta.task === "string" ? { task: c.meta.task } : {}), ...(typeof c.meta.title === "string" ? { title: c.meta.title } : {}), checks: await checks(repo, c.head, c.base) });
    }
    return out;
  }

  return {
    executor,
    bare,
    parse,
    open,
    checks,
    /** One change's state as its refs say it: head, merge base, recorded opening base (`""` for a legacy change) and its words. */
    readChange,
    /**
     * `repo`'s branches as a git bundle in the kernel's scratch, for a job's box to clone itself (`aidenhq clone`): the kernel
     * only serves the bytes, and never writes a workspace. Call `done` once it is sent.
     */
    async bundle(repo: string) {
      if (!exists(repo)) throw fail(404, `${repo} isn't on this server`);
      const tmp = mkdtempSync(join(scratchDir, "bundle-")), file = join(tmp, "repo.bundle");
      try { await g(repo, ["bundle", "create", "--quiet", file, "HEAD", "--branches"]); } catch (e) { rmSync(tmp, { recursive: true, force: true }); throw e; }
      return { file, done: () => rmSync(tmp, { recursive: true, force: true }) };
    },
  };
}
export type LocalHost = ReturnType<typeof localHost>;
