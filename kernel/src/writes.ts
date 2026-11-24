// K6, the write lifecycle (spec §5.3) for every write kind: the modules' (manifest `writes:`, compiled to
// config/kernel/writes.json), the kernel's own (kinds.ts), and the implicit kind conn.tool (a write or destructive tool
// mapped to no kind). Filing: grant check → plan → args schema → tier (K5) → card → record. A module kind is planned by its
// executor (executor@1, sdk/src/executor.ts: a module's service, or one the kernel runs in process, codehost-local's);
// kernel.apply by the kernel's planner. A code host action (`codehost.<action>`) is filed as the kind of the host that owns its
// repos (codehost.ts routeKind). Tier 0 is claimed at filing and
// executed at once; Tier 1 and 2 go to the reviewer: the kernel's review loop gathers what it reads, sends it to the bound
// reviewer module, holds the verdict to the record's review-first, and moves the record (the owner decides next, by
// channel token or the kernel's page). Approved: claimed once → revalidated (a module kind: the same executor and policy,
// and plan again: the same digest, else stale and refiled) → executed. Before the tier, the modules' write.filed checks on the
// kind run (config/kernel/checks.json, in process: filedRaises): each raises or refuses the write, never lowers it. A conn.tool record is executed by the proxy itself;
// kernel.apply by the kernel.
import http from "node:http";
import { createHash } from "node:crypto";
import { neutral } from "./channels.ts";
import type { Connection, Identity } from "./identity.ts";
import type { Resolver } from "./net.ts";
import { UPDATER, canonical, isUpdater, digestOf, type Card, type Rec, type Records, type Requester } from "./records.ts";
import type { Reviews } from "./reviews.ts";
import { LOCAL_ORG, repoKey, type Repos } from "./kinds.ts";
import { openRefusals, markRefusal } from "./refusals.ts";
import { CODEHOSTS, routeKind } from "./codehost.ts";
import type { Executor, ReviewContext } from "../sdk/src/executor.ts";
import { gateMode } from "./gates.ts";
import { identifierRefused } from "./task-identifier.ts";
import { codeRefusal } from "./review-loop.ts";
import { AUTONOMY, RETRY_MS, retryWait, capText, computeTier, shadowed, type Autonomy, type Raise, type Cap, type Tier, type Verdict } from "./tier.ts";

export type Schema = { type?: string; properties?: { [k: string]: Schema }; required?: string[]; additionalProperties?: boolean; enum?: unknown[]; pattern?: string; minLength?: number; maxLength?: number; items?: Schema; minItems?: number; maxItems?: number; minimum?: number; maximum?: number; exclusiveMinimum?: number };
/** The target fields a head-bound kind can bind to: what it acts on, per target, instead of its whole plan. */
export type Bind = "repo" | "ref" | "commit";
/**
 * One kind (config/kernel/writes.json and kinds.ts, keyed `<module>.<kind>`); `tools` are `connection.tool`.
 * `binds`: a head-bound write (a review post on one commit): staleness is judged on these target fields alone, not on the
 * executor's code revision, the kind's declaration, its args or its other targets (writes.ts `boundOf`).
 * `filer: owner`: only the owner's own verified save files it (fileKernel `owner`); no job, module or agent can.
 * `stale: fail`: a record whose plan changed after the decision fails ("preview again") instead of being filed again.
 */
export type Kind = { module: string; floor: Tier; filed_by?: string[]; binds?: Bind[]; filer?: "owner"; stale?: "fail"; tools: string[]; card?: Partial<Card>; args?: Schema; executor?: { url: string; auth_secret: string; rev?: string } };
/** A plan (executor@1's, or the kernel's own planner's). */
type Plan = { args: unknown; targets?: { [k: string]: unknown }; facts?: { [k: string]: unknown }; raise?: Raise; paths?: unknown; card?: { [k: string]: string }; satisfied?: { evidence: string }; review?: ReviewContext };
/** A write.filed check as config/kernel/checks.json holds it (`<module>.<id>`): the kinds it runs on. */
export type FiledCheck = { module: string; at: string; kinds?: string[]; mode?: unknown };
/** A write.filed check's code, run in process on a filing: its verdict (`ok`, `raise` tier 1 or 2, or `deny`) raises or refuses, never lowers. */
export type FiledCheckFn = (input: { kind: string; args: unknown; paths: unknown; facts: { productRepo?: string } }) => { verdict: string; tier?: number; rule?: string; reason?: string };
/** The kernel's own planner for one of its kinds (kernel.apply: apply-tier.ts), in place of an executor's plan. */
export type Planner = (b: { kind: string; args: unknown; requester: Requester; task: string; workspace?: string }) => Promise<Plan>;
export const CONN_TOOL = "conn.tool";
/**
 * The largest serialised conn.tool payload a card may carry, measured with the JSON.stringify the card builds.
 */
export const CONN_TOOL_ARGS_MAX = 100_000;
/**
 * The most an executor's answer may carry: a plan brings the change's diff and every changed file whole for the reviewer
 * (the reviewer module takes a request up to the same size). Held only while the record is open (records.ts).
 */
const PLAN_MAX = 64_000_000;
const fail = (status: number, type: string, message: string, code?: string) => Object.assign(new Error(message), { status, type, ...(code ? { code } : {}) });

/** The kind's strict args schema: a small subset of JSON Schema, enough for tool arguments and the kernel's kinds. Throws with the first problem. */
export function validate(s: Schema, v: unknown, at = "args"): void {
  const bad = (why: string) => { throw fail(400, "bad_args", `${at} ${why}`); };
  const type = Array.isArray(v) ? "array" : v === null ? "null" : Number.isInteger(v) ? "integer" : typeof v;
  if (s.type && !(s.type === type || (s.type === "number" && type === "integer"))) bad(`must be ${s.type}`);
  if (s.enum && !s.enum.some((e) => canonical(e) === canonical(v))) bad(`must be one of ${s.enum.map((e) => JSON.stringify(e)).join(", ")}`);
  if (typeof v === "string") {
    if (s.pattern && !new RegExp(s.pattern, "u").test(v)) bad(`doesn't match ${s.pattern}`);
    if (v.length < (s.minLength ?? 0) || v.length > (s.maxLength ?? Infinity)) bad("has the wrong length");
  }
  if (typeof v === "number" && (v < (s.minimum ?? -Infinity) || v > (s.maximum ?? Infinity) || (s.exclusiveMinimum !== undefined && v <= s.exclusiveMinimum))) bad("is out of range");
  if (Array.isArray(v)) {
    if (v.length < (s.minItems ?? 0) || v.length > (s.maxItems ?? Infinity)) bad("has the wrong number of items");
    if (s.items) v.forEach((x, i) => validate(s.items!, x, `${at}[${i}]`));
  }
  if (type === "object") {
    const o = v as { [k: string]: unknown };
    for (const k of s.required ?? []) if (o[k] === undefined) bad(`needs ${k}`);
    for (const [k, x] of Object.entries(o)) {
      if (s.properties?.[k]) validate(s.properties[k], x, `${at}.${k}`);
      else if (s.additionalProperties === false) bad(`has no field ${k}`);
    }
  }
}

/** Card text from the kind's templates over args, facts and the planner's card values: {{name}} only, printable, capped. */
/** What a card stores and shows of its details; a reviewed card's whole details ride in its context (the reviewer's input). */
const DETAILS_MAX = 80_000;
export function render(t: Partial<Card>, values: { [k: string]: unknown }, detailsMax = DETAILS_MAX): Card {
  const val = (k: string) => { const v = values[k]; return v == null ? "" : typeof v === "string" ? v : JSON.stringify(v); };
  const one = (s: string | undefined, max: number, keepLines = false) => String(s ?? "").replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, k) => val(k)).replace(/[\p{Cc}\p{Cf}]/gu, (c) => (keepLines && (c === "\n" || c === "\t") ? c : " ")).slice(0, max);
  return { sentence: one(t.sentence, 300), changes: one(t.changes, 8000, true), reads: one(t.reads, 1000), cost: one(t.cost, 300), details: one(t.details, detailsMax, true), ...(t.target !== undefined ? { target: one(t.target, 500) } : {}) };
}
/** A planner's own card text as the template: each field is its value. */
const literal = (c: Partial<Card>) => Object.fromEntries(Object.keys(c).filter((k) => k !== "reason").map((k) => [k, `{{${k}}}`])) as Partial<Card>;

