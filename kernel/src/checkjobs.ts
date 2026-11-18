// Check jobs (one-way spec §4.2a): a repo's checks (its fast check, its tests, the reviewer eval) run as credential-free jobs
// in a computer, never in a process that holds a credential, and come back as a receipt the kernel signs. A module with role
// kernel.checks (codehost-github, dispatch) asks for one at POST /v1/checks; the code host verifies the receipt before it
// lands (POST /v1/receipts/verify).
//
// A check job has no task, no Paperclip identity, no tools and no GitHub credential. Its workspace is a snapshot of
// `repo@head` (the code host's `snapshot` op: no .git, no credentials); its box is the `engineer` image. Its env is exactly
// checkEnv's: only the eval gets a model credential, a `check` token the gateway caps by the eval day cap (eval_day_usd)
// and that the tool proxy and the writes route refuse.
//
// The eval runs the judging rules the runner's eval gate ran (services/runner/src/evalgate.ts), unchanged: the code host
// builds the spec (which commits judge which), the kernel lays it out and decides. The eval script and case-pad.mjs come
// from the judging commit; every base case runs at its base version (a deleted case included); a case the change adds runs
// as written; a changed case runs twice (its base version, and the change's fixture held to the base's expectations). The
// pass rule is applied here, never read from the box: at least 95% of the base's cases pass, every added case passes, and
// each miss is a false block (an `approve` case rejected or escalated); after a first run with failures, only the failed
// cases run once more, and each must then pass. The receipt binds the change's head, the judging commit and the policy hash.
//
// The box and the snapshot are seams: the kernel's box client (boxes.ts) and codehost-github's snapshot op provide them.
// A check the kernel lost (a restart mid-run) or couldn't run has no receipt; asking again runs it again.
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

export const RUNS = ["fast", "tests", "eval"] as const;
export type Run = (typeof RUNS)[number];
/** The eval's spec (the code host builds it): the modules repo and its commits under test, judging and supplying the change's cases. */
export type EvalSpec = { repo: string; judge_commit: string; subject_commit: string; cases_from: string; policy_hash: string };
export type Receipt = { v: 1; check: string; repo: string; head: string; run: Run; judge: string | null; policy: string | null; hash: string; verdict: "pass" | "fail"; summary: string; at: string; sig: string };
/** What a receipt must be bound to for the caller: the eval's judge and policy too. */
export type Binding = { repo: string; head: string; run: Run; judge?: string; policy?: string };
export type CheckView = { id: string; repo: string; head: string; run: Run; state: string; receipt: Receipt | null; error: string | null; version: number };

/** Where a check's folders are in its box: the snapshot (read-write, thrown away after) and the kernel's out folder. */
export const BOX_WORKSPACE = "/workspace";
export const BOX_OUT = "/aidenhq-out";
/** A credential-free computer for one check (the kernel's box client): `argv` in `cwd` (relative to the workspace) with exactly `env`. */
export interface CheckBox {
  run(o: { check: string; image: "engineer"; workspace: string; out: string; cwd: string; argv: string[]; env: Record<string, string>; timeoutMs: number }): Promise<{ exit: number | null; out: string; timedOut: boolean }>;
}
/** codehost-github's snapshot op: `repo` at commit `ref`, extracted into the empty folder `into` (no .git, no credentials). */
export type Snapshot = (repo: string, ref: string, into: string) => Promise<void>;

export class CheckError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) { super(message); this.name = "CheckError"; this.status = status; this.code = code; }
}

const SHA = /^[0-9a-f]{40}$/;
const SLUG = /^[\w.-]{1,100}\/[\w.-]{1,100}$/;
const POLICY = /^[0-9a-f]{7,64}$/;
const TAIL = 4000;
const LIMIT_MS: Record<Run, number> = { fast: 90_000, tests: 20 * 60_000, eval: 60 * 60_000 };
export const FAST_CHECK = "aidenhq:fast-check";
const ARGV: Record<Run, string[]> = {
  fast: ["npm", "run", "--silent", FAST_CHECK],
  tests: ["bash", "-c", "npm ci && npm run --if-present lint && npm test && npm run --if-present build"],
  eval: ["node", "scripts/reviewer-eval.mjs"],
};
// Paths in the official modules repo (its modules sit at its root).
const MODULE = "ai-reviewer";
const CASES = `${MODULE}/test/reviewer-cases`;
const JUDGE = [`${MODULE}/scripts/reviewer-eval.mjs`, `${MODULE}/test/case-pad.mjs`, `${MODULE}/scripts/pass-rule.mjs`];
const EXPECT = ["expect", "expect_code", "expect_second", "expect_flag", "expect_nit"] as const;

