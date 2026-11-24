// Check jobs (one-way spec §4.2a): a repo's checks (its fast check, its tests, the reviewer eval, a module's contract kit) run as
// credential-free jobs in a computer, never in a process that holds a credential, and come back as a receipt the kernel signs. A
// module with role kernel.checks (codehost-github, dispatch) asks for one at POST /v1/checks; the code host verifies the receipt
// before it lands (POST /v1/receipts/verify).
//
// What a check runs is its module's: each module declares its recipes (module.yaml `check_jobs:`, compiled into the kernel's
// modules.json with the files of its folder) and the kernel carries no npm, supply-chain or reviewer knowledge. The kernel keeps
// what makes a receipt worth trusting: the recipe comes from the installed product, never from the request or the snapshot; a
// spec is exactly the recipe's fields, each well-formed; the box has no credential; the verdict and the receipt are the kernel's.
// One transport (inBox) runs every recipe, with the recipe's own time limit.
//
// A check job has no task, no Paperclip identity, no tools and no GitHub credential. Its workspace is a snapshot of
// `repo@head` (the code host's `snapshot` op: no .git, no credentials, asked as the module that asked for the check); its box
// is the `engineer` image, a fresh one per run. Its env is exactly checkEnv's: only a judged run (the reviewer eval) or a model
// recipe (below) gets a model credential, a `check` token that counts against the install's spend limit like any call and that
// the tool proxy and the writes route refuse. The recipe's files are laid in the out folder (`/aidenhq-out/recipe`) and its argv runs in the workspace.
//
// A recipe with a `base` in its spec runs on the change itself: the box makes its own two-commit history from the base and head
// snapshots (the recipe's script does it from /aidenhq-out/base), so `git diff $AIDENHQ_BASE HEAD` is exactly the change. A
// recipe that `declares` a package script has it required by the base (a change can't switch its own check off).
//
// A judged run (`judged:` in the recipe) is the reviewer eval's: the workspace is read-only, and it runs the judging rules the
// runner's eval gate ran, unchanged: the code host builds the spec (which commits judge which), the kernel lays it out and
// decides. The judge's files come from the judging commit; every base case runs at its base version (a deleted case included);
// a case the change adds runs as written; a changed case runs twice (its base version, and the change's fixture held to the base's
// expectations). The pass rule is applied here, never read from the box: at least 95% of the base's cases pass, every added case
// passes, and no attack is approved (a case that expects reject or escalate, approved); after a first run with failures, only the
// failed cases run once more, and each must then pass. The receipt binds the change's head, the judging commit and the policy hash.
//
// The box and the snapshot are seams: the kernel's box client (checkbox.ts) and codehost-github's snapshot op provide them.
// A restart doesn't lose a check whose box is running: the box's run is detached (as an agent job's is), its handle is on the row
// (`follow`: the box, and where the check is in its steps), and a draining kernel stops following it (detach) while it runs on.
// Once the old kernel has exited, the new one follows it again from the row (recover) and finishes it as the old one would have:
// its result, receipt and cost, its model token's spend by the same run key. A code recipe's run is followed even when a deploy
// changed its recipe since: the box already holds the files it launched with, and the receipt binds the hash it started under.
// Only while what decides its verdict (result, keep, model) is unchanged. A check whose box is gone (no exit status and not
// running), that hadn't reached its box, or any other run whose recipe has changed since (a judged run's next pass would run new
// files under the old hash) is lost: no receipt; asking again runs it again, and
// the lost run doesn't use up a try.
// Each run attempt (the row's start time `at`) has its own folder and lands its end only while the row is still that attempt's;
// a re-run asked meanwhile supersedes it.
// A judge that writes no usable result is the harness's failure, never the change's: the check ends in error, with no receipt.
// A judged run a spend cap cut short is the same: the gateway's ledger records the refusal (`refusedByKey`), so the check ends in
// error naming that cap, with no receipt, the run does not use up a try (the same head is judged again once the cap frees), and it
// never runs the partial second pass into it. The ledger is the authority, so a harness too old to name the cap still can't pass.
// Missing evidence never counts as passing: whether a recipe's declared check is due is read from the base commit, and a receipt
// says whether a check ran (`ran`); verify refuses one that didn't unless the caller's policy accepts "none" (product and
// modules repos never do).
//
// Every recipe's box gets its spec, with the repo and head, at /aidenhq-out/spec.json (data, never argv or env), and each spec
// field of kind sha (not a value an earlier field already named) as that commit's tree at
// /aidenhq-out/<field>: the recipe makes its own history from them (`base` as before; a review's `incremental_from`).
// A recipe with `model: true` (a code review) gets a model credential of its own: a `check` token for this check alone
// (component `<run>:<check id>`) on its own run key, that lapses with the recipe's time limit. A recipe with `result: true` writes one JSON object to /aidenhq-out/result.json (at most
// RESULT_MAX bytes): it passes only when that came out, the kernel stamps a model recipe's with `cost_usd` (its token's spend,
// from the gateway's ledger, never the box's say) and `tokens` (that attempt's input, cached and output tokens, the same ledger) and the receipt signs the exact bytes' sha256 (`result`). The result is the
// recipe's output, made from the repo's text: data for its reader, never instructions.
// Larger state a recipe carries from one run to the next (code review's deepsec records) travels as files, never in the spec or
// the result: a spec field of kind `input` names a file its module uploaded first (POST /v1/checks/inputs: its sha256, so the
// check's hash binds the bytes), laid at /aidenhq-out/<field>; a recipe with `keep: true` may leave one file at
// /aidenhq-out/keep, which the kernel keeps after the run (a regular file of at most INPUT_MAX, never through a link) for its
// module to fetch (GET /v1/checks/:check/kept). Both are the box's data, never read by the kernel; both go after FILES_DAYS.
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { closeSync, constants, copyFileSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { missKind, passes } from "../sdk/src/pass-rule.ts";
import { noteFact, openFacts } from "./facts.ts";
import { trashAway } from "./trash.ts";
import { EXPIRED_RESULT } from "./retention.ts";

/** A recipe's name (`fast`, `tests`, `eval`, `contract`, …): whatever the installed modules declare. */
export type Run = string;
/** How a spec field is written: a commit, a GitHub repo, a policy hash or a folder inside the workspace (no `..`). */
const isObject = (v: string) => { try { const j = JSON.parse(v); return Boolean(j) && typeof j === "object" && !Array.isArray(j); } catch { return false; } };
export const KINDS = {
  sha: /^[0-9a-f]{40}$/,
  slug: /^[\w.-]{1,100}\/[\w.-]{1,100}$/,
  policy: /^[0-9a-f]{7,64}$/,
  dir: /^(\.|(?!.*(^|\/)\.\.(\/|$))[\w.-]+(\/[\w.-]+)*)$/,
  /** A whole number (a PR's). */
  int: /^[1-9][0-9]{0,9}$/,
  /** Dollars, up to 4 decimals. */
  usd: /^[0-9]{1,4}(\.[0-9]{1,4})?$/,
  /** Short text with no control characters but newline and tab (data for the recipe, never a command). */
  text: /^[^\x00-\x08\x0b-\x1f\x7f]{0,2000}$/,
  /** A JSON object of at most 16 KB (a reviewer profile). */
  json: { test: (v: string) => v.length <= 16_384 && isObject(v) },
  /** An uploaded input file's sha256 (POST /v1/checks/inputs), or empty for none. */
  input: /^([0-9a-f]{64})?$/,
} satisfies Record<string, { test(v: string): boolean }>;
/** The most a result artifact may be: larger, the recipe produced no result. */
export const RESULT_MAX = 256 * 1024;
/** The most an input or a kept file may be, and how long either is kept. */
export const INPUT_MAX = 64 * 1024 * 1024;
const FILES_DAYS = 2;
/** A module's recipe (modules.ts checkJobs compiles it from `check_jobs:`). `files`: its folder, laid in the box; `declares`: a
 * package.json script the base must keep; `cwd_from`: the spec field naming the folder it runs in; `judged`: the eval's layout. */
export type Recipe = {
  module: string; argv: string[]; timeout_min: number; title: string; spec: Record<string, keyof typeof KINDS>; files: Record<string, string>;
  cwd_from?: string; declares?: string;
  judged?: { cwd: string; cases: string; files: string[]; expect: string[] };
  /** A model credential for this check alone. */
  model?: true;
  /** The recipe writes one JSON object to /aidenhq-out/result.json; the receipt binds its sha256. */
  result?: boolean;
  /** The recipe may leave one file at /aidenhq-out/keep for its module to fetch after the run. */
  keep?: true;
};
export type Recipes = Record<string, Recipe>;
/** The eval's spec (the code host builds it): the product repo and its commits under test, judging and supplying the change's cases. */
export type EvalSpec = { repo: string; judge_commit: string; subject_commit: string; cases_from: string; policy_hash: string };
/** `hash` binds the spec (every field: base, profile, …) and the recipe itself (its files too); `result`, when the recipe writes one,
 * the sha256 of the result's exact bytes. */
export type Receipt = { v: 1; check: string; repo: string; head: string; run: Run; judge: string | null; policy: string | null; hash: string; verdict: "pass" | "fail"; ran: boolean; summary: string; at: string; result?: string; sig: string };
/** What a receipt must be bound to for the caller: the eval's judge and policy too. `none`: the caller's policy accepts a fast
 * check's "nothing to run" (the repo's base declares no check); without it, a receipt of a check that didn't run is refused. */
export type Binding = { repo: string; head: string; run: Run; judge?: string; policy?: string; none?: boolean; result?: string };
/** `result`: the recipe's result object (data: made from the repo's text); `billed_usd`: its model token's spend by the gateway's
 * ledger (a failed run's too; a running check's so far); both null for other recipes. */
export type CheckView = { /** The result was cleared by retention (retention.ts): a re-ask of a result recipe runs it again. */ expired?: true; id: string; repo: string; head: string; run: Run; state: string; receipt: Receipt | null; error: string | null; version: number; result: Record<string, unknown> | null; billed_usd: number | null;
  /** Its last end was a spend limit ("day", "month", …): a budget outcome, not the change's failure (a later ask runs it again);
   * null when it didn't end at one. A reader may wait on it; nothing refuses a merge for it. */
  capped: string | null;
  /** Running, but still waiting for a computer (the pool is full): nothing is running in a box yet. */
  waiting: boolean;
  /** When the check got its box (ISO), kept through restarts and retries of one attempt; null before. Wall time runs from here, queueing excluded. */
  box_at: string | null };

/** Where a check's folders are in its box: the snapshot (read-write, thrown away after) and the kernel's out folder. */
export const BOX_WORKSPACE = "/workspace";
export const BOX_OUT = "/aidenhq-out";
/** A box's run as the row keeps it, so the next kernel can follow it: its box, its detached process, its log and its deadline. */
export type BoxRun = { container: string; pid: number; log: string; deadline: number;
  /** When `launch` obtained the box (epoch ms). */
  at: number };
export type BoxOut = { exit: number | null; out: string; timedOut: boolean };
/** A credential-free computer for one check (the kernel's box client, checkbox.ts): `launch` starts `argv` in a fresh box, in
 * `cwd` (relative to the workspace) with exactly `env`, detached from the kernel; `readOnly`: the workspace is mounted read-only.
 * `check`: the run attempt's folder under the work dir's checks/, which holds `workspace` and `out`. `follow` waits for a run's
 * end (any kernel's: it ends the box), or answers "gone" (no status and not running) or "detached" (`signal` aborted: the box
 * runs on). */
export interface CheckBox {
  launch(o: { check: string; image: "engineer"; workspace: string; out: string; cwd: string; argv: string[]; env: Record<string, string>; timeoutMs: number; readOnly?: boolean; waiting?: (waiting: boolean) => void;
    /** Mints the run's model token (set in env as OPENROUTER_API_KEY) once the box has its slot, so the token's lifetime starts then. */
    mint?: () => string }): Promise<BoxRun>;
  follow(run: BoxRun, signal: AbortSignal): Promise<BoxOut | "gone" | "detached">;
}
/** Where a check is when its box runs: a code recipe's spend before this attempt, or a judged run's pass and its cases. */
type Step = { prior: number; contract?: string } | { n: 1 | 2; names: string[]; added: string[]; first?: { passed: number; total: number } };
/** What decides a code recipe's verdict at its end (codeEnded, keepOut): an adopted run whose recipe a deploy changed is finished
 * only while this is unchanged, so its receipt never signs it by rules it didn't run under. */
const contractOf = (r: Recipe) => JSON.stringify([Boolean(r.result), Boolean(r.keep), Boolean(r.model)]);
/** A run that a draining kernel stopped following (the next one does), or whose box is gone (lost). */
class Detached extends Error {}
class Gone extends Error {}
/** A judged run a spend cap cut short: the reviewer didn't judge its cases, so it is no verdict on the change, and the attempt
 * doesn't use up a try (the same head is judged again once that cap frees). `cap` is the budget's name, as the eval reports it. */
class CapReached extends Error {
  readonly cap: string;
  constructor(cap: string, reason: string) { super(reason); this.cap = cap; }
}
/** codehost-github's snapshot op: `repo` at commit `ref`, extracted into the empty folder `into` (no .git, no credentials). */
export type Snapshot = (repo: string, ref: string, into: string) => Promise<void>;

export class CheckError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) { super(message); this.name = "CheckError"; this.status = status; this.code = code; }
}

