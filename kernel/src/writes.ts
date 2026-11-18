// K6, the write lifecycle (spec §5.3) for every write kind: the modules' (manifest `writes:`, compiled to
// config/kernel/writes.json), the kernel's own (kinds.ts), and the implicit kind conn.tool (a write or destructive tool
// mapped to no kind). Filing: grant check → plan → args schema → tier (K5) → card → record. A module kind is planned by its
// executor (executor@1, sdk/src/executor.ts); kernel.apply by the kernel's planner. Tier 0 is claimed at filing and
// executed at once; Tier 1 and 2 go to the reviewer: the kernel's review loop gathers what it reads, sends it to the bound
// reviewer module, holds the verdict to the record's review-first, and moves the record (the owner decides next, by
// channel token or the kernel's page). Approved: claimed once → revalidated (a module kind: the same executor and policy,
// and plan again: the same digest, else stale and refiled) → executed. A conn.tool record is executed by the proxy itself;
// kernel.raise_cap and kernel.apply by the kernel.
import http from "node:http";
import { createHash } from "node:crypto";
import { neutral } from "./channels.ts";
import type { Connection, Identity } from "./identity.ts";
import type { Resolver } from "./net.ts";
import { UPDATER, canonical, digestOf, type Card, type Rec, type Records, type Requester } from "./records.ts";
import type { Reviews } from "./reviews.ts";
import { repoKey, type Repos } from "./kinds.ts";
import { writeRaise, type Inventory } from "./paths.ts";
import { REVIEW_TRIES, afterReview, capText, codeVerdict, computeTier, failedVerdict, heldInput, shadowed, type Autonomy, type Raise, type ReviewFirst, type ReviewInput, type Cap, type RoutineCap, type Tier, type Verdict } from "./tier.ts";

export type Schema = { type?: string; properties?: { [k: string]: Schema }; required?: string[]; additionalProperties?: boolean; enum?: unknown[]; pattern?: string; minLength?: number; maxLength?: number; items?: Schema; minItems?: number; maxItems?: number; minimum?: number; maximum?: number; exclusiveMinimum?: number };
/** One kind (config/kernel/writes.json and kinds.ts, keyed `<module>.<kind>`); `tools` are `connection.tool`. */
export type Kind = { module: string; floor: Tier; panel?: boolean; paths?: boolean; tools: string[]; card?: Partial<Card>; args?: Schema; executor?: { url: string; auth_secret: string; rev?: string } };
/**
 * A plan (executor@1's, or the kernel's own planner's). `review_first` with a Tier 2 raise: how the reviewer's verdict on it
 * stands ("final": its reject is final, its approve goes on to the owner; "owner", the default: both go on to the owner).
 */
type Plan = { args: unknown; targets?: { [k: string]: unknown }; facts?: { [k: string]: unknown }; raise?: Raise; review_first?: ReviewFirst; paths?: unknown; card?: { [k: string]: string }; satisfied?: { evidence: string } };
/** The kernel's own planner for one of its kinds (kernel.apply: apply-tier.ts), in place of an executor's plan. */
export type Planner = (b: { kind: string; args: unknown; requester: Requester; task: string; workspace?: string }) => Promise<Plan>;
export const CONN_TOOL = "conn.tool";
const fail = (status: number, type: string, message: string) => Object.assign(new Error(message), { status, type });

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
export function render(t: Partial<Card>, values: { [k: string]: unknown }, detailsMax = 80_000): Card {
  const val = (k: string) => { const v = values[k]; return v == null ? "" : typeof v === "string" ? v : JSON.stringify(v); };
  const one = (s: string | undefined, max: number, keepLines = false) => String(s ?? "").replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, k) => val(k)).replace(/[\p{Cc}\p{Cf}]/gu, (c) => (keepLines && (c === "\n" || c === "\t") ? c : " ")).slice(0, max);
  return { sentence: one(t.sentence, 300), changes: one(t.changes, 8000, true), reads: one(t.reads, 1000), cost: one(t.cost, 300), details: one(t.details, detailsMax, true), ...(t.target !== undefined ? { target: one(t.target, 500) } : {}) };
}
/** A planner's own card text as the template: each field is its value. */
const literal = (c: Partial<Card>) => Object.fromEntries(Object.keys(c).filter((k) => k !== "reason").map((k) => [k, `{{${k}}}`])) as Partial<Card>;