/** The whole env a check's box gets: nothing of the kernel's own, no GitHub or tool credential; a model token for the eval only. */
export function checkEnv(run: Run, { base, modelToken, gatewayUrl }: { base?: string; modelToken?: string; gatewayUrl?: string } = {}): Record<string, string> {
  const env: Record<string, string> = { CI: "1", HOME: `${BOX_OUT}/home`, npm_config_audit: "false", npm_config_fund: "false", npm_config_update_notifier: "false" };
  if (run === "fast" && base) env.AIDENHQ_BASE = base;
  if (run === "eval") Object.assign(env, { OPENROUTER_API_KEY: String(modelToken ?? ""), OPENROUTER_BASE_URL: String(gatewayUrl ?? ""), EVAL_RESULT: `${BOX_OUT}/result.json` });
  return env;
}

/** A spec as the kernel takes it: exactly the fields its run has, each well-formed. Throws a 400 otherwise. */
function checkSpec(run: Run, spec: unknown): Record<string, string> {
  const s = spec ?? {};
  if (typeof s !== "object" || Array.isArray(s)) throw new CheckError(400, "bad-spec", "spec is an object");
  const want: Record<Run, Record<string, RegExp>> = {
    fast: { base: SHA }, tests: {},
    eval: { repo: SLUG, judge_commit: SHA, subject_commit: SHA, cases_from: SHA, policy_hash: POLICY },
  };
  const fields = want[run];
  for (const [k, v] of Object.entries(s)) if (!fields[k] || typeof v !== "string" || !fields[k].test(v)) throw new CheckError(400, "bad-spec", `spec.${k} isn't a ${run} check's (${Object.keys(fields).join(", ") || "none"})`);
  if (run === "eval") for (const k of Object.keys(fields)) if (!(k in s)) throw new CheckError(400, "bad-spec", `an eval's spec names ${k}`);
  return s as Record<string, string>;
}
/** The spec's hash: its fields in key order. */
const specHash = (spec: Record<string, string>) => createHash("sha256").update(JSON.stringify(Object.keys(spec).sort().map((k) => [k, spec[k]]))).digest("hex");

const FIELDS = ["v", "check", "repo", "head", "run", "judge", "policy", "hash", "verdict", "summary", "at"] as const;
const mac = (secret: string, r: Omit<Receipt, "sig">) => createHmac("sha256", secret).update(JSON.stringify(FIELDS.map((k) => r[k]))).digest("hex");

/** Signs a receipt with the kernel's receipt_secret (kernel-only). */
export function signReceipt(secret: string, r: Omit<Receipt, "sig" | "v">): Receipt {
  if (!secret) throw new CheckError(503, "no-receipt-secret", "the kernel has no receipt_secret");
  const body = { v: 1 as const, ...r };
  return { ...body, sig: mac(secret, body) };
}

/** Whether `r` is a genuine passing receipt for exactly `want` (the eval's judge and policy too); else why not. */
export function verifyReceipt(secret: string, r: unknown, want: Binding): { ok: true } | { ok: false; why: string } {
  const x = r as Receipt | null;
  if (!secret) return { ok: false, why: "the kernel has no receipt_secret" };
  if (!x || typeof x !== "object" || x.v !== 1 || typeof x.sig !== "string" || FIELDS.some((k) => !(k in x))) return { ok: false, why: "not a receipt" };
  const good = Buffer.from(mac(secret, x)), got = Buffer.from(x.sig);
  if (good.length !== got.length || !timingSafeEqual(good, got)) return { ok: false, why: "its signature isn't the kernel's" };
  if (x.repo.toLowerCase() !== String(want.repo).toLowerCase()) return { ok: false, why: `it is for ${x.repo}` };
  if (x.head !== want.head) return { ok: false, why: `it is for head ${String(x.head).slice(0, 12)}` };
  if (x.run !== want.run) return { ok: false, why: `it is a ${x.run} check's` };
  if (x.run === "eval" && (x.judge !== want.judge || x.policy !== want.policy)) return { ok: false, why: `it was judged by ${String(x.judge).slice(0, 12)} with policy ${x.policy}` };
  if (x.verdict !== "pass") return { ok: false, why: "it didn't pass" };
  return { ok: true };
}