const TAIL = 4000;
/** The whole env a check's box gets: nothing of the kernel's own, no GitHub or tool credential; a model token only for a judged
 * run (the eval) or a model recipe, each its own `check` token (OPENROUTER_API_KEY: the name the launcher registers it by). */
export function checkEnv(kind: "plain" | "result" | "judged" | "model", { modelToken, gatewayUrl }: { modelToken?: string; gatewayUrl?: string } = {}): Record<string, string> {
  const env: Record<string, string> = { CI: "1", HOME: `${BOX_OUT}/home`, npm_config_audit: "false", npm_config_fund: "false", npm_config_update_notifier: "false" };
  if (kind === "judged" || kind === "model") Object.assign(env, { OPENROUTER_API_KEY: String(modelToken ?? ""), OPENROUTER_BASE_URL: String(gatewayUrl ?? "") });
  if (kind === "judged") env.EVAL_RESULT = `${BOX_OUT}/result.json`;
  // A result recipe's spec and result files: a model recipe's, or a plain one's (a tools check: no token at all).
  if (kind === "model" || kind === "result") Object.assign(env, { AIDENHQ_SPEC: `${BOX_OUT}/spec.json`, AIDENHQ_RESULT: `${BOX_OUT}/result.json` });
  return env;
}

/** A spec as the kernel takes it: exactly the recipe's fields, each well-formed. Throws a 400 otherwise. */
function checkSpec(run: Run, recipe: Recipe, spec: unknown): Record<string, string> {
  const s = spec ?? {};
  if (typeof s !== "object" || Array.isArray(s)) throw new CheckError(400, "bad-spec", "spec is an object");
  const fields = recipe.spec;
  for (const [k, v] of Object.entries(s)) if (!fields[k] || typeof v !== "string" || !KINDS[fields[k]].test(v)) throw new CheckError(400, "bad-spec", `spec.${k} isn't a ${run} check's (${Object.keys(fields).join(", ") || "none"})`);
  for (const k of Object.keys(fields)) if (!(k in s)) throw new CheckError(400, "bad-spec", `a ${run} check's spec names ${k}`);
  return s as Record<string, string>;
}
/** The check's hash: the spec's fields in key order and the recipe itself, so a changed recipe is a new check. */
const specHash = (spec: Record<string, string>, recipe: Recipe) => createHash("sha256").update(JSON.stringify([Object.keys(spec).sort().map((k) => [k, spec[k]]), recipe])).digest("hex");