/** Text a module wrote, inside a fence it can't close, for a notice posted on a task. */
export const fenced = (text: string) => { const f = "`".repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map((m) => m[0].length + 1))); return `${f}\n${text}\n${f}`; };
export const MARKER = "<!-- aidenhq-approval -->";
/** Marks a comment as a wake notice too: dispatch reads it as data that wakes the agent, never the owner's words (escalate.ts). */
export const WAKE_MARK = "<!-- aidenhq-wake -->";
const MODEL = /^~?[\w.-]+\/[\w.:-]+$/;

/** The setting ai_review_code (the ai-reviewer module's) and the repos code review gates (a mandatory combo), as compiled. */
export type ReviewCode = { mode?: string; mandatory?: string[] };
/**
 * Whether code review owns a write instead of the AI reviewer (ai_review_code): only a code host's push or PR, and only when
 * every repo it names is skipped, `none` for every repo, `unless_code_review_mandatory` for those whose code review is
 * mandatory. Everything else (merges, closes, create_repo, sends, settings, deploys, tool calls) is always reviewed.
 */
export function codeReviewOwns(r: Pick<Rec, "kind" | "targets">, { mode = "all", mandatory = [] }: ReviewCode) {
  if (!/^(github|codehost-local)\.(push|pr)$/.test(r.kind) || mode === "all") return false;
  const repos = Object.values(r.targets ?? {}).map((t) => String((t as { repo?: unknown })?.repo ?? "").toLowerCase());
  return repos.length > 0 && repos.every((repo) => repo && (mode === "none" || (mode === "unless_code_review_mandatory" && mandatory.includes(repo))));
}

/** A plan's `paths` ([{repo, files: [{path}]}], code host plans) as `repo:path` strings, kept on the record for task search. */
function planPaths(p: unknown): string[] | null {
  const out = (Array.isArray(p) ? p : []).flatMap((x: { repo?: unknown; files?: { path?: unknown }[] }) => (Array.isArray(x?.files) ? x.files : []).filter((f) => typeof f?.path === "string").map((f) => `${String(x.repo ?? "")}:${f.path}`));
  return out.length ? out.slice(0, 500) : null;
}