/** A small regular file under a folder the box wrote: never through a link, a FIFO or a device. Undefined otherwise. */
export function smallFile(file: string, max = 4 << 20): string | undefined {
  let fd: number;
  try { fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch { return undefined; }
  try {
    const st = fstatSync(fd);
    return st.isFile() && st.size <= max ? readFileSync(fd, "utf8") : undefined;
  } finally {
    closeSync(fd);
  }
}

/** Throws when any part of `rel` under `root` is a symlink (a snapshot may hold one): the kernel never writes through it. */
function noLinks(root: string, rel: string) {
  let at = root;
  for (const part of rel.split("/")) {
    at = join(at, part);
    if (lstatSync(at, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error(`${rel} goes through a symlink`);
  }
}

// The judging rules (from services/runner/src/evalgate.ts, which goes with the runner).
/** The cases the judge runs: every base case at its base version, new ones as written, a changed one twice (`.head.json`: its fixture, the base's expectations). */
export function judgedCases(base: Map<string, string>, head: Map<string, string>): Map<string, string> {
  const out = new Map(base);
  for (const [name, text] of head) {
    if (name.endsWith(".head.json")) throw new Error(`${name}: \`.head.json\` is reserved for the judge's own variants of changed cases`);
    const was = base.get(name);
    if (was === undefined) out.set(name, text);
    else if (was !== text) {
      try {
        const b = JSON.parse(was), h = JSON.parse(text);
        for (const k of EXPECT) if (k in b) h[k] = b[k]; else delete h[k];
        out.set(name.replace(/\.json$/, ".head.json"), JSON.stringify(h, null, 2));
      } catch {
        out.set(name.replace(/\.json$/, ".head.json"), text);
      }
    }
  }
  return out;
}
const approveCases = (judged: Map<string, string>) => [...judged].filter(([, t]) => { try { return [JSON.parse(t).expect].flat().includes("approve"); } catch { return false; } }).map(([n]) => n);
type Failure = { file: string; want?: string; got?: string; reason?: string };
type EvalResult = { total: number; passed: number; failed: Failure[]; broken?: true };
/** The pass rule over `total` judged cases, `added` of them the change's own; `failed` are the misses. */
export function evalPasses(failed: Failure[], total: number, approves: string[], added: string[]): boolean {
  const baseTotal = total - added.length;
  const baseMisses = failed.filter((f) => !added.includes(f.file));
  const falseBlock = (f: Failure) => approves.includes(f.file) && /^(reject|escalate)\b/.test(f.got ?? "");
  return baseTotal > 0 && failed.length === baseMisses.length && baseMisses.every(falseBlock) && Math.floor(((baseTotal - baseMisses.length) / baseTotal) * 100) >= 95;
}
/** The judge's result, checked against the cases it was given; missing, malformed or miscounted, every case failed (broken). */
function readResult(file: string, cases: string[]): EvalResult {
  let r: any;
  try { r = JSON.parse(smallFile(file) ?? ""); } catch { return { total: cases.length, passed: 0, failed: cases.map((f) => ({ file: f, reason: "the eval wrote no result" })), broken: true }; }
  const failed: Failure[] = (Array.isArray(r?.failed) ? r.failed : []).filter((f: any) => cases.includes(f?.file)).map((f: any) => ({ file: f.file, want: String(f.want ?? "").slice(0, 80), got: String(f.got ?? "").slice(0, 80), reason: String(f.reason ?? "").slice(0, 600) }));
  if (r?.total !== cases.length || r?.passed !== cases.length - failed.length) return { total: cases.length, passed: 0, failed: cases.map((f) => ({ file: f, reason: `the eval's counts don't match its ${cases.length} cases` })), broken: true };
  return { total: cases.length, passed: r.passed, failed };
}
/** A case folder's JSON files, read as small regular files (a link or a special file is a case that can't be read: its text is empty). */
function casesIn(dir: string): Map<string, string> {
  const names = existsSync(dir) && !lstatSync(dir).isSymbolicLink() ? readdirSync(dir).filter((n) => /^[\w.-]+\.json$/.test(n)).sort() : [];
  return new Map(names.map((n) => [n, smallFile(join(dir, n), 1 << 20) ?? ""]));
}
const fence = (s: string) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").replace(/```/g, "‵‵‵").trim();

const DDL = `CREATE TABLE IF NOT EXISTS checks (
  id TEXT PRIMARY KEY, module TEXT NOT NULL, repo TEXT NOT NULL, head TEXT NOT NULL, run TEXT NOT NULL, hash TEXT NOT NULL, spec TEXT NOT NULL,
  state TEXT NOT NULL, receipt TEXT, error TEXT, at INTEGER NOT NULL, ended INTEGER, UNIQUE (module, repo, head, run, hash))`;

export function createChecks({ db, secret, box, snapshot, modelToken, gatewayUrl, workDir, log, now = Date.now }: {
  db: DatabaseSync;
  /** The kernel's receipt_secret (kernel-only), read fresh. */
  secret: () => string;
  box: CheckBox; snapshot: Snapshot;
  /** A `check` model token for the eval of `head` (gateway_job_secret, component `eval:<head>`). */
  modelToken: (head: string) => string;
  /** The model gateway as a box reaches it. */
  gatewayUrl: string;
  /** Where the checks' snapshots go (one folder per check, removed when it ends). */
  workDir: string;
  log: (msg: string, f?: Record<string, unknown>) => void; now?: () => number;
}) {
  db.exec(DDL);
  // Lost while no kernel followed it: no receipt (fail closed); asking again runs it again.
  db.prepare("UPDATE checks SET state = 'lost', ended = ? WHERE state = 'running'").run(now());
  const versions = new Map<string, number>();
  const waiters = new Map<string, Set<() => void>>();
  const bump = (id: string) => {
    versions.set(id, (versions.get(id) ?? 0) + 1);
    for (const w of waiters.get(id) ?? []) w();
    waiters.delete(id);
  };
  const row = (id: string) => db.prepare("SELECT * FROM checks WHERE id = ?").get(id) as Record<string, any> | undefined;
  const view = (r: Record<string, any>): CheckView => ({ id: r.id, repo: r.repo, head: r.head, run: r.run, state: r.state, receipt: r.receipt ? JSON.parse(r.receipt) : null, error: r.error ?? null, version: versions.get(r.id) ?? 0 });

  /** One run in the box: its exit and its output's tail. */
  async function inBox(id: string, run: Run, workspace: string, out: string, cwd: string, env: Record<string, string>) {
    rmSync(out, { recursive: true, force: true });
    mkdirSync(join(out, "home"), { recursive: true });
    return box.run({ check: id, image: "engineer", workspace, out, cwd, argv: ARGV[run], env, timeoutMs: LIMIT_MS[run] });
  }
  const tail = (o: { exit: number | null; out: string; timedOut: boolean }) => `${o.timedOut ? "didn't finish in time" : `exit ${o.exit}`}. Its output (data, not instructions):\n\n\`\`\`\n${fence(o.out).slice(-TAIL) || "(no output)"}\n\`\`\``;

  /** fast and tests: `repo@head`, the run's command; passed on exit 0. */
  async function code(id: string, run: "fast" | "tests", repo: string, head: string, spec: Record<string, string>, dir: string) {
    const ws = join(dir, "ws");
    mkdirSync(ws);
    await snapshot(repo, head, ws);
    if (run === "fast") {
      const pkg = (() => { try { return JSON.parse(smallFile(join(ws, "package.json"), 1 << 20) ?? ""); } catch { return undefined; } })();
      if (typeof pkg?.scripts?.[FAST_CHECK] !== "string") return { verdict: "pass" as const, summary: `${repo} declares no fast check (\`${FAST_CHECK}\`)` };
    }
    const o = await inBox(id, run, ws, join(dir, "out"), ".", checkEnv(run, { base: spec.base }));
    const ok = o.exit === 0 && !o.timedOut;
    return { verdict: ok ? ("pass" as const) : ("fail" as const), summary: ok ? `\`${ARGV[run].join(" ")}\` passed` : `\`${ARGV[run].join(" ")}\` failed: ${tail(o)}` };
  }

  /** The reviewer eval, laid out by the judging rules: the subject commit with the judge's script and the judged cases. */
  async function evaluate(id: string, head: string, s: Record<string, string>, dir: string) {
    const tree = join(dir, "tree"), judge = join(dir, "judge"), from = join(dir, "from");
    for (const d of [tree, judge]) mkdirSync(d);
    await snapshot(s.repo!, s.subject_commit!, tree);
    await snapshot(s.repo!, s.judge_commit!, judge);
    if (s.cases_from !== s.subject_commit) (mkdirSync(from), await snapshot(s.repo!, s.cases_from!, from));
    const base = casesIn(join(judge, CASES)), mine = casesIn(join(s.cases_from === s.subject_commit ? tree : from, CASES));
    const judged = judgedCases(base, mine);
    const approves = approveCases(judged), added = [...mine.keys()].filter((n) => !base.has(n));
    for (const f of JUDGE) {
      const text = smallFile(join(judge, f), 1 << 20);
      // The pass rule may not exist at a judge that predates it: that judge doesn't use it (the kernel applies the rule).
      if (text === undefined) { if (f.endsWith("pass-rule.mjs")) continue; throw new Error(`the judging commit has no ${f}`); }
      noLinks(tree, f);
      mkdirSync(join(tree, f, ".."), { recursive: true });
      writeFileSync(join(tree, f), text);
    }
    rmSync(judge, { recursive: true, force: true });
    rmSync(from, { recursive: true, force: true });
    const lay = (names: string[]) => {
      noLinks(tree, CASES);
      rmSync(join(tree, CASES), { recursive: true, force: true });
      mkdirSync(join(tree, CASES), { recursive: true });
      for (const n of names) writeFileSync(join(tree, CASES, n), judged.get(n)!);
    };
    const env = checkEnv("eval", { modelToken: modelToken(head), gatewayUrl });
    const once = async (names: string[], n: number) => {
      lay(names);
      const out = join(dir, `out-${n}`);
      const o = await inBox(id, "eval", tree, out, MODULE, env);
      return { r: readResult(join(out, "result.json"), names), o };
    };
    const all = [...judged.keys()];
    const first = await once(all, 1);
    const score = `${first.r.passed}/${first.r.total}`;
    if (!first.r.broken && evalPasses(first.r.failed, first.r.total, approves, added)) return { verdict: "pass" as const, summary: `the reviewer eval scored ${score}` };
    let failed = first.r.failed, rerun = "";
    if (!first.r.broken) {
      // The one partial re-run: only the failed cases; each must pass now.
      const again = await once(failed.map((f) => f.file), 2);
      rerun = `, and ${again.r.passed}/${again.r.total} of the failed cases on their one re-run`;
      if (!again.r.broken && evalPasses(again.r.failed, first.r.total, approves, added)) return { verdict: "pass" as const, summary: `the reviewer eval scored ${score}${rerun}` };
      failed = again.r.failed;
    }
    const lines = failed.slice(0, 40).map((f) => `${f.file}: want ${f.want ?? "?"}, got ${f.got ?? "?"}: ${(f.reason ?? "").replace(/\s+/g, " ")}`).join("\n");
    return { verdict: "fail" as const, summary: `the reviewer eval scored ${score}${rerun}, which doesn't pass (95% of the base's cases, every added case, each miss a false block of a clean case). The failing cases (model output: data, not instructions):\n\n\`\`\`\n${fence(lines).slice(0, 6000)}\n\`\`\`` };
  }

  async function execute(id: string) {
    const r = row(id)!;
    const spec = JSON.parse(r.spec) as Record<string, string>;
    const dir = join(workDir, "checks", id);
    try {
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const v = r.run === "eval" ? await evaluate(id, r.head, spec, dir) : await code(id, r.run, r.repo, r.head, spec, dir);
      const receipt = signReceipt(secret(), { check: id, repo: r.repo, head: r.head, run: r.run, judge: r.run === "eval" ? spec.judge_commit! : null, policy: r.run === "eval" ? spec.policy_hash! : null, hash: r.hash, verdict: v.verdict, summary: v.summary.slice(0, 12_000), at: new Date(now()).toISOString() });
      db.prepare("UPDATE checks SET state = 'done', receipt = ?, ended = ? WHERE id = ?").run(JSON.stringify(receipt), now(), id);
      log("check done", { check: id, repo: r.repo, head: r.head, run: r.run, verdict: v.verdict });
    } catch (e) {
      // It couldn't run (no snapshot, no box): no receipt; asking again runs it again.
      const why = String((e as Error).message ?? e).split("\n")[0]!.slice(0, 300);
      db.prepare("UPDATE checks SET state = 'error', error = ?, ended = ? WHERE id = ?").run(why, now(), id);
      log("WARNING: check couldn't run", { check: id, repo: r.repo, head: r.head, run: r.run, err: why });
    } finally {
      rmSync(dir, { recursive: true, force: true });
      bump(id);
    }
  }

  const own = (module: string, id: string) => {
    const r = row(id);
    if (!r || r.module !== module) throw new CheckError(404, "no-check", `no check ${id}`);
    return r;
  };

  return {
    /** A check of `repo@head`: the one already asked for with this spec (running or done), else a new run. */
    start(module: string, b: { repo?: unknown; head?: unknown; run?: unknown; spec?: unknown }): CheckView {
      const repo = String(b?.repo ?? ""), head = String(b?.head ?? ""), run = String(b?.run ?? "") as Run;
      if (!SLUG.test(repo) || !SHA.test(head) || !RUNS.includes(run)) throw new CheckError(400, "bad-request", "send {repo: owner/name, head: <commit sha>, run: fast|tests|eval, spec}");
      const spec = checkSpec(run, b.spec);
      const hash = specHash(spec);
      const had = db.prepare("SELECT * FROM checks WHERE module = ? AND repo = ? AND head = ? AND run = ? AND hash = ?").get(module, repo.toLowerCase(), head, run, hash) as Record<string, any> | undefined;
      if (had && ["running", "done"].includes(had.state)) return view(had);
      const id = had?.id ?? `c-${randomBytes(8).toString("hex")}`;
      if (had) db.prepare("UPDATE checks SET state = 'running', receipt = NULL, error = NULL, at = ?, ended = NULL WHERE id = ?").run(now(), id);
      else db.prepare("INSERT INTO checks (id, module, repo, head, run, hash, spec, state, at) VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?)").run(id, module, repo.toLowerCase(), head, run, hash, JSON.stringify(spec), now());
      log("check started", { check: id, module, repo, head, run });
      void execute(id);
      return view(row(id)!);
    },
    /** Its state and receipt; with `after` (a version), waits up to `waitMs` for a change first. */
    async get(module: string, id: string, { after, waitMs = 0 }: { after?: number; waitMs?: number } = {}): Promise<CheckView> {
      own(module, id);
      if (after !== undefined && waitMs > 0 && (versions.get(id) ?? 0) <= after && row(id)!.state === "running") {
        await new Promise<void>((res) => {
          const set = waiters.get(id) ?? new Set();
          const t = setTimeout(() => (set.delete(wake), res()), Math.min(waitMs, 30_000));
          const wake = () => (clearTimeout(t), res());
          set.add(wake);
          waiters.set(id, set);
        });
      }
      return view(row(id)!);
    },
    verify: (receipt: unknown, want: Binding) => verifyReceipt(secret(), receipt, want),
  };
}
export type Checks = ReturnType<typeof createChecks>;