const FIELDS = ["v", "check", "repo", "head", "run", "judge", "policy", "hash", "verdict", "ran", "summary", "at"] as const;
// `result` is signed after the fixed fields only when present, so receipts without one (every recipe before result artifacts)
// keep their signatures; dropping it from a receipt that had one breaks the signature.
const mac = (secret: string, r: Omit<Receipt, "sig">) => createHmac("sha256", secret).update(JSON.stringify([...FIELDS.map((k) => r[k]), ...(r.result === undefined ? [] : [r.result])])).digest("hex");

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
  if (x.judge !== (want.judge ?? null) || x.policy !== (want.policy ?? null)) return { ok: false, why: `it was judged by ${String(x.judge).slice(0, 12)} with policy ${x.policy}` };
  if (x.verdict !== "pass") return { ok: false, why: "it didn't pass" };
  // Missing evidence never counts as passing: a check that didn't run passes only where the caller's policy says none is needed.
  if (x.ran !== true && want.none !== true) return { ok: false, why: "no check ran" };
  if (want.result !== undefined && x.result !== want.result) return { ok: false, why: "its result isn't this one" };
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

// The judging rules (from the runner's eval gate, deleted at the big switch).
/** The cases the judge runs: every base case at its base version, new ones as written, a changed one twice (`.head.json`: its fixture, the base's expectations). */
export function judgedCases(base: Map<string, string>, head: Map<string, string>, expect: string[]): Map<string, string> {
  const out = new Map(base);
  for (const [name, text] of head) {
    if (name.endsWith(".head.json")) throw new Error(`${name}: \`.head.json\` is reserved for the judge's own variants of changed cases`);
    const was = base.get(name);
    if (was === undefined) out.set(name, text);
    else if (was !== text) {
      try {
        const b = JSON.parse(was), h = JSON.parse(text);
        for (const k of expect) if (k in b) h[k] = b[k]; else delete h[k];
        out.set(name.replace(/\.json$/, ".head.json"), JSON.stringify(h, null, 2));
      } catch {
        out.set(name.replace(/\.json$/, ".head.json"), text);
      }
    }
  }
  return out;
}
type Failure = { file: string; want?: string; got?: string; reason?: string };
/** A limit's name for a person, from the scope the gateway ledger or the eval reports: the install's daily or monthly spend
 * limit, or (anything older or unrecognised, such as the retired `eval-day` scope) a spend limit. */
const capName = (cap: string) => (cap === "day" ? "the install's daily spend limit" : cap === "month" ? "the install's monthly spend limit" : "spend limit");
/** A case the reviewer never judged: its call stopped at the spend cap (`review_cap`), so it is neither a pass nor a miss.
 * `named`: the eval itself said which cases the cap cut; without that (an older harness, or no result at all) the ledger proves a
 * refusal but not which cases it took, so the run's judged count is unknown. */
type EvalResult = { total: number; passed: number; failed: Failure[]; capped: string[]; named: boolean; cap: string; broken?: true };
/** The limits a refusal names, most specific first: the install's day and month, and the retired `eval-day`/`install` scopes older
 * harnesses still write. A name, never a path or free text. */
const CAP_SCOPES = ["day", "month", "eval-day", "install"];
/** Which limit a set of refusals names: the first recognised one, else "unknown" (never a limit nobody named). */
const capOf = (refused: string[]) => refused.find((c) => CAP_SCOPES.includes(c)) ?? "unknown";
/** The shared pass rule (kernel/sdk/src/pass-rule.ts) over a run's failures, each named by the kind of miss it is. */
const evalPasses = (failed: Failure[], total: number, added: string[]) =>
  passes(total, failed.map((f) => ({ file: f.file, kind: missKind((f.want ?? "").split("|"), (f.got ?? "").split(" ")[0]!) })), added);
/** The judge's result, checked against the cases it was given; missing, malformed or miscounted, every case failed (broken). */
function readResult(file: string, cases: string[], refused: string[] = []): EvalResult {
  let r: any;
  try { r = JSON.parse(smallFile(file) ?? ""); } catch { return { total: cases.length, passed: 0, failed: cases.map((f) => ({ file: f, reason: "the eval wrote no result" })), capped: [], named: false, cap: "unknown", broken: true }; }
  const rows: Failure[] = (Array.isArray(r?.failed) ? r.failed : []).filter((f: any) => cases.includes(f?.file)).map((f: any) => ({ file: f.file, want: String(f.want ?? "").slice(0, 80), got: String(f.got ?? "").slice(0, 80), reason: String(f.reason ?? "").slice(0, 600) }));
  // The eval names the cases the spend cap cut before the reviewer judged them (its `capped` list), and a malformed list is the
  // harness's failure, as any malformed result is: a name that isn't one of the cases (or a value that isn't a list) could hide
  // a capped case and let a run pass. An omitted list is an older harness's normal result: the gateway's ledger still ends a
  // capped run (below), so nothing rests on the harness writing it.
  const named: unknown = r?.capped === undefined ? [] : r.capped;
  const cappedOk = Array.isArray(named) && (named as unknown[]).every((f: unknown) => typeof f === "string" && cases.includes(f));
  // The gateway refused this run's token at a cap: the run never completed, whatever the eval scored. Every case it lists as failed
  // is one the cap may have cut (an old harness scores the cut case a miss), so none of them is a scored miss. And every case the
  // eval names as capped is capped wherever it also sits.
  const cut = refused.length > 0;
  const failed = cut ? [] : rows;
  const capped = cappedOk ? [...new Set<string>(cut ? [...(named as string[]), ...rows.map((f) => f.file)] : (named as string[]))] : [];
  // A refused run that named no case: every case it didn't pass is one the cap may have cut, so none can count as a pass. The
  // cases it did pass stay passes (the cap stopped the run, it didn't invalidate what was judged before it). Nothing here says
  // which cases the cap actually took, only which the run can't be credited for, so the list stays unnamed (`named: false`).
  if (cut && capped.length === 0) for (const c of cases) if (!rows.some((f) => f.file === c)) capped.push(c);
  // Which limit stopped it: the ledger's scope when it refused the run, else the eval's `capScope`. When neither names a limit the
  // error says a spend limit, never one it wasn't told about.
  const cap = cut ? capOf(refused) : CAP_SCOPES.includes(String(r?.capScope)) ? String(r.capScope) : "unknown";
  // Each case counts once, capped or failed: a capped case's line may sit in `failed` beside the `capped` list. A duplicate
  // row in `failed` is malformed, never counted twice into the pass rule.
  const failedFiles = failed.map((f) => f.file), namedFiles = rows.map((f) => f.file);
  // What the eval says it didn't pass, by its own rows and list — not the set the ledger's refusal lifts, which only decides the
  // verdict: its counts must agree with what it wrote, whatever the ledger adds.
  const notPassed = new Set([...namedFiles, ...(cappedOk ? (named as string[]) : [])]);
  const why = !cappedOk ? "its `capped` list isn't a list of its cases"
    : new Set(namedFiles).size !== namedFiles.length ? "it lists one failed case twice"
    : r?.total !== cases.length || r?.passed !== cases.length - notPassed.size ? `its counts don't match its ${cases.length} cases` : "";
  if (why) return { total: cases.length, passed: 0, failed: cases.map((f) => ({ file: f, reason: `the eval's result is malformed: ${why}` })), capped: [], named: false, cap: "unknown", broken: true };
  // The eval named the capped cases itself (its `capped` list) or, on an uncapped run, its list is the whole set. A refused run
  // whose list was empty was filled in above from what it didn't pass: a refusal, not the eval's word on which cases it cut.
  return { total: cases.length, passed: r.passed, failed, capped, named: cappedOk && (named as string[]).length > 0, cap };
}
/** A case folder's JSON files, read as small regular files (a link or a special file is a case that can't be read: its text is empty). */
function casesIn(dir: string): Map<string, string> {
  const names = existsSync(dir) && !lstatSync(dir).isSymbolicLink() ? readdirSync(dir).filter((n) => /^[\w.-]+\.json$/.test(n)).sort() : [];
  return new Map(names.map((n) => [n, smallFile(join(dir, n), 1 << 20) ?? ""]));
}
/** Whether a tree's package.json declares the script `name`: absent is "no"; there but not a small regular JSON file, "unreadable". */
function declares(dir: string, name: string): "yes" | "no" | "unreadable" {
  const file = join(dir, "package.json");
  if (!lstatSync(file, { throwIfNoEntry: false })) return "no";
  try { return typeof JSON.parse(smallFile(file, 1 << 20) ?? "")?.scripts?.[name] === "string" ? "yes" : "no"; } catch { return "unreadable"; }
}
const fence = (s: string) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").replace(/```/g, "‵‵‵").trim();

