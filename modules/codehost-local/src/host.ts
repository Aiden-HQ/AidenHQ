// The on-server code host (docs/design/codehost-local.md): the org `local`'s repos are bare repos on this host, written only
// by the kernel, which runs this module in process (it has no service). It is the executor of the codehost-local write kinds
// (executor@1's shape, kernel/sdk/src/executor.ts): the kernel files, tiers and revalidates their records as any module's, and
// plan.mjs's git rules tier them, as they tier codehost-github's. Host git never runs in, or writes, a workspace: a box
// clones a repo from a bundle the kernel serves (`aidenhq clone`), and a job's commits come back as a bundle (git.ts ingest).
//
// A change request is git refs in its bare repo, never a database (apps-mcp's codehost.ts reads them for previews):
//   refs/changes/<n>/head    its head                      refs/changes/<n>/merged  the squash commit, once merged
//   refs/changes/<n>/base    the default branch's tip when it last moved          refs/changes/<n>/closed  written when it is closed
//   refs/changes/<n>/meta    { title, body, branch, base (the branch it merges into), task, opened_at, draft }
// Its URL is codehost:local/<name>/change/<n>. A job's commits come in as a bundle its box wrote (git.ts ingest). A merge needs the change's checks green on its exact head: the `change` check
// job (check_jobs in module.yaml, run in a credential-free box from a snapshot) with a receipt the kernel signed.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { planParts, plan as planRules } from "../../codehost-github/service/src/plan.mjs";
import { DEFAULT_CHURN_EXCLUDE, churnFromGit } from "../../../kernel/sdk/src/churn.ts";
import type { FactIn } from "../../../kernel/sdk/src/kernel-client.ts";
import { IDENTITY, bareOf, fail, git, ingest } from "./git.ts";

export const LOCAL_ORG = "local";
const ZERO = "0".repeat(40);
const IDENT = /^[A-Za-z][A-Za-z0-9]*-\d+$/;
/** A change request's URL. */
export const changeUrl = (repo: string, n: number) => `codehost:${repo}/change/${n}`;

type Schema = Record<string, unknown>;
const obj = (properties: Record<string, Schema>, required: string[]): Schema => ({ type: "object", additionalProperties: false, required, properties });
const REPO = { type: "string", pattern: "^local/[\\w.-]+$" };
const BRANCHES = obj({
  workspace: { type: "string", pattern: "^[A-Za-z][A-Za-z0-9]*-[0-9]+$" },
  only: { type: "array", minItems: 1, maxItems: 30, items: obj({ repo: REPO, branch: { type: "string", minLength: 1, maxLength: 200, pattern: "^[\\w./-]+$" }, sha: { type: "string", pattern: "^[0-9a-f]{40}$" } }, ["repo", "branch", "sha"]) },
  text: obj({ title: { type: "string", maxLength: 300 }, body: { type: "string", maxLength: 60000 } }, ["title", "body"]),
}, ["workspace", "only"]);
const CHANGES = (head: boolean) => obj({ prs: { type: "array", minItems: 1, maxItems: 30, items: obj({ repo: REPO, number: { type: "integer", minimum: 1 }, ...(head ? { head: { type: "string", pattern: "^[0-9a-f]{40}$" } } : {}) }, head ? ["repo", "number", "head"] : ["repo", "number"]) } }, ["prs"]);
const CARD = { target: "{{target}}", sentence: "{{sentence}}", details: "{{diff}}" };
/** The write kinds this code host executes: the same actions, args and floors as codehost-github's; the kernel registers them when the module is enabled. */
export const LOCAL_KINDS = Object.fromEntries(Object.entries({
  push: BRANCHES, pr: BRANCHES, merge: CHANGES(true), close: CHANGES(false),
  create_repo: obj({ repo: { type: "string", pattern: "^local/[a-z][a-z0-9-]{0,62}$" } }, ["repo"]),
}).map(([action, args]) => [`codehost-local.${action}`, { module: "codehost-local", floor: 0 as const, tools: [] as string[], args, card: CARD }]));

