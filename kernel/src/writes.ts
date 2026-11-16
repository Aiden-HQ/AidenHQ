// K6, the write lifecycle (spec §5.3) for module write kinds (manifest `writes:`, compiled to config/kernel/writes.json) and
// the implicit kind conn.tool (a write or destructive tool mapped to no kind). Filing: grant check → executor plan → args
// schema → tier (K5) → card → record. Tier 0 is claimed at filing and executed at once; Tier 1 and 2 wait for the reviewer
// (and the owner) in kernel.db. Approved: claimed once → revalidated (the same executor and policy, and plan again: the same
// digest, else stale and refiled) → executed. The executor (executor@1, sdk/src/executor.ts) sees nothing before that, and
// reports the outcome later (POST /v1/writes/:id/outcome); a conn.tool record is executed by the proxy itself.
import http from "node:http";
import { createHash } from "node:crypto";
import type { Connection, Identity } from "./identity.ts";
import type { Resolver } from "./net.ts";
import { canonical, digestOf, type Card, type Rec, type Records, type Requester } from "./records.ts";
import { computeTier, type Autonomy, type Raise, type Tier } from "./tier.ts";

type Schema = { type?: string; properties?: { [k: string]: Schema }; required?: string[]; additionalProperties?: boolean; enum?: unknown[]; pattern?: string; minLength?: number; maxLength?: number; items?: Schema; minimum?: number; maximum?: number };
/** One compiled kind (config/kernel/writes.json, keyed `<module>.<kind>`); `tools` are `connection.tool`. */
export type Kind = { module: string; floor: Tier; panel?: boolean; tools: string[]; card?: Partial<Card>; args?: Schema; executor?: { url: string; auth_secret: string } };
type Plan = { args: unknown; targets?: { [k: string]: unknown }; facts?: { [k: string]: unknown }; raise?: Raise; card?: { [k: string]: string }; satisfied?: { evidence: string } };
export const CONN_TOOL = "conn.tool";
const fail = (status: number, type: string, message: string) => Object.assign(new Error(message), { status, type });

/** The kind's strict args schema: a small subset of JSON Schema, enough for flat tool arguments. Throws with the first problem. */
export function validate(s: Schema, v: unknown, at = "args"): void {
  const bad = (why: string) => { throw fail(400, "bad_args", `${at} ${why}`); };
  const type = Array.isArray(v) ? "array" : v === null ? "null" : Number.isInteger(v) ? "integer" : typeof v;
  if (s.type && !(s.type === type || (s.type === "number" && type === "integer"))) bad(`must be ${s.type}`);
  if (s.enum && !s.enum.some((e) => canonical(e) === canonical(v))) bad(`must be one of ${s.enum.map((e) => JSON.stringify(e)).join(", ")}`);
  if (typeof v === "string") {
    if (s.pattern && !new RegExp(s.pattern, "u").test(v)) bad(`doesn't match ${s.pattern}`);
    if (v.length < (s.minLength ?? 0) || v.length > (s.maxLength ?? Infinity)) bad("has the wrong length");
  }
  if (typeof v === "number" && (v < (s.minimum ?? -Infinity) || v > (s.maximum ?? Infinity))) bad("is out of range");
  if (Array.isArray(v) && s.items) v.forEach((x, i) => validate(s.items!, x, `${at}[${i}]`));
  if (type === "object") {
    const o = v as { [k: string]: unknown };
    for (const k of s.required ?? []) if (o[k] === undefined) bad(`needs ${k}`);
    for (const [k, x] of Object.entries(o)) {
      if (s.properties?.[k]) validate(s.properties[k], x, `${at}.${k}`);
      else if (s.additionalProperties === false) bad(`has no field ${k}`);
    }
  }
}