/** Text a module wrote, inside a fence it can't close, for a notice posted on a task. */
export const fenced = (text: string) => { const f = "`".repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map((m) => m[0].length + 1))); return `${f}\n${text}\n${f}`; };
export const MARKER = "<!-- aidenhq-approval -->";
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const UNSURE = "reviewer_unsure";
const MODEL = /^~?[\w.-]+\/[\w.:-]+$/;

export function createWrites({ records, registry, connections, secret, resolver, reviews, autonomy = () => "full", repos = () => ({}), paths = () => undefined, onTask, replay, native = {}, planners = {}, resume = [], log = () => {} }: {
  records: Records; registry: () => { [kind: string]: Kind }; connections: () => { [c: string]: Connection }; secret: (n: string) => string; resolver: Resolver;
  /** The bound reviewer module (reviews.ts): every record's review goes there. */
  reviews?: Reviews;
  autonomy?: () => Autonomy;
  /** The product and instance repositories (which repository a `paths: true` kind's files are in). */
  repos?: () => Repos;
  /** The path inventory (config/kernel/paths.json, paths.ts): a `paths: true` kind's files raise its tier; missing is the owner's. */
  paths?: () => Inventory | undefined;
  /** The task a record is on: still open (and its parent), and a notice on it (fixed text; the module's words only fenced). */
  onTask: { open(task: string): Promise<boolean>; notify(task: string, text: string): Promise<void>; parent?(task: string): Promise<string | undefined>; routineCap?(task: string): Promise<RoutineCap | undefined> };
  /** Executes an approved conn.tool record: the stored call, through the proxy, as its requester. */
  replay: (r: Rec) => Promise<{ ok: boolean; text: string }>;
  /** The kernel's own executors, by kind (kernel.raise_cap). */
  native?: { [kind: string]: (r: Rec) => Promise<{ ok: boolean; text: string }> };
  /** The kernel's planners for its own kinds (kernel.apply): filed through request() like a module kind, planned here. */
  planners?: { [kind: string]: Planner };
  /** Native kinds whose executor carries on from where it was: a claimed record of one is run again after a restart (kernel.apply). */
  resume?: string[];
  log?: (msg: string, f?: { [k: string]: unknown }) => void;
}) {
  const waiters = new Map<string, ((r: Rec) => void)[]>();
  const settled = (r: Rec) => { for (const w of waiters.get(r.id) ?? []) w(r); waiters.delete(r.id); };
  const policy = (k: Kind) => createHash("sha256").update(canonical({ ...k, executor: undefined })).digest("hex").slice(0, 32);
  const kindOf_ = (kind: string) => (Object.hasOwn(registry(), kind) ? registry()[kind] : undefined);

  async function call(k: Kind, op: "plan" | "execute" | "status", body: unknown): Promise<any> {
    if (!k.executor) throw fail(500, "no_executor", `${k.module} declares no executor`);
    const key = secret(k.executor.auth_secret);
    if (!key) throw fail(503, "no_service_key", `${k.module}'s executor key is missing`);
    const to = await resolver.resolve(`${k.executor.url.replace(/\/$/, "")}/${op}`);
    const data = Buffer.from(JSON.stringify(body));
    return new Promise((resolve, reject) => {
      const req = http.request({ host: to.host, port: to.port, path: to.path, method: "POST", timeout: 30_000, headers: { host: new URL(k.executor!.url).host, authorization: `Bearer ${key}`, "content-type": "application/json", "content-length": data.length } }, (res) => {
        let text = "";
        res.setEncoding("utf8").on("data", (c) => { if (text.length < 1_000_000) text += c; }).on("end", () => {
          let j: any;
          try { j = JSON.parse(text); } catch { return reject(fail(502, "bad_executor", `${k.module}'s ${op} answered ${res.statusCode} with no JSON`)); }
          if ((res.statusCode ?? 500) >= 300) return reject(fail(422, "refused", String(j?.error ?? `${k.module}'s ${op} answered ${res.statusCode}`).slice(0, 1000)));
          resolve(j);
        });
      });
      req.on("timeout", () => req.destroy(fail(504, "timeout", `${k.module}'s ${op} didn't answer in 30 s`)));
      req.on("error", (e) => { resolver.forget(k.executor!.url); reject((e as { status?: number }).status ? e : fail(502, "bad_executor", `${k.module}'s executor is unreachable (${e.message})`)); });
      req.end(data);
    });
  }

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

  /** The cap of a routine whose run started the task's chain (tier.ts taskRoutineCap: an unreadable trace is off). */
  /**
   * Which of the inventory's repositories `repo` is: the product, the official modules repo or another; undefined when it
   * can't be told (not owner/name, or the product repo isn't set here: fails closed).
   */
  const repoKindOf = (repo: string) => { const k = repoKey(repo), product = repoKey(repos().product); return !k || !product ? undefined : k === product ? "product" as const : "other" as const; };
  const routineOf = async (task: string) => (task && onTask.routineCap ? onTask.routineCap(task) : undefined);
  /** The cap now that outranks the AI reviewer's yes on a task: the instance's autonomy below full, or a routine's below full. */
  const capOverReviewer = (routine: RoutineCap | undefined): Cap | undefined =>
    routine && routine.cap !== "full" ? { by: "routine", value: routine.cap, ...(routine.routine ? { routine: routine.routine } : {}) } : autonomy() !== "full" ? { by: "autonomy", value: autonomy() } : undefined;
  /**
   * Revalidate at execution: a record the AI reviewer approved runs only while its yes still stands, under the autonomy and
   * the routine cap now (traced again; an unreadable trace is off). Tightened since: held for the owner instead (false).
   */
  async function revalidate(r: Rec): Promise<boolean> {
    // The caps limit agents' writes only (computeTier `requester`): the kernel's own isn't held by them.
    if (!r.decided_by?.startsWith("reviewer:") || r.requester.kind === "kernel") return true;
    const cap = capOverReviewer(await routineOf(r.task));
    if (!cap) return true;
    records.hold(r.id, cap, `since the AI reviewer approved it, ${capText(cap)}, so the owner decides`);
    return false;
  }

  /** Plan, tier, card and file. Tier 0 comes back claimed (the caller executes it); `satisfied` comes back done. */
  async function file(kind: string, k: Kind, requester: Requester, args: unknown, task: string, evidence?: unknown, workspace?: string): Promise<Rec> {
    const executor = { module: k.module, url: k.executor?.url, ...(k.executor?.rev ? { rev: k.executor.rev } : {}) };
    const own = Object.hasOwn(planners, kind) ? planners[kind] : undefined;
    const plan: Plan = own ? await own({ kind, args, requester, task, ...(workspace ? { workspace } : {}) }) : await call(k, "plan", { kind, args, requester, task, ...(evidence !== undefined ? { evidence } : {}) });
    if (k.args) validate(k.args, plan.args);
    const targets = plan.targets ?? {};
    // The kernel's planner writes its card whole; a module's kind renders its manifest's templates.
    const card = render(own ? literal(plan.card ?? {}) : k.card ?? {}, { ...(plan.args && typeof plan.args === "object" ? plan.args : {}), ...plan.facts, ...plan.card });
    // A job's record names its workspace (its task's identifier, from the job's row): where the code host reads its commits.
    const base = { kind, module: k.module, args: plan.args, targets, executor, policy: policy(k), card, requester, task, ...(workspace ? { identifier: workspace } : {}) };
    if (plan.satisfied) {
      const r = records.file({ ...base, tier: 0, panel: false, state: "claimed" });
      records.finish(r.id, true, `Nothing to do: ${String(plan.satisfied.evidence).slice(0, 1000)}`);
      return records.get(r.id)!;
    }
    const raise = plan.raise && (plan.raise.tier === 1 || plan.raise.tier === 2) ? plan.raise : undefined;
    const byPaths = k.paths ? writeRaise(paths(), plan.paths, repoKindOf) : undefined;
    const reviewFirst: ReviewFirst = plan.review_first === "final" ? "final" : "owner";
    const t = computeTier({ floor: k.floor, raise, reviewFirst, ...(byPaths ? { checkRaises: [byPaths] } : {}), priorVeto: task ? records.vetoed(task, kind, { digest: digestOf(base) }) : false, autonomy: autonomy(), routine: await routineOf(task), panel: k.panel === true, requester: requester.kind });
    if (t.tier > 0 && !task) throw fail(400, "no_task", `${kind} needs approval: pass your current task`);
    // The same requester's same request still open on the task is that record, never a second card that would run twice,
    // while it is at least as strict (tier and panel). A stricter one replaces it only while it waits for the reviewer; a
    // record with the owner or approved stays as it is. Another requester's record is never touched: this one is its own.
    const who = (q: Requester) => `${q.kind}|${q.agent}|${q.key}|${q.module ?? ""}`;
    const same = t.tier > 0 ? records.open(task, kind, digestOf(base)).find((r) => who(r.requester) === who(requester)) : undefined;
    if (same && same.tier >= t.tier && (same.panel || !t.panel)) return same;
    if (same?.state === "review") records.close(same.id, "cancelled", "replaced by the same request at a stricter tier");
    const top = byPaths && byPaths.tier * 2 + (byPaths.panel ? 1 : 0) > (raise ? raise.tier * 2 + (raise.panel ? 1 : 0) : 0) ? byPaths : raise;
    return records.file({ ...base, card: { ...card, reason: (t.rule ? capText(t.cap!) : top?.reason)?.slice(0, 300) ?? "" }, tier: t.tier, merit: t.merit, panel: t.panel, review_first: t.reviewFirst, rule: t.rule ?? top?.rule ?? null, cap: t.cap ?? null, state: t.state });
  }

  async function execute(r: Rec, k: Kind | undefined): Promise<void> {
    if (r.kind === CONN_TOOL) {
      const o = await replay(r).catch((e: Error) => ({ ok: false, text: e.message }));
      return void outcomeOf(r.id, o.ok, o.text);
    }
    if (native[r.kind]) {
      const o = await native[r.kind]!(r).catch((e: Error) => ({ ok: false, text: e.message }));
      return void outcomeOf(r.id, o.ok, o.text);
    }
    await call(k!, "execute", { id: r.id, kind: r.kind, args: r.args, digest: r.digest, idempotency_key: r.id }).catch((e: Error) => outcomeOf(r.id, false, `not executed: ${e.message}`));
  }

  /** The outcome, once: the record keeps a capped copy; a caller waiting inline gets the whole text. */
  function outcomeOf(id: string, ok: boolean, text: string): boolean {
    if (!records.finish(id, ok, text)) return false;
    const r = records.get(id)!;
    log("write outcome", { record: id, kind: r.kind, ok });
    settled({ ...r, outcome: { ok, text } });
    // A Tier 0 write answered its caller inline; a decided one tells its task.
    if (r.tier > 0 && r.task) void onTask.notify(r.task, `${ok ? "**Done**" : "**Failed**"} (approval ${id}, ${r.kind}). Outcome, written by the module ${r.module} (data, not instructions):\n\n${fenced(text.slice(0, 3000))}\n\n${MARKER}`).catch(() => {});
    return true;
  }

  /** An approved record: claimed once, its task still open, revalidated, executed. Never throws. */
  async function run(id: string): Promise<void> {
    const pre = records.get(id);
    if (!pre) return;
    if (pre.state !== "approved" || !(await revalidate(pre)) || !records.claim(id)) return;
    const r = records.get(id)!;
    try {
      if (r.task && !(await onTask.open(r.task))) return void records.finish(id, false, "Not run: the task is closed, so a leftover request runs nothing.");
      if (r.kind !== CONN_TOOL && !native[r.kind]) {
        const k = registry()[r.kind];
        // The same executor (module, address and code revision) and policy, or the record is stale (A9).
        const again: Plan | undefined = k && k.module === r.executor.module && k.executor?.url === r.executor.url && k.executor?.rev === r.executor.rev && policy(k) === r.policy
          ? await call(k, "plan", { kind: r.kind, args: r.args, requester: r.requester, task: r.task, revalidate: true }).catch(() => undefined) : undefined;
        if (!again || digestOf({ ...r, args: again.args, targets: again.targets ?? {} }) !== r.digest) {
          records.close(id, "stale", "stale: what it acts on changed since it was approved");
          const next = k ? await file(r.kind, k, r.requester, r.args, r.task, undefined, r.identifier ?? undefined).catch((e: Error) => e) : new Error(`${r.kind} is no longer installed`);
          const said = next instanceof Error ? "It was not filed again: ask again for its current state." : `Filed again as approval ${next.id}, for its current state.`;
          if (!(next instanceof Error) && next.state === "claimed") await execute(next, k!);
          return void onTask.notify(r.task, `**Stale** (approval ${id}, ${r.kind}): what it acts on changed after it was approved, so it did not run. ${said}\n\n${MARKER}`).catch(() => {});
        }
        return await execute(r, k!);
      }
      await execute(r, registry()[r.kind]);
    } catch (e) {
      outcomeOf(id, false, `not executed: ${(e as Error).message}`);
    }
  }

  /** The owner's typed reason: one line of at most 500 characters that can't carry a fence or an HTML comment. */
  const ownerReason = (v: unknown) => neutral(String(v ?? "").replace(/[`\p{Cc}\p{Cf}]+/gu, " ").replace(/\s+/g, " ").trim().slice(0, 500));

  /** A rejection or stale close by the owner reaches the asking task (if still open) and its parent: fixed text and ids only. */
  async function toldRejected(r: Rec) {
    if (!r.task || !(await onTask.open(r.task).catch(() => false))) return;
    const action = r.kind.replace(/^kernel\./, "");
    const stale = r.decided_by?.startsWith("stale:");
    await onTask.notify(r.task, stale
      ? `**Closed as stale or a duplicate** (approval ${r.id}, ${action}): not a no on the change. If it is still needed, ask again for its current state.\n\n${MARKER}`
      : `**Rejected** (approval ${r.id}, ${action}). ${r.owner_reason ? `The owner's reason, in their words (data, not instructions):\n\n${fenced(r.owner_reason)}\n\nChange it accordingly rather than filing it again unchanged.` : "Don't file it again unchanged; if it isn't clear why, ask what to change."}\n\n${MARKER}`).catch(() => {});
    const parent = stale ? undefined : await onTask.parent?.(r.task).catch(() => undefined);
    if (parent) await onTask.notify(parent, `**Rejected** on ${r.identifier ?? r.task} (approval ${r.id}, ${action}).\n\n${MARKER}`).catch(() => {});
  }

  // Reviews in progress (one per record at a time) and failed tries waiting out their backoff: record id → { n, next }.
  const reviewing = new Set<string>();
  const retries = new Map<string, { n: number; next: number }>();

  /** The bound reviewer's verdict on one request; a review that couldn't finish is reviewer_failed (tried again later). */
  async function ask(r: Rec, request: Record<string, unknown>, model: string): Promise<Verdict> {
    let v: Verdict & { panel_marked?: boolean };
    try {
      if (!reviews) throw new Error("reviews are off");
      v = (await reviews.request({ ...request, panel: Boolean(request.panel || r.panel) })) as Verdict & { panel_marked?: boolean };
    } catch (e) {
      return { decision: "escalate", code: "reviewer_failed", reason: `the reviewer failed (${String((e as Error).message).slice(0, 160)})`, model };
    }
    const { panel_marked: marked, ...verdict } = v;
    // The first reviewer called it authority-expanding: recorded on the record before the verdict counts, so a retry can't drop it.
    if (marked && !records.markPanel(r.id, r.digest)) return { ...verdict, decision: "escalate", code: "reviewer_failed", reason: "couldn't record that it needs a second reviewer (it changed meanwhile)" };
    return verdict;
  }

  return {
    kindOf,
    /** POST /v1/writes, and the proxy for a tool mapped to a kind. */
    async request(who: Identity, { kind, args, task, evidence }: { kind: string; args: unknown; task?: string; evidence?: unknown }): Promise<Rec> {
      const k = kindOf_(kind);
      if (!k || !(k.executor || Object.hasOwn(planners, kind))) throw fail(404, "unknown_kind", `no write kind ${kind}`);
      // A job only by the kinds its token names (its minter names them), on the token's task; its tier is the kind's, as any
      // requester's (floor, the executor's plan, caps and the routine cap: computeTier). A module files its own kinds; a kernel
      // kind the kernel plans itself (kernel.apply) only by holding the kernel role of that name, which compile allows only as
      // a request of a defined kernel role (KERNEL_ROLES) and the authority diff marks as owner authority.
      const kernelRole = k.module === "kernel" && Object.hasOwn(planners, kind) && (who.roles ?? []).includes(kind);
      // A kernel job (its identity is a run) by the kinds its frozen authority names, or by its tools.
      const named = Boolean(who.task && who.writes?.includes(kind));
      const granted = (who.kind === "module" && (who.module === k.module || kernelRole)) || named || k.tools.some((ct) => { const [c, t] = ct.split("."); return who.tools[c!]?.includes(t!); });
      if (!granted) throw fail(403, "no-grant", `no grant on ${kind}`);
      // An agent's record is on the task its run is on (its notices land there, as the owner); only a module names one.
      const t = who.kind === "module" && typeof task === "string" && task ? task : who.task ?? "";
      // A kernel job's write names its own workspace (its row's task identifier), whatever its args say: set before the plan,
      // validation and tiering, for any kind whose args take a workspace. No row identifier: refused, never the caller's.
      if (who.workspace !== undefined && k.args?.properties?.workspace) {
        if (!who.workspace) throw fail(409, "no_workspace", "this job has no workspace on record");
        if (args && typeof args === "object" && !Array.isArray(args)) args = { ...args, workspace: who.workspace };
      }
      const r = await file(kind, k, requesterOf(who, t), args, t, evidence, who.workspace || undefined);
      if (r.state === "claimed") await execute(r, k);
      return r;
    },
    /**
     * A kind the kernel plans (kernel.apply), filed by the kernel's release updater (updates.ts): planned and tiered as any
     * requester's. Its requester kind `kernel` is set only here, never from a token, so the planner can tell the updater's own
     * filing (a release move it verifies itself) from anyone else's.
     */
    async fileUpdater(kind: string, { args, task }: { args: unknown; task: string }): Promise<Rec> {
      const k = kindOf_(kind);
      if (!k || !Object.hasOwn(planners, kind)) throw fail(404, "unknown_kind", `no kernel-planned kind ${kind}`);
      const r = await file(kind, k, UPDATER, args, task);
      if (r.state === "claimed") await execute(r, k);
      return r;
    },
    /** kernel.raise_cap, filed by the kernel itself (the model gateway): the owner's tap alone, with no reviewer call (the cap it raises would refuse one). */
    fileNative(kind: string, b: { task: string; identifier?: string; args: unknown; card: Card; reason: string; rule: string }): Rec {
      const k = kindOf_(kind)!;
      if (k.args) validate(k.args, b.args);
      const base = { kind, module: k.module, args: b.args, targets: {}, executor: { module: k.module }, policy: policy(k), card: { ...b.card, reason: b.reason }, requester: { agent: "", key: "", name: "the kernel", roles: [], kind: "kernel" }, task: b.task };
      const open = records.open(b.task, kind, digestOf(base))[0];
      if (open) return open;
      const t = computeTier({ floor: k.floor, reviewFirst: null });
      return records.file({ ...base, tier: t.tier, merit: t.merit, panel: false, review_first: t.reviewFirst, rule: b.rule, identifier: b.identifier ?? null, target: b.card.target ?? null, state: t.state });
    },
    /** The proxy's record for a conn.tool call. Tier 0 comes back claimed: the proxy forwards it and reports with `outcome`. */
    async fileTool(who: Identity, connection: string, tool: string, args: unknown, task: string): Promise<Rec> {
      const c = conn(connection)!;
      const floor: Tier = c.tools.destructive.includes(tool) ? 1 : 0;
      // The owner's no on a destructive tool holds for that tool on the task, never for the task's other writes.
      const t = computeTier({ floor, priorVeto: floor > 0 && task ? records.vetoed(task, CONN_TOOL, { tool: `${connection}.${tool}` }) : false, autonomy: autonomy(), routine: await routineOf(task) });
      if (t.tier > 0 && !task) throw fail(400, "no_task", `${connection}.${tool} needs approval: pass your current task`);
      const shown = JSON.stringify(args ?? {}).slice(0, 4000);
      const card = { sentence: `Call ${connection}.${tool}.`, changes: `Whatever ${connection}.${tool} changes, with these arguments.`, reads: "Nothing new.", cost: "No model cost.", details: `tool: ${connection}.${tool}\narguments (written by the requesting agent): ${shown}` };
      const requester = requesterOf(who, task);
      const call = { kind: CONN_TOOL, module: c.module, args: { connection, tool, arguments: args ?? {} }, targets: {}, executor: { module: c.module }, policy: "" };
      // A repeat of one carded call (same task, arguments and requester), while it waits, runs, or ran in the last 10 minutes, is
      // that record: one call, one card, one run, but never a record of a lower tier than this call needs. Tier 0 runs inline and is never carded, so it files every time.
      if (t.tier > 0) {
        const digest = digestOf(call);
        const by = (q: Requester) => `${q.kind}|${q.agent}|${q.key}|${q.module ?? ""}`;
        const prior = [...records.open(task, CONN_TOOL, digest), ...records.ran(task, CONN_TOOL, digest, new Date(Date.now() - 10 * 60_000).toISOString())].find((r) => r.tier >= t.tier && by(r.requester) === by(requester));
        if (prior) return prior;
      }
      return records.file({ ...call, card: t.rule ? { ...card, reason: capText(t.cap!) } : card, requester, task, tier: t.tier, merit: t.merit, panel: false, review_first: t.reviewFirst, rule: t.rule ?? null, cap: t.cap ?? null, state: t.state });
    },
    outcome: outcomeOf,
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
      if (!/^(owner:[a-z]{1,16}|account:[\w-]{1,64}|watcher|stale:watcher)$/.test(b.by) || !/^[a-z]{1,16}$/.test(b.via)) return "by or via isn't a decider this route stamps";
      const r = records.decide(id, b.digest, b.decision, b.by, b.via, ownerReason(b.reason));
      if (typeof r === "string") return r;
      if (r.state === "approved") void run(id);
      if (r.state === "rejected" || r.state === "stale") void toldRejected(r).catch(() => {});
      return r;
    },
    /** Which records wait out a failed review's backoff (the requester skips them until then). */
    retryAt: (id: string) => retries.get(id)?.next,
    /**
     * One record's review (the kernel's review loop, review-loop.ts): the requester's tier input now and what the reviewer
     * reads. Code decides first (the input couldn't be computed, code refuses it, it is the owner's now); else the bound
     * reviewer is asked, and its verdict is held to the record's review-first (tier.ts afterReview), a failed review waits
     * out its backoff (REVIEW_TRIES, then back or to the owner), and autonomy tier0 makes any verdict a note for the owner.
     * The record moves once; the verdict as posted comes back, so the requester can follow it up (its notes, the breaker).
     */
    async review(id: string, b: { input: ReviewInput & { model?: string }; request: Record<string, unknown> }): Promise<{ record: Rec; posted?: Verdict; deferred?: number; refused?: string }> {
      const r = records.get(id);
      if (!r || records.shownState(r) !== "review") throw fail(409, "conflict", `this record is ${r ? records.shownState(r) : "gone"}`);
      const wait = retries.get(id);
      if (wait && Date.now() < wait.next) return { record: r, deferred: wait.next };
      if (reviewing.has(id)) throw fail(409, "conflict", "this record is being reviewed");
      reviewing.add(id);
      try {
        const model = typeof b.input?.model === "string" && MODEL.test(b.input.model) ? b.input.model : "kernel/code";
        // The cap is the record's, as it was tiered at filing: the label of a capped approve never depends on a second trace.
        const input = heldInput({ ...(b.input ?? { tier: 1 }), cap: r.cap ?? null }, r.review_first);
        let v = codeVerdict(input, model) ?? afterReview(input, await ask(r, b.request ?? {}, model));
        if (v.code === "reviewer_failed") {
          const n = (wait?.n ?? 0) + 1;
          if (n < REVIEW_TRIES) {
            retries.set(id, { n, next: Date.now() + 60_000 * 2 ** (n - 1) });
            log("review deferred", { record: id, tries: n, reason: v.reason.slice(0, 200) });
            return { record: r, deferred: retries.get(id)!.next };
          }
          v = failedVerdict(input, v, n);
        }
        retries.delete(id);
        // The autonomy cap limits agents' writes (computeTier `requester`): the kernel's own record takes the reviewer's verdict as given.
        const post = shadowed(v, r.requester.kind === "kernel" ? "full" : autonomy());
        if (!MODEL.test(post.model) && post.model !== "kernel/code") return { record: r, refused: "the verdict names no model" };
        if (post.second !== undefined && (!MODEL.test(post.second) || post.second === post.model)) return { record: r, refused: "the second reviewer must be another model" };
        const chain = post.decision === "reject" && post.code === UNSURE && typeof b.request?.chain === "string" && b.request.chain ? hash(b.request.chain).slice(0, 32) : undefined;
        const by = `reviewer:${post.model}${post.decision === "approve" && post.second ? `+${post.second}` : ""}`;
        const out = records.review(id, r.digest, { decision: post.decision, by, note: post.reason, code: post.code, chain });
        if (typeof out === "string") return { record: records.get(id)!, posted: post, refused: out };
        log("reviewed", { record: id, kind: r.kind, decision: post.decision, code: post.code, model: post.model, second: post.second });
        if (out.state === "approved") void run(id);
        return { record: out, posted: post };
      } finally {
        reviewing.delete(id);
      }
    },
    /**
     * Claimed records with no outcome (a kernel restart, or a module about to be removed): its executor's status decides them;
     * running ones are left to report, anything else is unknown (never replayed). With `modules`, only theirs, and their open
     * records are cancelled. Returns one line per
     * record it couldn't resolve.
     */
    async reconcile(modules?: string[]): Promise<string[]> {
      const claimed = (modules ? records.ofModules(modules, ["claimed"]) : records.list(["claimed"], 1000));
      const unresolved: string[] = [];
      for (const r of claimed) {
        if (!modules && resume.includes(r.kind) && native[r.kind]) { void execute(r, undefined); continue; }
        const k = registry()[r.kind];
        const s = r.kind === CONN_TOOL || !k?.executor ? undefined : await call(k, "status", { id: r.id, idempotency_key: r.id }).catch(() => undefined);
        if (s?.state === "done" || s?.state === "failed") outcomeOf(r.id, s.state === "done", String(s.text ?? s.state));
        else if (s?.state === "running" && !modules) continue;
        else if (records.close(r.id, "unknown", "unknown: it was claimed and its outcome never came back; it is not run again")) unresolved.push(`${r.id} ${r.kind} unknown`);
      }
      for (const r of modules ? records.ofModules(modules, ["review", "owner", "approved"]) : []) records.close(r.id, "cancelled", "cancelled: its module was removed");
      // Approved but never claimed (a restart between the decision and the claim): run now, revalidated as ever.
      if (!modules) for (const r of records.list(["approved"], 1000)) void run(r.id);
      return unresolved;
    },
  };
}
export type Writes = ReturnType<typeof createWrites>;