export function createWrites({ records, registry, connections, secret, resolver, reviews, autonomy = () => "full", repos = () => ({}), reviewCode = () => ({}), checks = () => ({}), filedChecks = {}, onTask, taskIdentifier, replay, native = {}, planners = {}, executors = () => ({}), resume = [], log = () => {} }: {
  records: Records; registry: () => { [kind: string]: Kind }; connections: () => { [c: string]: Connection }; secret: (n: string) => string; resolver: Resolver;
  /** The bound reviewer module (reviews.ts): every record's review goes there. */
  reviews?: Reviews;
  autonomy?: () => Autonomy;
  /** The product and instance repositories (the filed checks' facts). */
  repos?: () => Repos;
  /** ai_review_code and the mandatory code-review repos (codeReviewOwns), read on each review. */
  reviewCode?: () => ReviewCode;
  /** The checks registry (config/kernel/checks.json, the finish gate's too): its write.filed entries run on every filing of their kinds; one that won't load throws. */
  checks?: () => Record<string, FiledCheck>;
  /** The write.filed checks' code, by `<module>.<id>` (the platform check): run in process. */
  filedChecks?: Record<string, FiledCheckFn>;
  /** The task a record is on: still open (and its parent), and a notice on it (fixed text; the module's words only fenced). */
  onTask: {
    /** `parent`: the notice goes to the task's parent (notices.ts), if it has one. */
    open(task: string): Promise<boolean>; /** `tag`: what makes two notices with the same text distinct (a wait's reason), never shown. */
    notify(task: string, text: string, o?: { parent?: boolean; close?: "done" | "cancelled"; tag?: string }): Promise<void>;
    /** A task a conn.tool call names, and why its agent may write there (cp.ts scopeOf); undefined when there is no such task. */
    scope?(task: string, agent: string): Promise<{ id: string; identifier?: string | null; scope?: "own" | "created" | "child" } | undefined>;
  };
  /**
   * A task's canonical identifier, as the control plane reads it (main.ts: `GET /api/issues/<id>`). A record a module or the
   * kernel files on a named task has no job row to take it from; it is read here so the record is on the task by both ids.
   * Undefined when the task answers with none (gone, or no identifier): the record stays without one and a code host's guard
   * fails closed. A failed read throws (a retryable 503): an identifier-less record the queue can never land is worse.
   */
  taskIdentifier?: (task: string) => Promise<string | undefined>;
  /** Executes an approved conn.tool record: the stored call, through the proxy, as its requester. */
  replay: (r: Rec) => Promise<{ ok: boolean; text: string }>;
  /** The kernel's own executors, by kind (kernel.apply). */
  native?: { [kind: string]: (r: Rec) => Promise<{ ok: boolean; text: string }> };
  /** The kernel's planners for its own kinds (kernel.apply): filed through request() like a module kind, planned here. */
  planners?: { [kind: string]: Planner };
  /** Executors the kernel runs in process, by module (codehost-local's, while it is enabled): in place of a service's. */
  executors?: () => { [module: string]: Executor };
  /** Native kinds whose executor carries on from where it was: a claimed record of one is run again after a restart (kernel.apply). */
  resume?: string[];
  log?: (msg: string, f?: { [k: string]: unknown }) => void;
}) {
  openRefusals(records.db);
  const waiters = new Map<string, ((r: Rec) => void)[]>();
  const settled = (r: Rec) => { for (const w of waiters.get(r.id) ?? []) w(r); waiters.delete(r.id); };
  const policy = (k: Kind) => createHash("sha256").update(canonical({ ...k, executor: undefined })).digest("hex").slice(0, 32);
  const kindOf_ = (kind: string) => (Object.hasOwn(registry(), kind) ? registry()[kind] : undefined);

  const inProcess = (k: Kind | undefined) => (k && Object.hasOwn(executors(), k.module) ? executors()[k.module] : undefined);
  async function call(k: Kind, op: "plan" | "execute" | "status", body: unknown): Promise<any> {
    const own = inProcess(k);
    if (own && op === "plan") return own.plan(body as never).catch((e: Error & { status?: number; code?: string }) => { throw e.status && e.status >= 500 ? e : fail(422, "refused", String(e.message).slice(0, 1000), e.code); });
    if (own) throw fail(500, "no_executor", `${k.module} runs in process: no ${op} call`);
    if (!k.executor) throw fail(500, "no_executor", `${k.module} declares no executor`);
    const key = secret(k.executor.auth_secret);
    if (!key) throw fail(503, "no_service_key", `${k.module}'s executor key is missing`);
    const to = await resolver.resolve(`${k.executor.url.replace(/\/$/, "")}/${op}`);
    const data = Buffer.from(JSON.stringify(body));
    return new Promise((resolve, reject) => {
      const req = http.request({ host: to.host, port: to.port, path: to.path, method: "POST", timeout: 30_000, headers: { host: new URL(k.executor!.url).host, authorization: `Bearer ${key}`, "content-type": "application/json", "content-length": data.length } }, (res) => {
        let text = "";
        res.setEncoding("utf8").on("data", (c) => { if (text.length < PLAN_MAX) text += c; }).on("end", () => {
          let j: any;
          try { j = JSON.parse(text); } catch { return reject(fail(502, "bad_executor", `${k.module}'s ${op} answered ${res.statusCode} with no JSON`)); }
          // A 4xx is the executor's refusal; a 5xx (a module starting, or failing) is no answer yet.
          if ((res.statusCode ?? 500) >= 500) return reject(fail(502, "bad_executor", String(j?.error ?? `${k.module}'s ${op} answered ${res.statusCode}`).slice(0, 1000)));
          // A refusal carries its rule's stable code beside its words when the executor sends one (the plan's `rule`/`code`).
          if ((res.statusCode ?? 500) >= 300) return reject(fail(422, "refused", String(j?.error ?? `${k.module}'s ${op} answered ${res.statusCode}`).slice(0, 1000), typeof j?.code === "string" && j.code ? j.code.slice(0, 80) : undefined));
          resolve(j);
        });
      });
      req.on("timeout", () => req.destroy(fail(504, "timeout", `${k.module}'s ${op} didn't answer in 30 s`)));
      req.on("error", (e) => { resolver.forget(k.executor!.url); reject((e as { status?: number }).status ? e : fail(502, "bad_executor", `${k.module}'s executor is unreachable (${e.message})`)); });
      req.end(data);
    });
  }

  /** A kernel job holding the `session` role on its frozen authority (admission.ts gives it only to a session profile). */
  const sessionOf = (who: Identity) => who.kind === "run" && Boolean(who.job) && who.roles.includes("session");
  const requesterOf = (who: Identity, task: string): Requester => ({ agent: who.agent ?? "", key: who.key ?? "", name: who.name ?? "", roles: who.roles, kind: who.kind, ...(task ? { task } : {}), ...(who.run ? { run: who.run } : {}), ...(who.module ? { module: who.module } : {}), ...(who.model ? { model: who.model } : {}) });
  const conn = (connection: string) => (Object.hasOwn(connections(), connection) ? connections()[connection] : undefined);

  /** The kind a connection's tool is routed into: a declared kind, conn.tool for an unmapped write or destructive tool, else none. */
  function kindOf(connection: string, tool: string): string | undefined {
    const ct = `${connection}.${tool}`;
    const hit = Object.entries(registry()).find(([, k]) => k.tools.includes(ct));
    if (hit) return hit[0];
    const c = conn(connection);
    return c && (c.tools.write.includes(tool) || c.tools.destructive.includes(tool)) ? CONN_TOOL : undefined;
  }

  /**
   * What a head-bound kind (`binds`) acts on, from its plan's targets: each target's named fields, keyed as the plan keys it.
   * Undefined when a target isn't an object or lacks a bound field: a plan that names nothing it binds to is stale, never valid.
   */
  function boundOf(targets: Record<string, unknown>, fields: readonly string[]): string | undefined {
    // No prototype: a planner can key a target `__proto__`, and a plain object would take that assignment as its prototype
    // instead of an own property, dropping that target from the comparison and letting the record run on a changed commit.
    const out: Record<string, Record<string, unknown>> = Object.create(null);
    for (const [key, t] of Object.entries(targets)) {
      if (!t || typeof t !== "object" || Array.isArray(t)) return undefined;
      const pick: Record<string, unknown> = Object.create(null);
      for (const f of fields) {
        const v = (t as Record<string, unknown>)[f];
        if (v === undefined || v === null || v === "") return undefined;
        pick[f] = v;
      }
      out[key] = pick;
    }
    return Object.keys(out).length ? canonical(out) : undefined;
  }

  /** The autonomy a requester's write is tiered under: the instance's, except the release updater's own filing (full). */
  const autonomyOf = (q: Requester): Autonomy => (isUpdater(q) ? "full" : autonomy());
  /**
   * Revalidate at execution: a record the AI reviewer approved runs only while its yes still stands under the autonomy now.
   * Tightened since: held for the owner instead (false).
   */
  async function revalidate(r: Rec): Promise<boolean> {
    if (!r.decided_by?.startsWith("reviewer:") || autonomyOf(r.requester) === "full") return true;
    const cap: Cap = { by: "autonomy", value: autonomy() };
    records.hold(r.id, cap, `since the AI reviewer approved it, ${capText(cap)}, so the owner decides`);
    return false;
  }

  /**
   * The write.filed checks on `kind`, each run on the plan (its args and the files it changes): their raises, for the tier.
   * Fail closed: a registry that won't load, a check with no code here, or one that throws or answers malformed refuses the
   * filing (503); a check's deny refuses it (422, the job's refusal). They always enforce (gates.ts: never observe).
   */
  function filedRaises(kind: string, plan: Plan): Raise[] {
    const unavailable = (why: string) => fail(503, "check_failed", `the write checks are unavailable (${why}): nothing was filed; try again`);
    let mine: [string, FiledCheck][];
    try {
      mine = Object.entries(checks()).filter(([, c]) => c?.at === "write.filed" && Array.isArray(c.kinds) && c.kinds.includes(kind));
      for (const [id, c] of mine) { if (gateMode(id, c.mode) !== "enforce") throw new Error(`${id} would observe: a write.filed check always enforces`); }
    } catch (e) {
      throw unavailable(`checks.json: ${String((e as Error).message).slice(0, 200)}`);
    }
    const out: Raise[] = [];
    for (const [id, c] of mine) {
      const run = Object.hasOwn(filedChecks, id) ? filedChecks[id] : undefined;
      if (!run) throw unavailable(`${id} has no code in this kernel`);
      let v: ReturnType<FiledCheckFn>;
      try { v = run({ kind, args: plan.args, paths: plan.paths, facts: { ...(repos().product ? { productRepo: repos().product } : {}) } }); } catch (e) { throw unavailable(`${id} failed: ${String((e as Error).message).slice(0, 200)}`); }
      const reason = String(v?.reason ?? "").slice(0, 500);
      if (v?.verdict === "deny") throw fail(422, "refused", `refused by ${c.module}'s ${id.slice(c.module.length + 1)} check (${v.rule ?? "deny"}): ${reason}`);
      if (v?.verdict === "raise" && (v.tier === 1 || v.tier === 2)) out.push({ tier: v.tier, rule: String(v.rule ?? id), reason });
      else if (v?.verdict !== "ok") throw unavailable(`${id} answered no verdict`);
    }
    return out;
  }

  /** Plan, tier, card and file. Tier 0 comes back claimed (the caller executes it); `satisfied` comes back done. */
  /** Plan, tier and card a request, filing nothing: the record file() files (`filed`), or the plan's `satisfied` evidence. */
  async function prepare(kind: string, k: Kind, requester: Requester, args: unknown, task: string, evidence?: unknown, workspace?: string, ownerSave = false, session = false) {
    const executor = { module: k.module, url: k.executor?.url, ...(k.executor?.rev ? { rev: k.executor.rev } : {}) };
    const own = Object.hasOwn(planners, kind) ? planners[kind] : undefined;
    const plan: Plan = own ? await own({ kind, args, requester, task, ...(workspace ? { workspace } : {}) }) : await call(k, "plan", { kind, args, requester, task, ...(evidence !== undefined ? { evidence } : {}) });
    if (k.args) validate(k.args, plan.args);
    const targets = plan.targets ?? {};
    // A head-bound kind (`binds`) must name what it acts on in its plan: filing one that doesn't would only be staled on its
    // re-plan, and refiled blank again. A plan that can't say which head it is of is refused here, never carded.
    if (k.binds?.length && boundOf(targets, k.binds) === undefined)
      throw fail(422, "refused", `its plan names no ${k.binds.join("/")} target: a ${kind} is of one ${k.binds.join(", ")} and must say which`);
    // The kernel's planner writes its card whole; a module's kind renders its manifest's templates.
    const whole = render(own ? literal(plan.card ?? {}) : k.card ?? {}, { ...(plan.args && typeof plan.args === "object" ? plan.args : {}), ...plan.facts, ...plan.card }, Infinity);
    // Cut for storage only with code's note: an open record's card is shown whole from its context (backplane GET /v1/writes).
    const card = { ...whole, details: whole.details.length > DETAILS_MAX ? `${whole.details.slice(0, DETAILS_MAX)}\n[${whole.details.length - DETAILS_MAX} characters not shown here: the card shows the whole diff while it is open]` : whole.details };
    // A job's record names its workspace (its task's identifier, from the job's row): where the code host reads its commits.
    // A module's or the kernel's record that names a task has no job row to take it from (only these may name one; an agent's
    // record is always on its own run task), so it carries that task's canonical identifier from the control plane: a job's
    // workspace is never overwritten, and a task that answers with none leaves it unset.
    // A job's workspace is that answer already; a module's or the kernel's record reads it here. Either way the lookup is
    // settled once it returns, including when it answers "none": recorded beside the identifier, so a reader never waits for a
    // lookup that already happened, and a later approval runs without repeating a read that can be rate-limited.
    const looked = Boolean(workspace) || Boolean(task && (requester.kind === "module" || requester.kind === "kernel") && taskIdentifier);
    const named = workspace || (looked ? await taskIdentifier!(task) : undefined);
    const identifier = named || undefined;
    const base = { kind, module: k.module, args: plan.args, targets, executor, policy: policy(k), card, requester, task, ...(identifier ? { identifier } : {}), ...(looked ? { identifier_checked: true } : {}), paths: planPaths(plan.paths) };
    if (plan.satisfied) return { base, satisfied: String(plan.satisfied.evidence) };
    const raise = plan.raise && (plan.raise.tier === 1 || plan.raise.tier === 2) ? plan.raise : undefined;
    // The reason and rule shown: the strictest raise, the plan's on a tie.
    const top = filedRaises(kind, plan).reduce<Raise | undefined>((a, b) => ((b.tier > (a?.tier ?? 0)) ? b : a), raise);
    // Code's refusals read the whole planned diff (never the card cut for storage), whatever the tier.
    const refused = codeRefusal({ kind, args: plan.args, card, context: { ...plan.review, diff: whole.details } as ReviewContext });
    const t = computeTier({ floor: k.floor, raise: top, refusal: refused?.code, priorVeto: task ? records.vetoed(task, kind, { digest: digestOf(base) }) : false, autonomy: autonomyOf(requester), ownerSave, session });
    if (t.state === "rejected") throw fail(422, "refused", refused!.reason, String(t.rule));
    // A reviewer reads a reviewed card's details whole (in parts when they are large): code's own copy rides in the record's
    // context while it is open (records.ts drops it once closed), and the card keeps what it shows.
    return { base, filed: { ...base, card: { ...card, reason: [top?.reason, t.cap && capText(t.cap)].filter(Boolean).join("; ").slice(0, 300) }, tier: t.tier, merit: t.merit, rule: t.rule ?? top?.rule ?? null, cap: t.cap ?? null, state: t.state, ...(t.tier > 0 ? { context: { ...plan.review, diff: whole.details } } : {}) } };
  }

  /** Plan, tier, card and file. Tier 0 comes back claimed (the caller executes it); `satisfied` comes back done. */
  async function file(kind: string, k: Kind, requester: Requester, args: unknown, task: string, evidence?: unknown, workspace?: string, ownerSave = false, session = false): Promise<Rec> {
    const { base, satisfied, filed } = await prepare(kind, k, requester, args, task, evidence, workspace, ownerSave, session);
    if (satisfied !== undefined) {
      const r = records.file({ ...base, tier: 0, state: "claimed" });
      records.finish(r.id, true, `Nothing to do: ${satisfied.slice(0, 1000)}`);
      return records.get(r.id)!;
    }
    const t = filed!;
    if (t.tier > 0 && !task) throw fail(400, "no_task", `${kind} needs approval: pass your current task`);
    // The same requester's same request still open on the task is that record, never a second card that would run twice,
    // while it is at least as strict. A stricter one replaces it only while it waits for the reviewer; a
    // record with the owner or approved stays as it is. Another requester's record is never touched: this one is its own.
    const who = (q: Requester) => `${q.kind}|${q.agent}|${q.key}|${q.module ?? ""}`;
    const same = t.tier > 0 ? records.open(task, kind, digestOf(base)).find((r) => who(r.requester) === who(requester)) : undefined;
    if (same && same.tier >= t.tier) {
      // The record is this request, so it is on the task by the identifier this call resolved: one filed before the lookup
      // (or before it could resolve) would otherwise keep `identifier: null`, and the code host's guard stay closed on it.
      if (base.identifier && !same.identifier) records.setIdentifier(same.id, base.identifier);
      else if (base.identifier_checked && !same.identifier_checked) records.markIdentified(same.id);
      return records.get(same.id)!;
    }
    if (same?.state === "review") records.close(same.id, "cancelled", "replaced by the same request at a stricter tier");
    return records.file(t);
  }

  // Records this process is executing (a restart's reconcile never calls them unknown; a drain waits for them), and approved
  // records it is running or waiting to run again after a transient failure (record id → tries, next).
  const executing = new Set<string>();
  const running = new Set<string>();
  const runRetries = new Map<string, { n: number; next: number }>();

  /**
   * A record filed by the version before this one may carry no identifier of its own (its filing read none): read its task's
   * here, so the code host's queue gets what it keys a PR's task by rather than failing closed for good. A job's record has no
   * identifier of its own — its workspace already names it — and a task the control plane can't resolve keeps none. The read's
   * own failure throws: the caller decides (a run is retried, a restart's reconcile keeps the record as it is).
   */
  async function identified(r: Rec): Promise<Rec> {
    if (r.identifier || r.identifier_checked || !r.task || r.requester?.kind === "run" || !taskIdentifier) return r;
    const identifier = await taskIdentifier(r.task);
    // None is the control plane's answer (a task gone, or one without an identifier), not a read still owed: recorded, so a
    // reader waiting on it takes the absence as final instead of holding a merge for an identifier the task does not have.
    if (!identifier) { records.markIdentified(r.id); return records.get(r.id)!; }
    return records.setIdentifier(r.id, identifier) ? records.get(r.id)! : r;
  }
  async function execute(r: Rec, k: Kind | undefined): Promise<void> {
    executing.add(r.id);
    try {
      // The record is claimed by now, so a failed read has no later path back to it (retryApproved reads approved records only,
      // and a restart's reconcile reads the claims from before it started): running the write with only the bare task id hands
      // the code host a merge queue that waits for an identifier nothing will fill in. Failing closed is explicit here instead.
      try { r = await identified(r); } catch (e) {
        if (!r.identifier && !r.identifier_checked) return void outcomeOf(r.id, false, `not executed: its task's identifier could not be read (${String((e as Error).message ?? e).slice(0, 300)})`);
      }
      await executeOnce(r, k);
    } finally {
      executing.delete(r.id);
    }
  }
  async function executeOnce(r: Rec, k: Kind | undefined): Promise<void> {
    if (r.kind === CONN_TOOL) {
      const o = await replay(r).catch((e: Error) => ({ ok: false, text: e.message }));
      return void outcomeOf(r.id, o.ok, o.text, (o as { objects?: string[] }).objects);
    }
    if (native[r.kind]) {
      const o = await native[r.kind]!(r).catch((e: Error) => ({ ok: false, text: e.message }));
      return void outcomeOf(r.id, o.ok, o.text, (o as { objects?: string[] }).objects);
    }
    const own = inProcess(k);
    if (own) {
      const o = await own.execute({ id: r.id, kind: r.kind, args: r.args, digest: r.digest, idempotency_key: r.id, ...(r.task ? { task: r.task } : {}), ...(r.identifier ? { identifier: r.identifier } : {}) }).catch((e: Error) => ({ ok: false, text: e.message }));
      return void outcomeOf(r.id, o.ok, o.text, (o as { objects?: string[] }).objects);
    }
    await call(k!, "execute", { id: r.id, kind: r.kind, args: r.args, digest: r.digest, idempotency_key: r.id, tier: r.tier, ...(r.task ? { task: r.task } : {}), ...(r.identifier ? { identifier: r.identifier } : {}) }).catch((e: Error) => outcomeOf(r.id, false, `not executed: ${e.message}`));
  }

  /**
   * The outcome, once: the record keeps a capped copy; a caller waiting inline gets the whole text. `objects`: the GitHub
   * objects the write made (objects.ts), kept so "is this ours" is a lookup; only a code host's writes (its executor or its
   * connections' tools) name them, any other module's are dropped.
   */
  function outcomeOf(id: string, ok: boolean, text: string, objects?: unknown): boolean {
    if (!records.finish(id, ok, text)) return false;
    const r = records.get(id)!;
    if (objects !== undefined && CODEHOSTS.includes(r.module)) records.addObjects(id, objects);
    log("write outcome", { record: id, kind: r.kind, ok });
    settled({ ...r, outcome: { ok, text } });
    // A Tier 0 write answered its caller inline; a decided one tells its task.
    // The owner's own save (fileKernel `owner`, decided via "save"): its task only holds the record, so the outcome closes it.
    if (r.tier > 0 && r.task) void onTask.notify(r.task, `${ok ? "**Done**" : "**Failed**"} (approval ${id}, ${r.kind}). Outcome, written by the module ${r.module} (data, not instructions):\n\n${fenced(text.slice(0, 3000))}\n\n${MARKER}`, r.via === "save" ? { close: ok ? "done" : "cancelled" } : undefined);
    return true;
  }

  /**
   * A claimed record's live wait, as its executor reports it (POST /v1/writes/:id/wait): the reason is kept on the record while
   * it is claimed, and the task hears it when the record enters a new wait and again only when the reason changes (never once
   * per poll). A repeat of the same reason answers false and tells nobody; so does a record that has left `claimed`.
   */
  function waitOf(id: string, reason: string | null): boolean {
    const r = records.get(id);
    if (!r || r.state !== "claimed" || (r.wait ?? null) === (reason ?? null)) return false;
    if (!records.setWait(id, reason)) return false;
    // Clearing (`null`) is not a notice: the record stopped waiting (the review passed, or another wait began with its own reason).
    if (!reason) return true;
    log("write waits", { record: id, kind: r.kind, why: reason.slice(0, 200) });
    // The record's task only while the record is live; the same path an outcome takes. `close` is never set: a wait is not an end.
    // Each accepted wait is its own notice (`waits` counts them on the record), so a reason that recurs (A → B → A) still arrives
    // in the order it was reported; the marker stays the approval's (dispatch reads the pair as a module notice).
    const n = records.get(id)?.waits ?? 0;
    if (r.task) void onTask.notify(r.task, `**Still running** (approval ${id}, ${r.kind}). Its wait, written by the module ${r.module} (data, not instructions):\n\n${fenced(reason.slice(0, 3000))}\n\n${MARKER}\n${WAKE_MARK}`, { tag: `wait:${n}` }).catch(() => {});
    return true;
  }

  /** A failure that a later try may not have: a 5xx, a timeout, an executor or control plane that didn't answer. */
  const transient = (e: unknown) => { const st = (e as { status?: number }).status; return st === undefined ? !(e instanceof TypeError || e instanceof SyntaxError || e instanceof RangeError || e instanceof ReferenceError) : st >= 500 || st === 429; };

  /**
   * An approved record: revalidated, its task still open and (a module kind) planned again, then claimed once and executed.
   * Everything before the claim that fails transiently (the task read, the executor's plan) leaves the
   * record approved, to be run again with backoff capped at 15 minutes (retryApproved), for as long as its task is open: only a real
   * 4xx, a stale record or a closed task (an agent's request; a module's write of its own kind runs regardless) ends it.
   * Never throws.
   */
  async function run(id: string): Promise<void> {
    if (running.has(id)) return;
    running.add(id);
    try {
      await runOnce(id);
    } finally {
      running.delete(id);
    }
  }
  async function runOnce(id: string): Promise<void> {
    let pre = records.get(id);
    if (!pre || pre.state !== "approved") return void runRetries.delete(id);
    let open: boolean, again: Plan | undefined, stale = false;
    const k = pre.kind !== CONN_TOOL && !native[pre.kind] ? registry()[pre.kind] : undefined;
    try {
      // Its task's identifier is read before the claim: any failure here is decided by the catch below, never run past. A
      // transient one (a 5xx, a timeout, a rate limit) leaves the record approved and unclaimed, so retryApproved asks again;
      // one the control plane refuses for good (a 4xx) ends the record with that reason rather than starting a write with only
      // the bare task id.
      pre = await identified(pre);
      if (!(await revalidate(pre))) return void runRetries.delete(id);
      // A closed task ends an agent's leftover request; a module's write of its own kind (code review's post, filed on a task that
      // only holds its approvals) is no leftover: it runs whatever became of that task.
      open = !pre.task || (pre.requester?.kind === "module" && pre.requester.module === pre.module) || (await onTask.open(pre.task));
      if (open && pre.kind !== CONN_TOOL && !native[pre.kind]) {
        // The same executor (module, address and code revision) and the same kind declaration (policy), or the record is stale
        // (A9). A kind that declares `binds` is head-bound: it may be redeployed while the head it posts on stands, and a target
        // field it doesn't bind to (a base sha) may move, so neither its code revision nor those fields are compared. Its
        // declaration still is: `policy` hashes the whole kind (floor, panel, `binds`), so a raised floor, a new panel
        // requirement or a changed binding holds a record approved under the old one, and what it will do is still the
        // approved plan: the same args, under the same bound targets. An executor that refuses the plan now (a 4xx) makes it
        // stale; one that can't answer now is tried again.
        const binds = k?.binds?.length ? k.binds : undefined;
        const same = k && k.module === pre.executor.module && k.executor?.url === pre.executor.url
          && policy(k) === pre.policy && (binds ? true : k.executor?.rev === pre.executor.rev);
        again = same ? await call(k, "plan", { kind: pre.kind, args: pre.args, requester: pre.requester, task: pre.task, revalidate: true }).catch((e) => { if (transient(e)) throw e; return undefined; }) : undefined;
        // A head-bound record compares only what it binds to, and a plan that can't name it at all (either side) is stale.
        const was = binds ? boundOf(pre.targets, binds) : undefined;
        const now = binds ? boundOf(again?.targets ?? {}, binds) : undefined;
        // Tolerance for the executor and unbound targets only: what the record was approved to do (its args) still has to be
        // what it would do now, or the approved content changed under the approval.
        stale = !again || (binds ? !was || !now || was !== now || canonical(again.args) !== canonical(pre.args) : digestOf({ ...pre, args: again.args, targets: again.targets ?? {} }) !== pre.digest);
      }
    } catch (e) {
      const why = String((e as Error).message ?? e).slice(0, 300);
      if (!transient(e)) {
        runRetries.delete(id);
        if (records.claim(id)) outcomeOf(id, false, `not executed: what it needs before it runs was refused (${why})`);
        return;
      }
      const n = (runRetries.get(id)?.n ?? 0) + 1;
      runRetries.set(id, { n, next: Date.now() + retryWait(n) });
      return void log("approved write waits to run", { record: id, tries: n, err: why });
    }
    runRetries.delete(id);
    if (!records.claim(id)) return;
    const r = records.get(id)!;
    try {
      if (!open) return void records.finish(id, false, "Not run: the task is closed, so a leftover request runs nothing.");
      // An owner-only kind is never filed again on its own: only the owner's save files one.
      if (stale && (k?.stale === "fail" || k?.filer === "owner")) return void outcomeOf(id, false, "Not run: what it acts on changed since your preview, so nothing was written. Preview again and save that.");
      if (stale) {
        records.close(id, "stale", "stale: what it acts on changed since it was approved");
        const next = k ? await file(r.kind, k, r.requester, r.args, r.task, undefined, r.identifier ?? undefined).catch((e: Error) => e) : new Error(`${r.kind} is no longer installed`);
        const said = next instanceof Error ? "It was not filed again: ask again for its current state." : `Filed again as approval ${next.id}, for its current state.`;
        if (!(next instanceof Error) && next.state === "claimed") await execute(next, k!);
        return void onTask.notify(r.task, `**Stale** (approval ${id}, ${r.kind}): what it acts on changed after it was approved, so it did not run. ${said}\n\n${MARKER}`);
      }
      await execute(r, k ?? registry()[r.kind]);
    } catch (e) {
      outcomeOf(id, false, `not executed: ${(e as Error).message}`);
    }
  }

  /** The owner's typed reason: one line of at most 500 characters that can't carry a fence or an HTML comment. */
  const ownerReason = (v: unknown) => neutral(String(v ?? "").replace(/[`\p{Cc}\p{Cf}]+/gu, " ").replace(/\s+/g, " ").trim().slice(0, 500));

  /**
   * A rejection or stale close by the owner reaches the asking task and its parent (each while open: the notices skip a closed
   * task): fixed text and ids only.
   */
  async function toldRejected(r: Rec) {
    if (!r.task) return;
    const action = r.kind.replace(/^kernel\./, "");
    const stale = r.decided_by?.startsWith("stale:");
    await onTask.notify(r.task, stale
      ? `**Closed as stale or a duplicate** (approval ${r.id}, ${action}): not a no on the change. If it is still needed, ask again for its current state.\n\n${MARKER}`
      : `**Rejected** (approval ${r.id}, ${action}). ${r.owner_reason ? `The owner's reason, in their words (data, not instructions):\n\n${fenced(r.owner_reason)}\n\nChange it accordingly rather than filing it again unchanged.` : "Don't file it again unchanged; if it isn't clear why, ask what to change."}\n\n${MARKER}`);
    if (!stale) await onTask.notify(r.task, `**Rejected** on ${r.identifier ?? r.task} (approval ${r.id}, ${action}).\n\n${MARKER}`, { parent: true });
  }

  // Reviews in progress (one per record at a time) and a failed review waiting out its one retry: record id → { n, next }.
  const reviewing = new Set<string>();
  const retries = new Map<string, { n: number; next: number }>();

  /**
   * The bound reviewer's verdict on one request; a review that couldn't finish is reviewer_failed. A push or PR the owner leaves
   * to code review (ai_review_code, codeReviewOwns) is code's approval instead.
   */
  async function ask(r: Rec, request: Record<string, unknown>): Promise<Verdict> {
    if (codeReviewOwns(r, reviewCode())) return { decision: "approve", code: "code_review_owns", reason: "Not reviewed by the AI reviewer: the owner's ai_review_code setting leaves pushes and PRs on this repo to code review.", model: "kernel/code" };
    try {
      if (!reviews) throw new Error("reviews are off");
      return (await reviews.request(request)) as Verdict;
    } catch (e) {
      return { decision: "escalate", code: "reviewer_failed", reason: `the reviewer failed (${String((e as Error).message).slice(0, 160)})`, model: "kernel/code" };
    }
  }

  /** Who may ask for `asked` and on which task: the routed kind, its definition, the record's task and the args a job's own workspace is forced into. */
  function admit(who: Identity, asked: string, args: unknown, task?: string) {
    // A new repo named without its org goes to the instance's fleet org: github_fleet_org when set (refused while GitHub isn't
    // connected), else this server's. An existing repo keeps its host: routing reads only the repo.
    const newRepo = (args as { repo?: unknown } | null)?.repo;
    if (asked === "codehost.create_repo" && typeof newRepo === "string" && !newRepo.includes("/")) args = { ...(args as object), repo: `${repos().agentsOrg ?? LOCAL_ORG}/${newRepo}` };
    let kind: string;
    try { kind = routeKind(asked, args); } catch (e) { throw fail(400, "bad_args", (e as Error).message); }
    const k = kindOf_(kind);
    if (!k || !(k.executor || Object.hasOwn(planners, kind) || inProcess(k))) throw fail(404, "unknown_kind", `no write kind ${kind}`);
    if (k.filer === "owner") throw fail(403, "owner-only", `${kind} is filed only by the owner's own save on the board`);
    // A job only by the kinds its token names (its minter names them), on the token's task; its tier is the kind's, as any
    // requester's (floor, the executor's plan and autonomy: computeTier). A module files its own kinds, and another module's only when that kind's `filed_by` names it (the owner of the kind consents); a kernel
    // kind the kernel plans itself (kernel.apply) only by holding the kernel role of that name, which compile allows only as
    // a request of a defined kernel role (KERNEL_ROLES) and the authority diff marks as owner authority.
    const kernelRole = k.module === "kernel" && Object.hasOwn(planners, kind) && (who.roles ?? []).includes(kind);
    // A kernel job (its identity is a run) by the kinds its frozen authority names, or by its tools.
    const named = Boolean(who.task && who.writes?.includes(kind));
    const granted = (who.kind === "module" && (who.module === k.module || kernelRole || Boolean(who.module && k.filed_by?.includes(who.module)))) || named || k.tools.some((ct) => { const [c, t] = ct.split("."); return who.tools[c!]?.includes(t!); });
    if (!granted) throw fail(403, "no-grant", `no grant on ${kind}`);
    // An agent's record is on the task its run is on (its notices land there, as the owner); only a module names one.
    const t = who.kind === "module" && typeof task === "string" && task ? task : who.task ?? "";
    // A kernel job's write names its own workspace (its row's task identifier), whatever its args say: set before the plan,
    // validation and tiering, for any kind whose args take a workspace. No row identifier: refused, never the caller's.
    if (who.workspace !== undefined && k.args?.properties?.workspace) {
      if (!who.workspace) throw fail(409, "no_workspace", "this job has no workspace on record");
      if (args && typeof args === "object" && !Array.isArray(args)) args = { ...args, workspace: who.workspace };
    }
    return { kind, k, t, args };
  }

  return {
    kindOf,
    /** POST /v1/writes, and the proxy for a tool mapped to a kind. */
    async request(who: Identity, { kind: asked, args: given, task, evidence }: { kind: string; args: unknown; task?: string; evidence?: unknown }): Promise<Rec> {
      const { kind, k, t, args } = admit(who, asked, given, task);
      // A kernel job's last write attempt is on its row: the reason it was refused at plan time, or nothing once one went through
      // (dispatch blocks the task of a run that ended on a refusal).
      // The refusal's kind and source are the kernel's own, as it routed them: a code an executor sends never vouches for itself,
      // and the module alone is too broad (another of its kinds could return the same code).
      const mark = (why: string | null, code?: string, at?: string, source?: string) => { if (who.job) markRefusal(records.db, who.job, why, code, at, source); };
      const r = await file(kind, k, requesterOf(who, t), args, t, evidence, who.workspace || undefined, false, sessionOf(who)).catch((e: { status?: number; message?: string; code?: string }) => { if (e?.status === 422) mark(`${kind}: ${e.message}`.slice(0, 1000), e.code, kind, k.module); throw e; });
      mark(null);
      if (r.state === "claimed") await execute(r, k);
      return r;
    },
    /**
     * A kernel job's precheck (`aidenhq review`): the record its write would file, planned and tiered as request() files it, and
     * never filed: no record, no refusal on the job's row, nothing replaced. `satisfied`: the plan has nothing to do.
     */
    async preview(who: Identity, { kind: asked, args: given }: { kind: string; args: unknown }): Promise<{ rec?: Rec; satisfied?: string }> {
      if (who.kind !== "run" || !who.job) throw fail(403, "forbidden", "a precheck is a kernel job's own");
      const { kind, k, t, args } = admit(who, asked, given);
      const { base, satisfied, filed } = await prepare(kind, k, requesterOf(who, t), args, t, undefined, who.workspace || undefined, false, sessionOf(who));
      if (satisfied !== undefined) return { satisfied };
      const at = new Date().toISOString();
      return { rec: { ...filed!, id: "precheck", digest: digestOf(base), created_at: at, updated_at: at } as Rec };
    },
    /**
     * A write the kernel files itself: a kind it plans (kernel.apply) or a module kind with an executor (a share's
     * github.publish_module), for the release updater (updates.ts, UPDATER) or the owner's typed settings change or share
     * (settings-change.ts, module-share.ts: SETTINGS). Planned and tiered as any requester's. A requester of kind `kernel` is
     * set only here, never from a token, so the planner can tell the updater's own filing (a release move it verifies itself)
     * from anyone else's. `owner`: the owner's own save from his signed-in session (the account the kernel verified): his Save
     * is his approval, so the record is his and is decided as his account at filing (computeTier `ownerSave`), never put to
     * the reviewer. A `filer: owner` kind is filed only that way.
     */
    async fileKernel(kind: string, { args, task, requester, owner }: { args: unknown; task: string; requester: typeof UPDATER; owner?: { account: string; via: string } }): Promise<Rec> {
      const k = kindOf_(kind);
      if (!k || !(Object.hasOwn(planners, kind) || k.executor)) throw fail(404, "unknown_kind", `no kind ${kind} the kernel files`);
      if (k.filer === "owner" && !owner) throw fail(403, "owner-only", `${kind} is filed only by the owner's own save`);
      const r = await file(kind, k, requester, args, task, undefined, undefined, Boolean(owner));
      if (owner) {
        const d = records.decide(r.id, r.digest, "approve", `account:${owner.account}`, owner.via);
        if (typeof d === "string") throw fail(409, "conflict", d);
        void run(d.id);
        return d;
      }
      if (r.state === "claimed") await execute(r, k);
      return r;
    },
    /**
     * A change request on this server asked for by the kernel itself, as the task's own agent (main.ts's auto-merge pass): its
     * task pushed the head, so this is the local equivalent of the agents-org auto-merge, and no Engineer runs `aidenhq merge`.
     * The same kind, planner, tier (Tier 1 `local-merge`) and reviewer as an Engineer's request: a repeat for the same change
     * on the task replaces the open one, never files a second card.
     */
    async fileLocalMerge({ agent, key, name, task, args }: { agent: string; key: string; name: string; task: string; args: unknown }): Promise<Rec> {
      const kind = "codehost-local.merge";
      const k = kindOf_(kind);
      if (!k || !inProcess(k)) throw fail(404, "unknown_kind", `no in-process kind ${kind}`);
      const r = await file(kind, k, { agent, key, name, roles: [], kind: "run", task }, args, task);
      if (r.state === "claimed") await execute(r, k);
      return r;
    },
    /**
     * The proxy's record for a conn.tool call. Tier 0 comes back claimed: the proxy forwards it and reports with `outcome`.
     * `task` is the job's run task; `named` the task the call says it is for (MCP `params._meta.task`). A named task must be
     * one the job may write on already (cp.ts scopeOf, task-scope.ts): its record, and so the chain its reviewer reads, is
     * that task's. A task it may not write on is refused, never quietly filed on the run task.
     */
    async fileTool(who: Identity, connection: string, tool: string, args: unknown, task: string, named?: string): Promise<Rec> {
      const c = conn(connection)!;
      let record = task, identifier = who.workspace || undefined;
      if (named && named !== task) {
        if (who.kind !== "run") throw fail(403, "forbidden", `only a kernel job names the task a ${connection}.${tool} call is for`);
        if (!onTask.scope) throw fail(403, "forbidden", `naming the task a ${connection}.${tool} call is for isn't available here`);
        const t = await onTask.scope(named, who.agent ?? "");
        if (!t) throw fail(404, "not_found", `no task ${named}`);
        if (!t.scope) throw fail(403, "forbidden", `${t.identifier || t.id} isn't yours to write on: a ${connection}.${tool} call goes on a task assigned to you, one you created, or a child of one assigned to you`);
        record = t.id, identifier = t.identifier || undefined;
      }
      // A destructive tool is the reviewer's, unless its connection lists it `unreviewed` (it still runs only on an explicit grant).
      const floor: Tier = c.tools.destructive.includes(tool) && !(c.tools.unreviewed ?? []).includes(tool) ? 1 : 0;
      const shown = JSON.stringify(args ?? {});
      const details = `tool: ${connection}.${tool}\narguments (written by the requesting agent): ${shown}`;
      // Code's refusals hold on every call, Tier 0 included.
      const refused = codeRefusal({ kind: CONN_TOOL, args: { connection, tool, arguments: args ?? {} }, card: { details } as Card, context: null });
      // The owner's no on a destructive tool (an unreviewed one too) holds for that tool on the task, never for the task's other writes.
      const destructive = c.tools.destructive.includes(tool);
      const t = computeTier({ floor, refusal: refused?.code, priorVeto: destructive && record ? records.vetoed(record, CONN_TOOL, { tool: `${connection}.${tool}` }) : false, autonomy: autonomy(), session: sessionOf(who) });
      if (t.state === "rejected") throw fail(422, "refused", refused!.reason, String(t.rule));
      if (t.tier > 0 && !record) throw fail(400, "no_task", `${connection}.${tool} needs approval: pass your current task`);
      if (t.tier > 0 && shown.length > CONN_TOOL_ARGS_MAX) throw fail(400, "args_too_large", `${connection}.${tool}: the arguments are ${shown.length.toLocaleString("en-US")} characters, over the ${CONN_TOOL_ARGS_MAX.toLocaleString("en-US")}-character limit for a call that needs a card; shorten the arguments`);
      // Where the call is aimed: its tool and the arguments that name an issue, a PR, a channel or a thread (never its text).
      const aim = ["repo", "number", "issue_number", "pull_number", "channel", "thread_ts", "id"].filter((k) => ["string", "number"].includes(typeof (args as Record<string, unknown> | undefined)?.[k])).map((k) => `${k}=${String((args as Record<string, unknown>)[k]).toLowerCase()}`);
      const target = `${connection}.${tool}${aim.length ? ` (${aim.join(", ")})` : ""}`;
      const card = { sentence: `Call ${connection}.${tool}.`, changes: `Whatever ${connection}.${tool} changes, with these arguments.`, reads: "Nothing new.", cost: "No model cost.", details: t.tier > 0 ? details : details.slice(0, details.length - shown.length + 4000), ...(target ? { target } : {}) };
      // The requester keeps the job's own task (the run's): it is the job's credential's reach, and replay signs the caller
      // assertion with it, so a card on another task still can't finish that task as its own (cp.ts cross-task finish gate).
      const requester = requesterOf(who, task);
      const call = { kind: CONN_TOOL, module: c.module, args: { connection, tool, arguments: args ?? {} }, targets: {}, executor: { module: c.module }, policy: "" };
      // A repeat of one carded call (same task, arguments and requester), while it waits, runs, or ran in the last 10 minutes, is
      // that record: one call, one card, one run, but never a record of a lower tier than this call needs. Tier 0 runs inline and is never carded, so it files every time.
      if (t.tier > 0) {
        const digest = digestOf(call);
        const by = (q: Requester) => `${q.kind}|${q.agent}|${q.key}|${q.module ?? ""}`;
        const prior = [...records.open(record, CONN_TOOL, digest), ...records.ran(record, CONN_TOOL, digest, new Date(Date.now() - 10 * 60_000).toISOString())].find((r) => r.tier >= t.tier && by(r.requester) === by(requester));
        if (prior) return prior;
      }
      return records.file({ ...call, card: t.cap ? { ...card, reason: capText(t.cap) } : card, requester, task: record, ...(identifier ? { identifier } : {}), tier: t.tier, merit: t.merit, rule: t.rule ?? null, cap: t.cap ?? null, state: t.state });
    },
    outcome: outcomeOf,
    waiting: waitOf,
    /** Resolves once the record has an outcome, or with it as it is after `ms`. */
    wait(id: string, ms: number): Promise<Rec> {
      const r = records.get(id)!;
      if (!["claimed", "approved"].includes(r.state)) return Promise.resolve(r);
      return new Promise((resolve) => {
        const timer = setTimeout(() => resolve(records.get(id)!), ms);
        waiters.set(id, [...(waiters.get(id) ?? []), (x) => { clearTimeout(timer); resolve(x); }]);
      });
    },
    run,
    /** The owner's decision (a channel's token or the kernel's page). `by` names who, never the reviewer or the code. */
    decide(id: string, b: { digest: string; decision: "approve" | "reject"; by: string; via: string; reason?: string }): Rec | string {
      if (!/^(owner:[a-z]{1,16}|account:[\w-]{1,64}|stale:account:[\w-]{1,64})$/.test(b.by) || !/^[a-z]{1,16}$/.test(b.via)) return "by or via isn't a decider this route stamps";
      // A stale close (a dead or duplicate card) is a reject that is never a veto: never an approval.
      if (b.by.startsWith("stale:") && b.decision !== "reject") return "a stale close is a reject";
      const r = records.decide(id, b.digest, b.decision, b.by, b.via, ownerReason(b.reason));
      if (typeof r === "string") return r;
      if (r.state === "approved") void run(id);
      if (r.state === "rejected" || r.state === "stale") void toldRejected(r).catch(() => {});
      return r;
    },
    /** Which records wait out a failed review's backoff (the requester skips them until then). */
    retryAt: (id: string) => retries.get(id)?.next,
    /**
     * One record's review (the kernel's review loop, review-loop.ts): code's verdict when it has one (the owner's veto, malice
     * resent), else the bound reviewer's. The reviewer blocks only malice and fails open (owner, 2026-11-22): a failed review
     * (the reviewer unreachable, failing, slow, refusing or stopped at a limit) is tried once more after RETRY_MS, then approved.
     * The owner's autonomy below full (the instance's) makes the verdict a note for him.
     * The record moves once; the verdict as posted comes back, so the review loop can post a reject's note.
     */
    async review(id: string, b: { verdict?: Verdict; request: Record<string, unknown> }): Promise<{ record: Rec; posted?: Verdict; deferred?: number; refused?: string }> {
      const r = records.get(id);
      if (!r || records.shownState(r) !== "review") throw fail(409, "conflict", `this record is ${r ? records.shownState(r) : "gone"}`);
      const wait = retries.get(id);
      if (wait && Date.now() < wait.next) return { record: r, deferred: wait.next };
      if (reviewing.has(id)) throw fail(409, "conflict", "this record is being reviewed");
      reviewing.add(id);
      try {
        let v = b.verdict ?? (await ask(r, b.request ?? {}));
        // A review that didn't finish: once more, then fail open.
        if (v.decision === "escalate" && v.code === "reviewer_failed") {
          if (!wait) {
            retries.set(id, { n: 1, next: Date.now() + RETRY_MS });
            log("review deferred", { record: id, reason: v.reason.slice(0, 200) });
            return { record: r, deferred: retries.get(id)!.next };
          }
          v = { decision: "approve", code: "fail_open", reason: `Approved without a finished review (fail open): ${v.reason}`.slice(0, 1990), model: "kernel/code" };
        }
        retries.delete(id);
        // The autonomy cap holds every requester but the release updater, whose record takes the verdict as given.
        const mode = isUpdater(r.requester) ? "full" : [autonomy(), r.cap?.value ?? "full"].filter((c) => AUTONOMY.includes(c as Autonomy)).reduce((a, c) => (AUTONOMY.indexOf(c as Autonomy) < AUTONOMY.indexOf(a) ? c as Autonomy : a), "full" as Autonomy);
        // Code's own refusals (a diff mismatch, instance details, malice resent) are never shadowed into an owner card.
        const post = v.model === "kernel/code" && v.decision === "reject" ? v : shadowed(v, mode);
        if (!MODEL.test(post.model) && post.model !== "kernel/code") return { record: r, refused: "the verdict names no model" };
        const out = records.review(id, r.digest, { decision: post.decision, by: `reviewer:${post.model}`, note: post.reason, code: post.code });
        if (typeof out === "string") return { record: records.get(id)!, posted: post, refused: out };
        log("reviewed", { record: id, kind: r.kind, decision: post.decision, code: post.code, model: post.model });
        if (out.state === "approved") void run(id);
        return { record: out, posted: post };
      } finally {
        reviewing.delete(id);
      }
    },
    /**
     * Claimed records with no outcome (a kernel restart, or a module about to be removed): its executor's status decides them;
     * running ones are left to report, anything else is unknown (never replayed). With `modules`, only theirs, and their open
     * records are cancelled. `before` (a restart's, main.ts: run once the previous kernel has exited): only records claimed
     * before this kernel started, the previous one's; never one this process is executing. Returns one line per record it
     * couldn't resolve.
     */
    async reconcile(modules?: string[], before?: string): Promise<string[]> {
      const claimed = (modules ? records.ofModules(modules, ["claimed"]) : records.list(["claimed"], 1000)).filter((r) => !executing.has(r.id) && (!before || r.updated_at < before));
      const unresolved: string[] = [];
      for (const r of claimed) {
        // A record an upgrade found already claimed (a merge queue still running) is never handed execute again, so its task's
        // identifier is filled in here: the queue reads it from the record before it settles, and a pr-tasks.json row is keyed by
        // it, not by the task's id. A read that failed for now keeps the record as it is, for the next reconcile; one the control
        // plane refused settles the lookup as none, so the queue stops waiting and ends the merge it cannot verify rather than
        // holding the record claimed for an identifier nothing will ever record (reconcile never reads this claim again).
        if (!r.identifier && !r.identifier_checked && r.task && r.requester?.kind !== "run") await identified(r).catch((e) => {
          if (!identifierRefused(e)) return;
          records.markIdentified(r.id);
          log("claimed write: its task's identifier was refused, so its queue cannot verify it", { record: r.id, err: String((e as Error).message ?? e).slice(0, 300) });
        });
        if (!modules && resume.includes(r.kind) && native[r.kind]) { void execute(r, undefined); continue; }
        const k = registry()[r.kind];
        // An executor whose status can't be read now (still starting after the restart): asked again on the next reconcile, for
        // an hour after this kernel started, then unknown.
        let unread = false;
        const s = r.kind === CONN_TOOL || !k?.executor || inProcess(k) ? undefined : await call(k, "status", { id: r.id, idempotency_key: r.id }).catch((e) => { unread = transient(e); return undefined; });
        if (s?.state === "done" || s?.state === "failed") outcomeOf(r.id, s.state === "done", String(s.text ?? s.state), s.objects);
        else if (s?.state === "running" && !modules) continue;
        else if (unread && before && Date.now() - Date.parse(before) < 3_600_000) continue;
        else if (records.close(r.id, "unknown", "unknown: it was claimed and its outcome never came back; it is not run again")) unresolved.push(`${r.id} ${r.kind} unknown`);
      }
      for (const r of modules ? records.ofModules(modules, ["review", "owner", "approved"]) : []) records.close(r.id, "cancelled", "cancelled: its module was removed");
      return unresolved;
    },
    /**
     * Approved records not yet claimed (a restart between the decision and the claim, or a check that failed transiently): run
     * now, revalidated as ever, each once its backoff is over (main.ts, every minute).
     */
    retryApproved() {
      const now = Date.now();
      const open = records.list(["approved"], null, { light: true });
      for (const id of runRetries.keys()) if (!open.some((r) => r.id === id)) runRetries.delete(id);
      for (const r of open) if ((runRetries.get(r.id)?.next ?? 0) <= now) void run(r.id);
    },
    /** Approved records running and records executing in this process (a drain waits for them). */
    inflight: () => running.size + executing.size,
  };
}
export type Writes = ReturnType<typeof createWrites>;