/** Each change's checks, as plan.mjs reads them ({ ok, pending }); the kernel's `change` check job on (repo, head, base). */
/** `retry`: run again a check that couldn't run (a new request); otherwise the one asked for before, as it stands. `summary`: its receipt's. */
export type ChangeChecks = (repo: string, head: string, base: string, retry?: boolean) => Promise<{ ok: boolean; pending: boolean; summary?: string }[]>;

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

  async function readChange(repo: string, n: number) {
    const head = await rev(repo, `refs/changes/${n}/head`);
    if (!head) throw fail(404, `${changeUrl(repo, n)} doesn't exist`);
    const merged = await rev(repo, `refs/changes/${n}/merged`);
    const closed = merged ? "" : await rev(repo, `refs/changes/${n}/closed`);
    const main = await rev(repo, `refs/heads/${await defaultBranch(repo)}`);
    const base = main ? await g(repo, ["merge-base", main, head]).catch(() => "") : "";
    const files = (await g(repo, ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--name-only", "-z", base || "4b825dc642cb6eb9a060e54bf8d69288fbee4904", head])).split("\0").filter(Boolean);
    return { n, head, base, main, files, state: merged ? "merged" : closed ? "closed" : "open", meta: await meta(repo, n) };
  }

  /** A branch's head moved in: fast-forward only on the default branch, a compare-and-swap with what was there on any other. */
  async function moveBranch(repo: string, branch: string, sha: string) {
    const old = await rev(repo, `refs/heads/${branch}`);
    if (old && branch === (await defaultBranch(repo)) && !(await g(repo, ["merge-base", "--is-ancestor", old, sha]).then(() => true, () => false))) throw fail(409, `${repo} \`${branch}\` isn't a fast-forward to ${sha.slice(0, 12)}`);
    await g(repo, ["update-ref", `refs/heads/${branch}`, sha, old || ZERO]);
  }

  /** The change request of `branch` (the open one moves to its new head), else a new one. Its URL. */
  function openChange(repo: string, branch: string, head: string, text: { title?: string; body?: string } | undefined, task: string) {
    return locked(repo, async () => {
      const into = await defaultBranch(repo), tip = await rev(repo, `refs/heads/${into}`);
      for (const n of (await numbers(repo)).reverse()) {
        const c = await readChange(repo, n);
        if (c.meta.branch !== branch || c.state !== "open") continue;
        const lines = [`update refs/changes/${n}/head ${head}`, `update refs/changes/${n}/base ${tip}`];
        if (text) lines.push(`update refs/changes/${n}/meta ${await g(repo, ["hash-object", "-w", "--stdin"], { input: JSON.stringify({ ...c.meta, ...text }) })}`);
        await refs(repo, lines);
        return changeUrl(repo, n);
      }
      const n = ((await numbers(repo)).at(-1) ?? 0) + 1;
      const m = await g(repo, ["hash-object", "-w", "--stdin"], { input: JSON.stringify({ title: text?.title ?? branch, body: text?.body ?? "", branch, base: into, task, opened_at: new Date().toISOString(), draft: false }) });
      await refs(repo, [`create refs/changes/${n}/head ${head}`, `create refs/changes/${n}/base ${tip}`, `create refs/changes/${n}/meta ${m}`]);
      return changeUrl(repo, n);
    });
  }

  /** The change squashed onto the default branch as one commit, a compare-and-swap on its ref; refused on a conflict. */
  function land(repo: string, n: number, head: string) {
    return locked(repo, async () => {
      const c = await readChange(repo, n);
      if (c.state !== "open") throw fail(409, `${changeUrl(repo, n)} is ${c.state}`);
      if (c.head !== head) throw fail(409, `${changeUrl(repo, n)} moved since it was approved: ask again for its new head`);
      if (!c.base) throw fail(409, `${changeUrl(repo, n)} shares no history with its default branch`);
      const def = await defaultBranch(repo);
      const tree = await g(repo, ["merge-tree", "--write-tree", `--merge-base=${c.base}`, c.main, head]).catch((e: { code?: number }) => (e.code === 1 ? "" : Promise.reject(e)));
      if (!tree) throw fail(409, `${changeUrl(repo, n)} conflicts with ${def} as it is now: rebase it and publish again`);
      const message = `${String(c.meta.title ?? "").replace(/[\p{Cc}\p{Cf}]/gu, " ").slice(0, 300) || c.meta.branch} (change ${n})\n\n${await g(repo, ["log", "-1", "--format=%B", head])}`;
      const sha = await g(repo, ["commit-tree", tree.split("\n")[0]!, "-p", c.main, "-m", message], { env: IDENTITY });
      await g(repo, ["update-ref", `refs/heads/${def}`, sha, c.main]);
      await refs(repo, [`create refs/changes/${n}/merged ${sha}`]);
      await g(repo, ["update-ref", "-d", `refs/heads/${c.meta.branch}`, head]).catch(() => {});
      return sha;
    });
  }

  const subject = (repo: string, n: number) => `pr:${repo.toLowerCase()}#${n}`;
  /** Churn of the repo's merged changes (the squash commits' `(change N)`), a cursor per repo in <root>/churn.json (kernel/sdk/src/churn.ts). */
  async function churnLocal(repo: string) {
    const file = join(root, "churn.json");
    const cursors = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
    const key = repo.toLowerCase(), def = await defaultBranch(repo);
    const out = await churnFromGit((args) => g(repo, args), { rev: `refs/heads/${def}`, cursor: cursors[key], windowDays: 14, exclude: DEFAULT_CHURN_EXCLUDE, prOf: (m) => { const n = /\(change (\d+)\)\s*$/.exec(m.split("\n")[0]!)?.[1]; return n ? `${key}#${n}` : undefined; } });
    const num = (pr: string) => Number(pr.slice(pr.lastIndexOf("#") + 1));
    const task = async (n: number) => ((await meta(repo, n)).task as string | undefined) ?? null;
    for (const [pr, lines] of Object.entries(out.added)) if (lines && out.fresh(out.mergedAt.get(pr)!)) fact({ type: "code.added", subject: subject(repo, num(pr)), version: "1", at: out.mergedAt.get(pr)!, task: await task(num(pr)), data: { pr, lines } });
    for (const r of out.rewritten) if (out.fresh(out.mergedAt.get(r.by_pr)!)) fact({ type: "code.rewritten", subject: subject(repo, num(r.pr)), version: r.by_pr, at: out.mergedAt.get(r.by_pr)!, task: await task(num(r.pr)), data: r });
    if (out.last) writeFileSync(file, JSON.stringify({ ...cursors, [key]: out.last }));
  }

  const parse = (url: string) => /^codehost:(local\/[\w.-]+)\/change\/(\d+)$/.exec(url);
  const base = (requester?: { roles?: string[] }) => ({ agentsOrgs: [LOCAL_ORG], allowedOrgs: [LOCAL_ORG], instanceRepo, productRepo, requester: { platform: (requester?.roles ?? []).includes("platform-engineer") } });

  /** The verified state plan.mjs tiers a request on, and the card's diff: read from the bare repos and the workspace, never the args. */
  async function stateFor(action: string, a: any, requester?: { roles?: string[] }) {
    if (action === "create_repo") return { state: { ...base(requester), repo: String(a.repo) }, target: String(a.repo), sentence: `Create the repository ${a.repo} on this server.`, diff: "" };
    if (action === "merge" || action === "close") {
      const prs = [];
      let diff = "";
      for (const p of a.prs ?? []) {
        if (!exists(p.repo)) throw fail(404, `${p.repo} isn't on this server`);
        const c = await readChange(p.repo, Number(p.number));
        if (c.state !== "open") throw fail(409, `${changeUrl(p.repo, c.n)} is ${c.state}`);
        if (action === "merge") diff += await diffText(p.repo, c.base || "4b825dc642cb6eb9a060e54bf8d69288fbee4904", c.head);
        prs.push({ repo: p.repo, number: c.n, head: c.head, base: c.base, headMatches: !p.head || p.head === c.head, files: c.files, ownHead: true, dependabot: false, checks: action === "merge" ? (await checks(p.repo, c.head, c.base, true)).map(({ ok, pending }) => ({ ok, pending })) : [] });
      }
      const urls = prs.map((p) => changeUrl(p.repo, p.number)).join(", ");
      return { state: { ...base(requester), prs }, target: urls, sentence: `${action === "merge" ? "Merge" : "Close"} ${urls}${action === "merge" ? " at its approved head, once its checks are green" : ""}.`, diff };
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
        branches.push({ repo: b.repo, branch: b.branch, sha: b.sha, base: mb || undefined, files, defaultBranch: def, empty: !main });
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    }
    const names = branches.map((b) => `${b.repo} \`${b.branch}\``).join(", ");
    return { state: { ...base(requester), workspace: a.workspace, branches }, target: names, sentence: `${action === "pr" ? "Publish and open a change request for" : "Push"} ${names}.`, diff };
  }

  /** Waits until the change's checks are all green (""), or one is red or they don't finish in time (why, with its summary). */
  async function green(repo: string, head: string, baseSha: string) {
    for (const until = Date.now() + waitMs; ;) {
      const cs = await checks(repo, head, baseSha);
      if (cs.length && cs.every((c) => c.ok)) return "";
      const red = cs.find((c) => !c.ok && !c.pending);
      if (!cs.length || red || Date.now() > until) return red ? `failed: ${red.summary ?? "no summary"}` : "didn't finish in time";
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  const executor = {
    async plan(req: { kind: string; args: any; requester?: { roles?: string[] } }) {
      const action = String(req.kind).replace(/^codehost-local\./, "");
      const s = await stateFor(action, req.args ?? {}, req.requester);
      // plan.mjs's rules, as codehost-github's: the bare action, so it reads the same parts.
      return planRules({ kind: action, args: req.args }, s.state, { target: s.target, sentence: s.sentence, diff: s.diff });
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
            const url = await openChange(b.repo, b.branch, b.sha, a.text, a.workspace);
            done.push(url);
            const n = Number(url.slice(url.lastIndexOf("/") + 1)), at = new Date().toISOString();
            fact({ type: "pr.opened", subject: subject(b.repo, n), version: "1", at, task: a.workspace, data: { repo: b.repo, number: n, head: b.sha, branch: b.branch } });
            fact({ type: "pr.checks_started", subject: `${subject(b.repo, n)}@${b.sha}`, version: `${b.sha}:1`, at, task: a.workspace, data: { head: b.sha } });
            // Its checks start now, so the merge rarely waits.
            const main = await rev(b.repo, `refs/heads/${await defaultBranch(b.repo)}`);
            if (main) void checks(b.repo, b.sha, await g(b.repo, ["merge-base", main, b.sha])).catch(() => {});
          } else done.push(`${b.repo} ${b.branch} at ${b.sha.slice(0, 12)}`);
        }
        return { ok: true, text: `${action === "pr" ? "Change requests" : "Pushed"}: ${done.join(", ")}` };
      }
      if (action === "merge") {
        const merged: { repo: string; number: number; head: string; sha: string }[] = [];
        for (const p of a.prs) {
          const c = await readChange(p.repo, Number(p.number));
          const t0 = Date.now(), task = (c.meta.task as string | undefined) ?? null;
          const why = await green(p.repo, p.head, c.base);
          const at = new Date().toISOString();
          // A wait on the checks, and CI's end on this head (the same facts as codehost-github's merge queue).
          if (Date.now() - t0 > 2000) { const since = new Date(t0).toISOString(); fact({ type: "work.waiting", subject: subject(p.repo, c.n), version: since, at: since, task, data: { reason: "checks" } }); fact({ type: "work.resumed", subject: subject(p.repo, c.n), version: since, at, task, data: { reason: "checks" } }); }
          fact({ type: "pr.checks_completed", subject: `${subject(p.repo, c.n)}@${p.head}`, version: `${p.head}:1`, at, task, data: { head: p.head, conclusion: why ? "failure" : "success", failed: why ? ["checks"] : [] } });
          if (why) return { ok: false, text: `${changeUrl(p.repo, c.n)}: nothing merged${done.length ? ` after ${done.join(", ")}` : ""}; its checks on ${String(p.head).slice(0, 12)} ${why}` };
          const sha = await land(p.repo, c.n, p.head);
          fact({ type: "pr.merged", subject: subject(p.repo, c.n), version: p.head, at: new Date().toISOString(), task: (c.meta.task as string | undefined) ?? null, data: { sha, head: p.head } });
          void churnLocal(p.repo).catch(() => {}); // churn never delays or fails a merge
          merged.push({ repo: p.repo, number: c.n, head: p.head, sha });
          done.push(`${changeUrl(p.repo, c.n)} as ${sha.slice(0, 12)}`);
        }
        // The first line as codehost-github's merge queue writes it (merges.ts MERGED_LINE): what the grader reads as merged.
        return { ok: true, text: `merged-prs: ${JSON.stringify(merged)}\nMerged: ${done.join(", ")}` };
      }
      if (action === "close") {
        for (const p of a.prs) {
          await locked(p.repo, async () => {
            const c = await readChange(p.repo, Number(p.number));
            if (c.state === "open") await refs(p.repo, [`create refs/changes/${c.n}/closed ${c.head}`]);
          });
          done.push(changeUrl(p.repo, Number(p.number)));
        }
        return { ok: true, text: `Closed: ${done.join(", ")}` };
      }
      return { ok: false, text: `no such kind ${rec.kind}` };
    },
  };

  return {
    executor,
    bare,
    parse,
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