/** Card text from the kind's templates over args, facts and the executor's card values: {{name}} only, printable, capped. */
export function render(t: Partial<Card>, values: { [k: string]: unknown }): Card {
  const val = (k: string) => { const v = values[k]; return v == null ? "" : typeof v === "string" ? v : JSON.stringify(v); };
  const one = (s: string | undefined, max: number, keepLines = false) => String(s ?? "").replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, k) => val(k)).replace(/[\p{Cc}\p{Cf}]/gu, (c) => (keepLines && (c === "\n" || c === "\t") ? c : " ")).slice(0, max);
  return { sentence: one(t.sentence, 300), changes: one(t.changes, 2000), reads: one(t.reads, 1000), cost: one(t.cost, 300), details: one(t.details, 80_000, true) };
}

/** Text a module wrote, inside a fence it can't close, for a notice posted on a task. */
const fenced = (text: string) => { const f = "`".repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map((m) => m[0].length + 1))); return `${f}\n${text}\n${f}`; };
export const MARKER = "<!-- aidenhq-approval -->";

export function createWrites({ records, registry, connections, secret, resolver, autonomy = () => "full", onTask, replay, log = () => {} }: {
  records: Records; registry: () => { [kind: string]: Kind }; connections: () => { [c: string]: Connection }; secret: (n: string) => string; resolver: Resolver;
  autonomy?: () => Autonomy;
  /** The task a record is on: still open, and a notice on it (fixed text; the module's words only fenced). */
  onTask: { open(task: string): Promise<boolean>; notify(task: string, text: string): Promise<void> };
  /** Executes an approved conn.tool record: the stored call, through the proxy, as its requester. */
  replay: (r: Rec) => Promise<{ ok: boolean; text: string }>;
  log?: (msg: string, f?: { [k: string]: unknown }) => void;
}) {
  const waiters = new Map<string, ((r: Rec) => void)[]>();
  const settled = (r: Rec) => { for (const w of waiters.get(r.id) ?? []) w(r); waiters.delete(r.id); };
  const policy = (k: Kind) => createHash("sha256").update(canonical({ ...k, executor: undefined })).digest("hex").slice(0, 32);

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

  const requesterOf = (who: Identity, task: string): Requester => ({ agent: who.agent ?? "", key: who.key ?? "", name: who.name ?? "", roles: who.roles, kind: who.kind, ...(task ? { task } : {}), ...(who.run ? { run: who.run } : {}), ...(who.module ? { module: who.module } : {}) });
  const conn = (connection: string) => (Object.hasOwn(connections(), connection) ? connections()[connection] : undefined);

  /** The kind a connection's tool is routed into: a declared kind, conn.tool for an unmapped write or destructive tool, else none. */
  function kindOf(connection: string, tool: string): string | undefined {
    const ct = `${connection}.${tool}`;
    const hit = Object.entries(registry()).find(([, k]) => k.tools.includes(ct));
    if (hit) return hit[0];
    const c = conn(connection);
    return c && (c.tools.write.includes(tool) || c.tools.destructive.includes(tool)) ? CONN_TOOL : undefined;
  }

  /** Plan, tier, card and file. Tier 0 comes back claimed (the caller executes it); `satisfied` comes back done. */
  async function file(kind: string, k: Kind, requester: Requester, args: unknown, task: string, evidence?: unknown): Promise<Rec> {
    const executor = { module: k.module, url: k.executor?.url };
    const plan: Plan = await call(k, "plan", { kind, args, requester, task, ...(evidence !== undefined ? { evidence } : {}) });
    if (k.args) validate(k.args, plan.args);
    const targets = plan.targets ?? {};
    const card = render(k.card ?? {}, { ...(plan.args && typeof plan.args === "object" ? plan.args : {}), ...plan.facts, ...plan.card });
    const base = { kind, module: k.module, args: plan.args, targets, executor, policy: policy(k), card, requester, task };
    if (plan.satisfied) {
      const r = records.file({ ...base, tier: 0, panel: false, state: "claimed" });
      records.finish(r.id, true, `Nothing to do: ${String(plan.satisfied.evidence).slice(0, 1000)}`);
      return records.get(r.id)!;
    }
    const raise = plan.raise && (plan.raise.tier === 1 || plan.raise.tier === 2) ? plan.raise : undefined;
    const t = computeTier({ floor: k.floor, raise, priorVeto: task ? records.vetoed(task, kind) : false, autonomy: autonomy(), panel: k.panel === true });
    if (t.tier > 0 && !task) throw fail(400, "no_task", `${kind} needs approval: pass your current task`);
    // The same requester's same request still open on the task is that record, never a second card that would run twice,
    // while it is at least as strict (tier and panel). A stricter one replaces it only while it waits for the reviewer; a
    // record with the owner or approved stays as it is. Another requester's record is never touched: this one is its own.
    const who = (q: Requester) => `${q.kind}|${q.agent}|${q.key}|${q.module ?? ""}`;
    const same = t.tier > 0 ? records.open(task, kind, digestOf(base)).find((r) => who(r.requester) === who(requester)) : undefined;
    if (same && same.tier >= t.tier && (same.panel || !t.panel)) return same;
    if (same?.state === "review") records.close(same.id, "cancelled", "replaced by the same request at a stricter tier");
    return records.file({ ...base, card: { ...card, reason: raise?.reason?.slice(0, 300) ?? "" }, tier: t.tier, merit: t.merit, panel: t.panel, state: t.tier === 0 ? "claimed" : "review" });
  }

  async function execute(r: Rec, k: Kind): Promise<void> {
    if (r.kind === CONN_TOOL) {
      const o = await replay(r).catch((e: Error) => ({ ok: false, text: e.message }));
      return void outcomeOf(r.id, o.ok, o.text);
    }
    await call(k, "execute", { id: r.id, kind: r.kind, args: r.args, digest: r.digest, idempotency_key: r.id }).catch((e: Error) => outcomeOf(r.id, false, `not executed: ${e.message}`));
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
    if (!records.claim(id)) return;
    const r = records.get(id)!;
    try {
      if (r.task && !(await onTask.open(r.task))) return void records.finish(id, false, "Not run: the task is closed, so a leftover request runs nothing.");
      if (r.kind !== CONN_TOOL) {
        const k = registry()[r.kind];
        const again: Plan | undefined = k && k.module === r.executor.module && k.executor?.url === r.executor.url && policy(k) === r.policy
          ? await call(k, "plan", { kind: r.kind, args: r.args, requester: r.requester, task: r.task, revalidate: true }).catch(() => undefined) : undefined;
        if (!again || digestOf({ ...r, args: again.args, targets: again.targets ?? {} }) !== r.digest) {
          records.close(id, "stale", "stale: what it acts on changed since it was approved");
          const next = k ? await file(r.kind, k, r.requester, r.args, r.task).catch((e: Error) => e) : new Error(`${r.kind} is no longer installed`);
          const said = next instanceof Error ? "It was not filed again: ask again for its current state." : `Filed again as approval ${next.id}, for its current state.`;
          if (!(next instanceof Error) && next.state === "claimed") await execute(next, k!);
          return void onTask.notify(r.task, `**Stale** (approval ${id}, ${r.kind}): what it acts on changed after it was approved, so it did not run. ${said}\n\n${MARKER}`).catch(() => {});
        }
        return await execute(r, k!);
      }
      await execute(r, registry()[r.kind]!);
    } catch (e) {
      outcomeOf(id, false, `not executed: ${(e as Error).message}`);
    }
  }

  return {
    kindOf,
    /** POST /v1/writes, and the proxy for a tool mapped to a kind. */
    async request(who: Identity, { kind, args, task, evidence }: { kind: string; args: unknown; task?: string; evidence?: unknown }): Promise<Rec> {
      const k = Object.hasOwn(registry(), kind) ? registry()[kind] : undefined;
      if (!k) throw fail(404, "unknown_kind", `no write kind ${kind}`);
      // A job only by the kinds its token names (the runner mints them for its own request), on the token's task.
      const granted = (who.kind === "module" && who.module === k.module) || (who.kind === "job" ? Boolean(who.task && who.writes?.includes(kind)) : k.tools.some((ct) => { const [c, t] = ct.split("."); return who.tools[c!]?.includes(t!); }));
      if (!granted) throw fail(403, "no-grant", `no grant on ${kind}`);
      // An agent's record is on the task its run is on (its notices land there, as the owner); only a module names one.
      const t = who.kind === "module" && typeof task === "string" && task ? task : who.task ?? "";
      const r = await file(kind, k, requesterOf(who, t), args, t, evidence);
      if (r.state === "claimed") await execute(r, k);
      return r;
    },
    /** The proxy's record for a conn.tool call. Tier 0 comes back claimed: the proxy forwards it and reports with `outcome`. */
    fileTool(who: Identity, connection: string, tool: string, args: unknown, task: string): Rec {
      const c = conn(connection)!;
      const floor: Tier = c.tools.destructive.includes(tool) ? 1 : 0;
      // The owner's no on a destructive tool holds for that tool on the task, never for the task's other writes.
      const t = computeTier({ floor, priorVeto: floor > 0 && task ? records.vetoed(task, CONN_TOOL, `${connection}.${tool}`) : false, autonomy: autonomy() });
      if (t.tier > 0 && !task) throw fail(400, "no_task", `${connection}.${tool} needs approval: pass your current task`);
      const shown = JSON.stringify(args ?? {}).slice(0, 4000);
      const card = { sentence: `Call ${connection}.${tool}.`, changes: `Whatever ${connection}.${tool} changes, with these arguments.`, reads: "Nothing new.", cost: "No model cost.", details: `tool: ${connection}.${tool}\narguments (written by the requesting agent): ${shown}` };
      return records.file({ kind: CONN_TOOL, module: c.module, args: { connection, tool, arguments: args ?? {} }, targets: {}, executor: { module: c.module }, policy: "", card, requester: requesterOf(who, task), task, tier: t.tier, merit: t.merit, panel: false, state: t.tier === 0 ? "claimed" : "review" });
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
    /** The owner's decision, forwarded by the board (2d until 2f and 3a). `by` names who, never the reviewer or the code. */
    decide(id: string, b: { digest: string; decision: "approve" | "reject"; by: string; via: string }): Rec | string {
      if (!/^(owner:[a-z]{1,16}|account:[\w-]{1,64}|watcher|stale:watcher)$/.test(b.by) || !/^[a-z]{1,16}$/.test(b.via)) return "by or via isn't a decider this route stamps";
      const r = records.decide(id, b.digest, b.decision, b.by, b.via);
      if (typeof r === "string") return r;
      if (r.state === "approved") void run(id);
      if (r.state === "rejected" && r.task) void onTask.notify(r.task, `**Rejected** (approval ${id}, ${r.kind}). Don't file it again unchanged; if it isn't clear why, ask what to change.\n\n${MARKER}`).catch(() => {});
      return r;
    },
    /** The AI reviewer's verdict (the runner, through the board until 3c): `reviewer:<model>[+<second>]`, from allowed model ids. */
    review(id: string, v: { digest: string; decision: "approve" | "reject" | "escalate"; reason: string; model: string; second?: string; code?: string }): Rec | string {
      const model = /^~?[\w.-]+\/[\w.:-]+$/;
      if (!model.test(v.model) || (v.second !== undefined && (!model.test(v.second) || v.second === v.model))) return "the reviewer models must be two different model ids";
      const r = records.review(id, v.digest, v.decision, `reviewer:${v.model}${v.decision === "approve" && v.second ? `+${v.second}` : ""}`, String(v.reason ?? ""), v.code === "stale_head");
      if (typeof r !== "string" && r.state === "approved") void run(id);
      return r;
    },
    /**
     * Claimed records with no outcome (a kernel restart, or a module about to be removed): its executor's status decides them;
     * running ones are left to report, anything else is unknown (never replayed). With `modules`, only theirs, and their open
     * records are cancelled. Returns one line per record it couldn't resolve.
     */
    async reconcile(modules?: string[]): Promise<string[]> {
      const claimed = modules ? records.ofModules(modules, ["claimed"]) : records.list(["claimed"], 1000);
      const unresolved: string[] = [];
      for (const r of claimed) {
        const k = registry()[r.kind];
        const s = r.kind === CONN_TOOL || !k ? undefined : await call(k, "status", { id: r.id, idempotency_key: r.id }).catch(() => undefined);
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