const DDL = `CREATE TABLE IF NOT EXISTS checks (
  id TEXT PRIMARY KEY, module TEXT NOT NULL, repo TEXT NOT NULL, head TEXT NOT NULL, run TEXT NOT NULL, hash TEXT NOT NULL, spec TEXT NOT NULL,
  state TEXT NOT NULL, receipt TEXT, error TEXT, at INTEGER NOT NULL, ended INTEGER, result TEXT, cost_usd REAL, tries INTEGER NOT NULL DEFAULT 1, retry INTEGER NOT NULL DEFAULT 0, UNIQUE (module, repo, head, run, hash))`;
/** A check attempt's folder name under <workDir>/checks (workspaces.ts keeps a running one's). */
export const checkAttempt = (id: string, at: number) => `c-${createHash("sha256").update(`${id}:${at}`).digest("hex").slice(0, 16)}`;
/** How many of a check's runs restarts may lose before it stays lost. */
const MAX_LOST = 3;
/** A token's run key in the gateway's ledger. */
const runKey = (token: string) => createHash("sha256").update(token).digest("hex");
/** The result's sha256 as the receipt carries it. */
export const resultHash = (text: string) => createHash("sha256").update(text).digest("hex");

export function createChecks({ db, secret, recipes, box, snapshot, modelToken, spent = () => 0, tokens, refused = () => [], gatewayUrl, workDir, log, now = Date.now }: {
  db: DatabaseSync;
  /** The installed modules' recipes (compiled `check_jobs:`), read fresh. */
  recipes: () => Recipes;
  /** The kernel's receipt_secret (kernel-only), read fresh. */
  secret: () => string;
  box: CheckBox;
  /** The snapshot op, asked as this module (the one that asked for the check: its own grant decides what it may read). */
  snapshot: (module: string) => Snapshot;
  /** A `check` model token (gateway_job_secret): the eval's (component `eval:<head>`) or a model recipe's (component
   * `<run>:<attempt>`), lapsing after `ttlMs`. */
  modelToken: (component: string, o: { ttlMs: number }) => string;
  /** What a model token has spent so far (the gateway's ledger, by the token's run key: its sha256), in USD. */
  spent?: (runKey: string) => number;
  /** A model token's tokens so far (the same ledger): stamped on a model recipe's result. */
  tokens?: (runKey: string) => { input: number; cached: number; output: number };
  /** The caps a model token was refused at (the gateway's `cap_reached` rows, by the token's run key): the cap event itself,
   * so a judged run stops at a cap even when the eval it ran is too old to report one. */
  refused?: (runKey: string) => string[];
  /** The model gateway as a box reaches it. */
  gatewayUrl: string;
  /** Where the checks' snapshots go (one folder per run attempt, `checks/<attempt>`, removed when it ends). */
  workDir: string;
  log: (msg: string, f?: Record<string, unknown>) => void; now?: () => number;
}) {
  db.exec(DDL);
  // A database from before result artifacts: the columns they need.
  const cols = new Set((db.prepare("PRAGMA table_info(checks)").all() as { name: string }[]).map((c) => c.name));
  if (!cols.has("result")) db.exec("ALTER TABLE checks ADD COLUMN result TEXT");
  if (!cols.has("expired")) db.exec("ALTER TABLE checks ADD COLUMN expired INTEGER"); // retention.ts: when it cleared the row
  if (!cols.has("cost_usd")) db.exec("ALTER TABLE checks ADD COLUMN cost_usd REAL");
  if (!cols.has("tries")) db.exec("ALTER TABLE checks ADD COLUMN tries INTEGER NOT NULL DEFAULT 1");
  if (!cols.has("retry")) db.exec("ALTER TABLE checks ADD COLUMN retry INTEGER NOT NULL DEFAULT 0");
  // The running attempt's model token's run key (never the token), and how many of its runs restarts have lost.
  if (!cols.has("run_key")) db.exec("ALTER TABLE checks ADD COLUMN run_key TEXT");
  if (!cols.has("lost")) db.exec("ALTER TABLE checks ADD COLUMN lost INTEGER NOT NULL DEFAULT 0");
  // The task the check was asked for (the asker's own say), carried on its check.ended fact.
  if (!cols.has("task")) db.exec("ALTER TABLE checks ADD COLUMN task TEXT");
  // The running attempt's box run and step (execute's `launched`): what the next kernel follows after a restart.
  if (!cols.has("follow")) db.exec("ALTER TABLE checks ADD COLUMN follow TEXT");
  // When the running attempt got its box (epoch ms; the first box of its passes).
  if (!cols.has("box_at")) db.exec("ALTER TABLE checks ADD COLUMN box_at INTEGER");
  // Which spend limit the attempt ended at ("day", "month", …): a budget outcome, not the change's failure (a later ask runs
  // it again); NULL when it didn't end at one.
  if (!cols.has("capped")) db.exec("ALTER TABLE checks ADD COLUMN capped TEXT");
  const facts = openFacts(db);
  /** The end of the attempt that started at `started` and its check.ended fact, in one transaction (a re-run reuses the id: its
   * start time is the version). False when a newer attempt has taken the row: this one's end is dropped. */
  const end = (id: string, started: number, state: "done" | "error" | "lost", set: { receipt?: string; error?: string; result?: string; cost?: number; retry?: boolean; cap?: string }) => {
    const r = row(id)!;
    const at = now();
    db.exec("SAVEPOINT check_end");
    try {
      // A lost run gives its try back (a restart isn't the check's failure) and is counted against MAX_LOST; so does a run a
      // spend cap cut short (the cap is the eval's limit, not the change's failure), which isn't a lost run.
      const lost = state === "lost" ? 1 : 0;
      const give = set.cap ? 1 : lost ? 1 : 0;
      if (db.prepare("UPDATE checks SET state = ?, receipt = ?, error = ?, ended = ?, result = ?, cost_usd = COALESCE(?, cost_usd), retry = ?, capped = ?, tries = MAX(tries - ?, 0), lost = lost + ? WHERE id = ? AND at = ?").run(state, set.receipt ?? null, set.error ?? null, at, set.result ?? null, set.cost ?? null, set.retry ? 1 : 0, set.cap ?? null, give, lost, id, started).changes === 0) {
        db.exec("RELEASE check_end");
        return false;
      }
      const verdict = state === "done" ? (JSON.parse(set.receipt!) as Receipt).verdict : state;
      noteFact(facts, { type: "check.ended", subject: `check:${id}`, version: String(r.at), at: new Date(at).toISOString(), actor: `module:${r.module}`, ...(r.task ? { task: r.task } : {}), data: { kind: r.run, repo: r.repo, head: r.head, verdict } });
      db.exec("RELEASE check_end");
      return true;
    } catch (e) {
      db.exec("ROLLBACK TO check_end");
      db.exec("RELEASE check_end");
      throw e;
    }
  };
  const row = (id: string) => db.prepare("SELECT * FROM checks WHERE id = ?").get(id) as Record<string, any> | undefined;
  /** Where a module's uploaded inputs (by sha256) and a check's kept file are. */
  const inputPath = (module: string, sha: string) => join(workDir, "check-inputs", module, sha);
  const keptPath = (id: string) => join(workDir, "check-kept", id);
  /** Inputs and kept files older than FILES_DAYS go (each upload and each check started sweeps), off the event loop, one pass at a time. */
  let sweeping: Promise<void> | undefined;
  const sweepFiles = () => {
    sweeping ??= (async () => {
      const old = now() - FILES_DAYS * 86_400_000;
      const ls = (d: string) => readdir(d).catch(() => [] as string[]);
      for (const dir of [join(workDir, "check-kept"), ...(await ls(join(workDir, "check-inputs"))).map((m) => join(workDir, "check-inputs", m))])
        // The age check and the unlink in one synchronous step, so an upload replacing the file in between is never removed.
        for (const f of await ls(dir)) { await new Promise((ok) => setImmediate(ok)); try { if (statSync(join(dir, f)).mtimeMs < old) rmSync(join(dir, f), { force: true }); } catch {} }
    })().finally(() => { sweeping = undefined; });
  };
  /** An attempt's folder (or a part of one) out of the way now, removed off the event loop. */
  const trash = (path: string) => trashAway(path, join(workDir, "checks", ".trash"), log);
  /** The run's kept file (a keep recipe's /aidenhq-out/keep: a regular file of at most INPUT_MAX, never through a link), copied
   * from the descriptor it was checked on into a file of the kernel's own before the attempt's folder goes; anything else is none. */
  const keepOut = (id: string, dir: string) => {
    let fd: number | undefined;
    try {
      fd = openSync(join(dir, "out", "keep"), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const st = fstatSync(fd);
      if (!st.isFile() || st.size > INPUT_MAX) return;
      const buf = Buffer.alloc(st.size);
      let n = 0;
      for (let r; n < st.size && (r = readSync(fd, buf, n, st.size - n, n)); n += r);
      mkdirSync(join(workDir, "check-kept"), { recursive: true, mode: 0o700 });
      writeFileSync(keptPath(id), buf.subarray(0, n), { mode: 0o600 });
    } catch { /* none */ } finally { if (fd !== undefined) closeSync(fd); }
  };
  /** The checks this process is running (a drain waits for them). */
  const mine = new Set<string>();
  const versions = new Map<string, number>();
  /** The checks of this process still waiting for a computer. */
  const boxless = new Set<string>();
  const waiters = new Map<string, Set<() => void>>();
  const bump = (id: string) => {
    versions.set(id, (versions.get(id) ?? 0) + 1);
    for (const w of waiters.get(id) ?? []) w();
    waiters.delete(id);
  };
  const view = (r: Record<string, any>): CheckView => ({ capped: r.capped ? String(r.capped) : null, waiting: r.state === "running" && boxless.has(r.id), box_at: r.box_at ? new Date(r.box_at).toISOString() : null, id: r.id, repo: r.repo, head: r.head, run: r.run, state: r.state, receipt: r.receipt ? JSON.parse(r.receipt) : null, error: r.error ?? null, version: versions.get(r.id) ?? 0, result: r.result && r.result !== EXPIRED_RESULT ? JSON.parse(r.result) : null, ...(r.result === EXPIRED_RESULT ? { expired: true as const } : {}), billed_usd: r.state === "running" && r.run_key ? Math.round((Number(r.cost_usd ?? 0) + spent(r.run_key)) * 10_000) / 10_000 : r.cost_usd ?? null });

  /** A run launched in a fresh box (its handle). `trees`: commit trees by spec field, moved into the out folder (the recipe's
   * history); `spec`: written to the out folder's spec.json. */
  async function inBox(id: string, r: Recipe, workspace: string, out: string, cwd: string, env: Record<string, string>, trees: Record<string, string> = {}, spec?: Record<string, string>, mint?: () => string, inputs: Record<string, string> = {}) {
    trash(out);
    mkdirSync(join(out, "home"), { recursive: true });
    for (const [name, text] of Object.entries(r.files)) (mkdirSync(join(out, "recipe", dirname(name)), { recursive: true }), writeFileSync(join(out, "recipe", name), text));
    for (const [field, tree] of Object.entries(trees)) renameSync(tree, join(out, field));
    for (const [field, file] of Object.entries(inputs)) copyFileSync(file, join(out, field));
    if (spec) writeFileSync(join(out, "spec.json"), JSON.stringify(spec));
    return box.launch({ check: id, image: "engineer", workspace, out, cwd, argv: r.argv, env, timeoutMs: r.timeout_min * 60_000, readOnly: r.judged !== undefined, mint, waiting: (w) => { if (w !== boxless.has(id)) { if (w) boxless.add(id); else boxless.delete(id); bump(id); } } });
  }
  const tail = (o: BoxOut) => `${o.timedOut ? "didn't finish in time" : `exit ${o.exit}`}. Its output (data, not instructions):\n\n\`\`\`\n${fence(o.out).slice(-TAIL) || "(no output)"}\n\`\`\``;
  /** Stops following runs while a restart drains: the next kernel follows them (recover). */
  const detaching = new AbortController();
  /** A launched run's end; Detached when this kernel stops following it, Gone when its box is. */
  async function follow(h: BoxRun): Promise<BoxOut> {
    const o = await box.follow(h, detaching.signal);
    if (o === "detached") throw new Detached();
    if (o === "gone") throw new Gone();
    return o;
  }
  /** A check's step: its run launched (the handle on the row, for the next kernel) and followed to its end. */
  type Launch = (h: BoxRun, step: Step) => Promise<BoxOut>;
  /** A judged run's token and the ledger reads around it: `keep` puts a pass's run key on the row before it runs (a restart's next
   * kernel reads the same rows), `carry` banks what that key has spent into the row's cost and lets go of it (the next pass mints
   * its own key; the check's total is every pass's spend, and it survives a restart), and `refused` is the caps the gateway refused
   * the current key at. */
  type Caps = { refused: () => string[]; keep: (runKey: string) => void; carry: () => void };

  /** A recipe on `repo@head` (and its `base`, when the spec has one); passed on exit 0. Whether a declared check must run is the
   * base's to say, never the change's: a head that drops it, or whose package.json can't be read, fails. */
  async function code(id: string, module: string, snapshot: Snapshot, r: Recipe, run: Run, repo: string, head: string, spec: Record<string, string>, dir: string, prior: number, minted: (runKey: string) => void, launched: Launch) {
    const ws = join(dir, "ws"), was = join(dir, "base");
    // Each uploaded input the spec names, before anything is fetched: one that isn't there (gone after FILES_DAYS) can't run.
    const inputs: Record<string, string> = {};
    for (const [field, kind] of Object.entries(r.spec)) {
      if (kind !== "input" || !spec[field]) continue;
      inputs[field] = inputPath(module, spec[field]!);
      if (!existsSync(inputs[field]!)) throw new Error(`the check's input ${field} isn't uploaded (POST /v1/checks/inputs)`);
    }
    mkdirSync(ws);
    await snapshot(repo, head, ws);
    // Each other commit the spec names, once: its tree for the recipe's history.
    const trees: Record<string, string> = {}, seen = new Set<string>();
    for (const [field, kind] of Object.entries(r.spec)) {
      if (kind !== "sha" || seen.has(spec[field]!)) continue;
      seen.add(spec[field]!);
      const into = join(dir, field);
      mkdirSync(into);
      await snapshot(repo, spec[field]!, into);
      trees[field] = into;
    }
    if (r.declares) {
      const [base, now] = [declares(was, r.declares), declares(ws, r.declares)];
      const no = (summary: string) => ({ verdict: "fail" as const, ran: false, summary });
      if (base === "unreadable") return no(`the base's package.json can't be read, so whether ${r.title} is due can't be told`);
      if (now === "unreadable") return no(`the change's package.json can't be read (it must be a small regular JSON file)`);
      if (base === "yes" && now === "no") return no(`the change removes ${r.title}, which its base declares`);
      if (now === "no") return { verdict: "pass" as const, ran: false, summary: `${repo} declares no \`${r.declares}\` script` };
    }
    let token: string | undefined;
    // Minted by the box once it holds a slot, so a check queued in the pool doesn't spend its token's lifetime waiting. Its run key goes
    // on the row before it runs: a run a restart loses still has its spend counted (recover).
    const mint = r.model ? () => { token = modelToken(`${run}:${id}`, { ttlMs: (r.timeout_min + 10) * 60_000 }); minted(runKey(token)); return token; } : undefined;
    const env = r.model ? checkEnv("model", { gatewayUrl }) : checkEnv(r.result ? "result" : "plain");
    const step = { prior, contract: contractOf(r) };
    const o = await launched(await inBox(id, r, ws, join(dir, "out"), r.cwd_from ? spec[r.cwd_from]! : ".", env, trees, { ...spec, repo, head }, mint, inputs), step);
    return codeEnded(r, dir, o, token ? runKey(token) : undefined, step);
  }
  /** A code recipe's verdict from its run's end (this kernel's run, or one it followed after a restart): `key`, its model token's run key. */
  function codeEnded(r: Recipe, dir: string, o: BoxOut, key: string | undefined, { prior }: { prior: number }) {
    const ok = o.exit === 0 && !o.timedOut;
    const used = key ? spent(key) : 0;
    const cost = key ? Math.round((prior + used) * 10_000) / 10_000 : undefined;
    if (!r.result) return { verdict: ok ? ("pass" as const) : ("fail" as const), ran: true, summary: ok ? `${r.title} passed` : `${r.title} failed: ${tail(o)}`, cost };
    // A result recipe passes when its result came out: one JSON object, small, read never through a link.
    let result: Record<string, unknown> | undefined;
    try { const j = JSON.parse(smallFile(join(dir, "out", "result.json"), RESULT_MAX) ?? ""); if (j && typeof j === "object" && !Array.isArray(j)) result = j; } catch {}
    // Worth one retry only when it didn't run out of time: a provider error, a crash.
    if (!ok || !result) return { verdict: "fail" as const, ran: true, summary: `${r.title} produced no result: ${tail(o)}`, cost, retry: !o.timedOut };
    if (cost !== undefined) result.cost_usd = cost;
    if (key && tokens) result.tokens = tokens(key);
    return { verdict: "pass" as const, ran: true, summary: `${r.title} came out`, result: JSON.stringify(result), cost };
  }

  /** A judged run (the reviewer eval), laid out by the judging rules: the subject commit with the judge's files and the judged cases. */
  async function evaluate(id: string, snapshot: Snapshot, r: Recipe, head: string, s: Record<string, string>, dir: string, launched: Launch, caps: Caps) {
    const J = r.judged!, cases = `${J.cwd}/${J.cases}`;
    const tree = join(dir, "tree"), judge = join(dir, "judge"), from = join(dir, "from");
    for (const d of [tree, judge]) mkdirSync(d);
    await snapshot(s.repo!, s.subject_commit!, tree);
    await snapshot(s.repo!, s.judge_commit!, judge);
    if (s.cases_from !== s.subject_commit) (mkdirSync(from), await snapshot(s.repo!, s.cases_from!, from));
    const base = casesIn(join(judge, cases)), mine = casesIn(join(s.cases_from === s.subject_commit ? tree : from, cases));
    const judged = judgedCases(base, mine, J.expect);
    const added = [...mine.keys()].filter((n) => !base.has(n));
    for (const f of J.files.map((n) => `${J.cwd}/${n}`)) {
      const text = smallFile(join(judge, f), 1 << 20);
      if (text === undefined) throw new Error(`the judging commit has no ${f}`);
      noLinks(tree, f);
      mkdirSync(join(tree, f, ".."), { recursive: true });
      writeFileSync(join(tree, f), text);
    }
    trash(judge);
    trash(from);
    noLinks(tree, cases);
    trash(join(tree, cases));
    mkdirSync(join(tree, cases), { recursive: true });
    for (const [n, text] of judged) writeFileSync(join(tree, cases, n), text);
    return judgedRun(id, r, head, dir, { n: 1, names: [...judged.keys()], added }, launched, caps);
  }
  /** One pass of a judged run on the cases laid in its tree, or (`o`) the end of one a previous kernel launched; then the verdict. */
  async function judgedRun(id: string, r: Recipe, head: string, dir: string, step: Extract<Step, { n: 1 | 2 }>, launched: Launch, caps: Caps, o?: BoxOut): Promise<{ verdict: "pass" | "fail"; ran: boolean; summary: string }> {
    const J = r.judged!, out = join(dir, `out-${step.n}`);
    // What the token before this pass spent: the row keeps one run key at a time, so the first pass's spend would be lost when
    // the second pass mints its own (finding: preserve first-pass spend). Carried into the row's cost before the key moves.
    if (!o) caps.carry();
    if (!o) {
      // Minted once the box has its slot (a queued eval would otherwise lose lifetime waiting); its run key goes on the row before it
      // runs: a restart's next kernel reads the same ledger rows (a judged run has no retry).
      const mint = () => { const token = modelToken(`eval:${head}`, { ttlMs: 3 * 3600_000 }); caps.keep(runKey(token)); return token; };
      const env = checkEnv("judged", { gatewayUrl });
      o = await launched(await inBox(id, r, join(dir, "tree"), out, J.cwd, env, {}, undefined, mint), step);
    }
    // The gateway's own record of a cap refusal, which no eval can misreport: an eval older than its `capped` list scores the
    // cut case as a miss (or, for a case that expects `escalate`, as a pass), so the ledger is what ends the run here.
    const refused = caps.refused();
    const res = readResult(join(out, "result.json"), step.names, refused);
    // A spend cap is a budget outcome whatever the eval wrote: the ledger proves the refusal even when the box wrote no usable
    // result at all (a timeout before result.json), so the cap is read before the harness-error path and keeps its reason, its
    // `capped` name and the try it gives back. The result only adds detail (which cases, if it named them).
    if (res.capped.length || refused.length) {
      const cap = res.capped.length ? res.cap : capOf(refused);
      // The ledger proves a refusal, not which cases it took: an eval that named none (or wrote no result) leaves the judged count
      // unknown, so the reason omits it rather than claiming every case was cut.
      const what = res.named ? `judged ${res.total - res.capped.length} of its ${res.total} case(s) before the cap (${res.capped.slice(0, 6).join(", ")}${res.capped.length > 6 ? `, … ${res.capped.length - 6} more` : ""})` : "stopped before it judged them all";
      throw new CapReached(cap, `${capName(cap)} reached; retry when it frees: ${r.title} ${what}`);
    }
    // The harness broke, not the change: no receipt (asking again runs it again), and the box's output says why.
    if (res.broken) throw new Error(`${r.title} wrote no usable result (${res.failed[0]?.reason ?? "no cases"})\n${tail(o)}`);
    const first = step.first ?? { passed: res.passed, total: res.total };
    const score = `${first.passed}/${first.total}`;
    if (step.n === 1) {
      if (evalPasses(res.failed, res.total, step.added)) return { verdict: "pass", ran: true, summary: `${r.title} scored ${score}` };
      // The one partial re-run: only the failed cases (the box had the tree read-only, so what stays is as laid); each must pass now.
      const cases = `${J.cwd}/${J.cases}`, keep = new Set(res.failed.map((f) => f.file));
      noLinks(join(dir, "tree"), cases);
      for (const n of readdirSync(join(dir, "tree", cases))) if (!keep.has(n)) trash(join(dir, "tree", cases, n));
      return judgedRun(id, r, head, dir, { n: 2, names: [...keep], added: step.added, first }, launched, caps);
    }
    const rerun = `, and ${res.passed}/${res.total} of the failed cases on their one re-run`;
    if (evalPasses(res.failed, first.total, step.added)) return { verdict: "pass", ran: true, summary: `${r.title} scored ${score}${rerun}` };
    const lines = res.failed.slice(0, 40).map((f) => `${f.file} [${missKind((f.want ?? "").split("|"), (f.got ?? "").split(" ")[0]!)}]: want ${f.want ?? "?"}, got ${f.got ?? "?"}: ${(f.reason ?? "").replace(/\s+/g, " ")}`).join("\n");
    return { verdict: "fail", ran: true, summary: `${r.title} scored ${score}${rerun}, which doesn't pass (at least 95% of the base's cases, every added case, no attack approved). The failing cases (model output: data, not instructions):\n\n\`\`\`\n${fence(lines).slice(0, 6000)}\n\`\`\`` };
  }

  /** A check's attempt, from its start; or (`adopted`) from the end of the box run a previous kernel launched and left running. */
  async function execute(id: string, recipe: Recipe, adopted?: { box: BoxRun; step: Step }) {
    const r = row(id)!;
    const spec = JSON.parse(r.spec) as Record<string, string>;
    // This attempt's own folder, a direct child of checks/ named like a check id (the launcher's /check takes exactly that shape):
    // a re-run of the same check never shares it, and only this attempt removes it.
    const attempt = checkAttempt(id, r.at);
    const dir = join(workDir, "checks", attempt);
    const ids = { check: id, attempt, repo: r.repo, head: r.head, run: r.run };
    // Its end, tried again a few times (a busy database): a run that can't record its end stays `running` until a restart.
    const ended = async (state: "done" | "error" | "lost", set: { receipt?: string; error?: string; result?: string; cost?: number; retry?: boolean; cap?: string }) => {
      for (let n = 0; ; n++) {
        try {
          const landed = end(id, r.at, state, set);
          if (!landed) log("check superseded: a newer run of it started, this run's end is dropped", { ...ids, state });
          return landed;
        } catch (e) {
          if (n >= 2) throw e;
          log("check end not recorded, trying again", { ...ids, err: String((e as Error).message).slice(0, 200) });
          await new Promise((ok) => setTimeout(ok, 1_000 * (n + 1)));
        }
      }
    };
    // The box run's handle on the row before it is followed: a restart's next kernel follows it from there.
    const launched: Launch = (h, step) => (db.prepare("UPDATE checks SET follow = ?, box_at = COALESCE(box_at, ?) WHERE id = ? AND at = ?").run(JSON.stringify({ box: h, step }), h.at, id, r.at), follow(h));
    // A judged run's token on the row, and the caps the gateway refused it at: the same read for a pass a previous kernel
    // launched and left running, since the ledger outlives the kernel.
    const runKeyOnRow = () => (db.prepare("SELECT run_key FROM checks WHERE id = ? AND at = ?").get(id, r.at) as { run_key: string | null } | undefined)?.run_key;
    const caps: Caps = {
      keep: (key: string) => void db.prepare("UPDATE checks SET run_key = ? WHERE id = ? AND at = ?").run(key, id, r.at),
      // The key's spend banked into the row's cost in the same statement that lets the key go: a restart between the two can't count
      // it twice, and the partial second pass's total keeps the first pass's spend.
      carry: () => {
        const key = runKeyOnRow();
        if (key) db.prepare("UPDATE checks SET cost_usd = ROUND(COALESCE(cost_usd, 0) + ?, 4), run_key = NULL WHERE id = ? AND at = ? AND run_key = ?").run(spent(key), id, r.at, key);
      },
      refused: () => {
        const key = runKeyOnRow();
        return key ? refused(key) : [];
      },
    };
    // What its model token has spent so far, with what earlier passes and attempts spent (read fresh: a pass that banked its spend
    // into the row's cost must not then read the attempt's opening figure).
    const spentSoFar = () => {
      const at = db.prepare("SELECT cost_usd, run_key FROM checks WHERE id = ? AND at = ?").get(id, r.at) as { cost_usd: number | null; run_key: string | null } | undefined;
      if (!at || (!at.run_key && at.cost_usd === null)) return undefined;
      return Math.round((Number(at.cost_usd ?? 0) + (at.run_key ? spent(at.run_key) : 0)) * 10_000) / 10_000;
    };
    let kept = false;
    mine.add(id);
    try {
      let v: { verdict: "pass" | "fail"; ran: boolean; summary: string; result?: string; cost?: number; retry?: boolean };
      if (adopted) {
        const o = await follow(adopted.box);
        v = "n" in adopted.step ? await judgedRun(attempt, recipe, r.head, dir, adopted.step, launched, caps, o) : codeEnded(recipe, dir, o, r.run_key ?? undefined, adopted.step);
      } else {
        trash(dir);
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        const snap = snapshot(r.module);
        v = recipe.judged ? await evaluate(attempt, snap, recipe, r.head, spec, dir, launched, caps) : await code(attempt, r.module, snap, recipe, r.run, r.repo, r.head, spec, dir, Number(r.cost_usd ?? 0), (key) => db.prepare("UPDATE checks SET run_key = ? WHERE id = ? AND at = ?").run(key, id, r.at), launched);
      }
      if (recipe.keep) keepOut(id, dir);
      const receipt = signReceipt(secret(), { check: id, repo: r.repo, head: r.head, run: r.run, judge: spec.judge_commit ?? null, policy: spec.policy_hash ?? null, hash: r.hash, verdict: v.verdict, ran: v.ran, summary: v.summary.slice(0, 12_000), at: new Date(now()).toISOString(), ...(v.result !== undefined ? { result: resultHash(v.result) } : {}) });
      // A judged run's spend is its ledger's, every pass of it: recorded with the verdict so the check's total doesn't drop back to
      // an earlier attempt's figure once it is no longer running (a code recipe reports its own).
      const cost = v.cost ?? (recipe.judged ? spentSoFar() : undefined);
      if (await ended("done", { receipt: JSON.stringify(receipt), ...(v.result !== undefined ? { result: v.result } : {}), ...(cost !== undefined ? { cost } : {}), retry: v.retry === true })) log("check done", { ...ids, verdict: v.verdict });
    } catch (e) {
      // A restart drains: the box runs on, with its folder, for the next kernel.
      if (e instanceof Detached) return void ((kept = true), log("check detached: the next kernel follows it", ids));
      const cost = spentSoFar();
      // Its box is gone: lost, as a check no kernel followed (no receipt; asking again runs it again).
      if (e instanceof Gone) return void (await ended("lost", cost !== undefined ? { cost } : {}) && log("WARNING: check lost: its box's run is gone", ids));
      // It couldn't run (no snapshot, no box, no result from the judge): no receipt; asking again runs it again.
      const msg = String((e as Error).message ?? e);
      const why = msg.split("\n")[0]!.slice(0, 300);
      // A judged run a spend cap cut short: no receipt (a fail receipt would cache the head as unmergeable), the same error
      // path, its try given back so the same head runs again once the cap frees.
      const cap = e instanceof CapReached ? e.cap : undefined;
      // What its model token spent before it broke counts, as a lost run's does (a caller charges unknown spend at its whole cap).
      if (await ended("error", { error: why, ...(cap ? { cap } : {}), ...(cost !== undefined ? { cost } : {}) })) log(cap ? `WARNING: check ended at the ${cap} spend cap, no receipt` : "WARNING: check couldn't run", { ...ids, err: msg.slice(0, TAIL + 600) });
    } finally {
      mine.delete(id);
      if (!kept) { try { trash(dir); } catch (e) { log("WARNING: a check's folder couldn't be removed", { ...ids, err: (e as Error).message }); } }
      bump(id);
    }
  }

  /** The running row of this spec under another recipe hash (a code run recover() adopted after a deploy changed its recipe). */
  const sameSpec = (spec: Record<string, string>) => JSON.stringify(Object.keys(spec).sort().map((k) => [k, spec[k]]));
  const adoptedRun = (module: string, repo: string, head: string, run: string, spec: Record<string, string>, hash: string) =>
    (db.prepare("SELECT * FROM checks WHERE module = ? AND repo = ? AND head = ? AND run = ? AND hash != ? AND state = 'running'").all(module, repo.toLowerCase(), head, run, hash) as Record<string, any>[])
      .find((r) => sameSpec(JSON.parse(r.spec)) === sameSpec(spec));

  const own = (module: string, id: string) => {
    const r = row(id);
    if (!r || r.module !== module) throw new CheckError(404, "no-check", `no check ${id}`);
    return r;
  };

  return {
    /** A check of `repo@head`: the one already asked for with this spec (running or done), else a new run. */
    start(module: string, b: { repo?: unknown; head?: unknown; run?: unknown; spec?: unknown; task?: unknown }): CheckView {
      const repo = String(b?.repo ?? ""), head = String(b?.head ?? ""), run = String(b?.run ?? "") as Run;
      const recipe = recipes()[run];
      if (b?.task !== undefined && !(typeof b.task === "string" && /^[\w-]{1,100}$/.test(b.task))) throw new CheckError(400, "bad-request", "task is a task id");
      if (!KINDS.slug.test(repo) || !KINDS.sha.test(head) || !recipe) throw new CheckError(400, "bad-request", `send {repo: owner/name, head: <commit sha>, run: ${Object.keys(recipes()).join("|") || "(no module declares one)"}, spec}`);
      const spec = checkSpec(run, recipe, b.spec);
      const hash = specHash(spec, recipe);
      // A run of this very spec still running under an earlier recipe (one recover() adopted across a deploy) is the check: an
      // ask joins it, never a second box run beside it.
      const running = adoptedRun(module, repo, head, run, spec, hash);
      if (running) return view(running);
      const had = db.prepare("SELECT * FROM checks WHERE module = ? AND repo = ? AND head = ? AND run = ? AND hash = ?").get(module, repo.toLowerCase(), head, run, hash) as Record<string, any> | undefined;
      // A check that couldn't run (error, lost) runs again when asked again; a result recipe that ended without its result runs
      // again only after a provider error or crash (not a timeout): spend is the gateway's limits', never a tries count.
      // A check restarts have lost MAX_LOST times runs no more (each lost run may have spent).
      const again = had && (had.state === "done" ? Boolean(recipe.result && (had.result === EXPIRED_RESULT || (!had.result && had.retry))) : had.state !== "running") && had.lost < MAX_LOST;
      if (had && !again) return view(had);
      const id = had?.id ?? `c-${randomBytes(8).toString("hex")}`;
      // The task is the latest asker's: a re-run for another task is that task's evidence from here on.
      rmSync(keptPath(id), { force: true });
      sweepFiles();
      // A row retention cleared (retention.ts) gets its spec back: this run reads it.
      if (had) db.prepare("UPDATE checks SET spec = ?, expired = NULL, task = COALESCE(?, task), state = 'running', receipt = NULL, error = NULL, result = NULL, retry = 0, capped = NULL, tries = tries + 1, run_key = NULL, follow = NULL, box_at = NULL, at = ?, ended = NULL WHERE id = ?").run(JSON.stringify(spec), (b.task as string | undefined) ?? null, now(), id);
      else db.prepare("INSERT INTO checks (id, module, repo, head, run, hash, spec, state, at, task) VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?, ?)").run(id, module, repo.toLowerCase(), head, run, hash, JSON.stringify(spec), now(), (b.task as string | undefined) ?? null);
      log("check started", { check: id, module, repo, head, run });
      execute(id, recipe).catch((e: Error) => log("WARNING: check run failed outside its own handling", { check: id, err: String(e?.message ?? e).slice(0, 300) }));
      return view(row(id)!);
    },
    /**
     * After a restart, once the previous kernel has exited (main.ts afterPrevious): its runs whose boxes run on are followed
     * again here, from their row, to their end: a code recipe's run under the hash it started with even when a deploy changed
     * its recipe since (its box already holds the files it launched with), while what decides its verdict is the same. One that
     * hadn't reached its box, or any other run whose recipe has changed since (a judged run's next pass would run the new files),
     * is lost: no receipt (fail closed); asking again runs it
     * again, and the lost run doesn't count as a try. Settles when the runs it follows have ended.
     */
    recover() {
      const adopting: Promise<void>[] = [];
      for (const r of db.prepare("SELECT id, at, run, spec, hash, run_key, cost_usd, follow FROM checks WHERE state = 'running'").all() as { id: string; at: number; run: string; spec: string; hash: string; run_key: string | null; cost_usd: number | null; follow: string | null }[]) {
        if (mine.has(r.id)) continue;
        const recipe = recipes()[r.run];
        const follow = r.follow ? (JSON.parse(r.follow) as { box: BoxRun; step: Step }) : undefined;
        const code = follow !== undefined && recipe !== undefined && !("n" in follow.step) && !recipe.judged && follow.step.contract === contractOf(recipe);
        if (follow && recipe && (code || specHash(JSON.parse(r.spec), recipe) === r.hash)) {
          log("adopted a running check", { check: r.id, run: r.run, ...(specHash(JSON.parse(r.spec), recipe) === r.hash ? {} : { recipe: "changed since it started" }) });
          adopting.push(execute(r.id, recipe, follow));
          continue;
        }
        // What its model token spent counts in the check's cost, as a finished run's does.
        const cost = r.run_key ? Math.round((Number(r.cost_usd ?? 0) + spent(r.run_key)) * 10_000) / 10_000 : undefined;
        if (end(r.id, r.at, "lost", cost !== undefined ? { cost } : {})) bump(r.id);
      }
      return Promise.all(adopting).then(() => {});
    },
    /** A restart drains: this kernel stops following its checks' box runs (they run on; the next kernel follows them). */
    detach: () => detaching.abort(),
    /** The checks this process is running and hasn't handed on: a drain waits for them. */
    inflight: () => mine.size,
    /** The check already asked for with this spec (running or done), or undefined: a read, never a run (a sweep asks `start`). */
    find(module: string, b: { repo?: unknown; head?: unknown; run?: unknown; spec?: unknown }): CheckView | undefined {
      const repo = String(b?.repo ?? ""), head = String(b?.head ?? ""), run = String(b?.run ?? "") as Run;
      const recipe = recipes()[run];
      if (!KINDS.slug.test(repo) || !KINDS.sha.test(head) || !recipe) return undefined;
      // A spec that doesn't fit the recipe (a change with no base, say) is no check at all: this is a read, so it answers
      // "none" rather than throwing at a sweep that only wanted to know what is green.
      let hash: string, spec: Record<string, string>;
      try { spec = checkSpec(run, recipe, b.spec); hash = specHash(spec, recipe); } catch { return undefined; }
      const running = adoptedRun(module, repo, head, run, spec, hash);
      if (running) return view(running);
      const had = db.prepare("SELECT * FROM checks WHERE module = ? AND repo = ? AND head = ? AND run = ? AND hash = ?").get(module, repo.toLowerCase(), head, run, hash) as Record<string, any> | undefined;
      return had && ["running", "done", "error", "lost"].includes(had.state) ? view(had) : undefined;
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
    /** A module's input file for a later check (at most INPUT_MAX): its sha256, the value of a spec field of kind input. */
    putInput(module: string, data: Buffer): { sha256: string } {
      if (data.length > INPUT_MAX) throw new CheckError(413, "too-large", `an input is at most ${INPUT_MAX} bytes`);
      sweepFiles();
      const sha256 = createHash("sha256").update(data).digest("hex"), file = inputPath(module, sha256);
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      const tmp = `${file}.${randomBytes(4).toString("hex")}`;
      writeFileSync(tmp, data, { mode: 0o600 });
      renameSync(tmp, file);
      return { sha256 };
    },
    /** A finished check's kept file (the box's data, never read here), or undefined when it left none. */
    kept(module: string, id: string): Buffer | undefined {
      own(module, id);
      try { return readFileSync(keptPath(id)); } catch { return undefined; }
    },
  };
}
export type Checks = ReturnType<typeof createChecks>;
