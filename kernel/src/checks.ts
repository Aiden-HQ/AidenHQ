// P5 checks at task.finish (spec §3.5): the finish gate every move to `done` passes, an agent's own (a module acting for it) through
// /v1/cp/agent (cp.ts) and the runner's own closes through /v1/finish. A module declares its checks (`checks:`, compiled
// into config/kernel/checks.json); all that match run in parallel and none sees another's verdict. Any deny refuses the
// close and moves nothing; any reopen reopens; any hold or pending holds the task in review with the check's label and a
// scheduled check; otherwise it passes. A check never marks a task done. Fail closed: a check that errors, answers non-2xx
// or malformed, or takes over 10 s refuses the close, and so do a checks file that is missing or won't load, and a graded
// agent's task (the grants table's `graded`) that no check covers: the gate never fails open. The check's module later
// releases its label, or resolves a hold it placed (POST /v1/checks/:task).
import http from "node:http";
import { readFileSync, statSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import type { Api } from "./channels.ts";
import type { Resolver } from "./net.ts";
import { fail } from "./proxy.ts";

export type Check = { module: string; at: string; url: string; auth_secret: string; agents?: string[]; label?: string };
type Verdict = { verdict: "ok" | "hold" | "pending" | "reopen" | "deny"; reason?: string; until?: string; state?: string; status?: number; unlabel?: boolean };
export type Finish = { pass: true } | { pass: false; held: true; state: string; reason: string } | { pass: false; reopened: true; reason: string };
type Issue = { id: string; identifier?: string; companyId?: string; status?: string; assigneeAgentId?: string | null; assigneeUserId?: string | null; createdByAgentId?: string | null; parentId?: string | null; labelIds?: string[]; labels?: { id: string }[]; executionPolicy?: Record<string, unknown> | null };
const VERDICTS = ["ok", "hold", "pending", "reopen", "deny"];

/** config/kernel/checks.json, reread when it changes. Missing, unreadable or not a map throws: a load error, never "no checks". */
export function checksFile(file: string): () => Record<string, Check> {
  let cache: { mtimeMs: number; size: number; v: Record<string, Check> } | undefined;
  return () => {
    const st = statSync(file);
    if (!cache || cache.mtimeMs !== st.mtimeMs || cache.size !== st.size) {
      const v = JSON.parse(readFileSync(file, "utf8"));
      if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("not a map of checks");
      cache = { mtimeMs: st.mtimeMs, size: st.size, v };
    }
    return cache.v;
  };
}

export function createChecks({ db, registry, owner, secret, resolver, agentKey = () => undefined, graded = () => false, log = () => {} }: {
  db: DatabaseSync; registry: () => Record<string, Check>; owner: Api; secret: (n: string) => string; resolver: Resolver;
  /** An agent id's key (the grants table), for a check scoped to `agents`. */
  agentKey?: (id: string) => string | undefined;
  /** Whether an agent's work is graded (the grants table): its task closes only through a check. */
  graded?: (id: string) => boolean; log?: (msg: string, f?: Record<string, unknown>) => void;
}) {
  db.exec("CREATE TABLE IF NOT EXISTS check_holds (task TEXT NOT NULL, check_id TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (task, check_id))");
  const finishing = () => {
    try {
      return Object.entries(registry()).filter(([, c]) => c.at === "task.finish" && c.url);
    } catch (e) {
      log("finish checks didn't load", { err: String((e as Error).message) });
      throw fail(503, "check_failed", `the finish gate is unavailable: the finish checks didn't load (${(e as Error).message}): the task stays as it is`);
    }
  };

  async function issue(ref: string): Promise<Issue> {
    const r = await owner("GET", `/api/issues/${encodeURIComponent(ref)}`);
    if (r.status === 404) throw fail(404, "not_found", `no task ${ref}`);
    if (r.status !== 200) throw fail(502, "upstream", `the control plane answered ${r.status}`);
    return r.json as Issue;
  }
  const labelIds = (i: Issue) => i.labelIds ?? (i.labels ?? []).map((l) => l.id);
  async function label(i: Issue, name: string) {
    const r = await owner("GET", `/api/companies/${encodeURIComponent(i.companyId ?? "")}/labels`);
    const l = (Array.isArray(r.json) ? r.json : []).find((x: { name?: string }) => x.name === name) as { id: string } | undefined;
    if (!l) log(`label "${name}" missing in the control plane (run the setup)`);
    return l;
  }
  async function patch(i: Issue, body: Record<string, unknown>) {
    if (!Object.keys(body).length) return;
    const r = await owner("PATCH", `/api/issues/${encodeURIComponent(i.id)}`, body);
    if (r.status >= 300) throw fail(502, "upstream", `the control plane answered ${r.status}`);
  }
  /** Removes a check's label from the task, if it carries it. */
  async function unlabel(i: Issue, c: Check) {
    const l = c.label ? await label(i, c.label) : undefined;
    const ids = labelIds(i);
    if (l && ids.includes(l.id)) await patch(i, { labelIds: ids.filter((x) => x !== l.id) });
  }

  function ask(id: string, c: Check, body: unknown): Promise<Verdict> {
    const key = secret(c.auth_secret);
    if (!key) return Promise.reject(new Error("its key is missing"));
    return resolver.resolve(c.url).then((to) => new Promise<Verdict>((resolve, reject) => {
      const data = Buffer.from(JSON.stringify(body));
      const req = http.request({ host: to.host, port: to.port, path: to.path, method: "POST", timeout: 10_000, headers: { host: new URL(c.url).host, authorization: `Bearer ${key}`, "content-type": "application/json", "content-length": data.length } }, (res) => {
        let text = "";
        res.setEncoding("utf8").on("data", (d) => { if (text.length < 100_000) text += d; }).on("end", () => {
          let v: Verdict;
          try { v = JSON.parse(text); } catch { return reject(new Error(`answered ${res.statusCode} with no JSON`)); }
          if ((res.statusCode ?? 500) >= 300 || !v || !VERDICTS.includes(v.verdict)) return reject(new Error(`answered ${res.statusCode}${v?.verdict ? ` (${v.verdict})` : ""}`));
          resolve(v);
        });
      });
      req.on("timeout", () => req.destroy(new Error("didn't answer in 10 s")));
      req.on("error", (e) => { resolver.forget(c.url); reject(e); });
      req.end(data);
    })).catch((e: Error) => { throw fail(503, "check_failed", `the finish check ${id} failed (${e.message}): the task stays as it is; try again`); });
  }

  /** The finish gate for one task: `agent` and `tool` for an agent's own close, `via` for the runner's. Throws on a deny. */
  async function finish(ref: string, caller: { agent?: string; tool?: string; via: string }): Promise<Finish> {
    const all = finishing();
    const i = await issue(ref);
    const key = i.assigneeAgentId ? agentKey(i.assigneeAgentId) : undefined;
    const mine = all.filter(([, c]) => !c.agents?.length || (key !== undefined && c.agents.includes(key)));
    if (!mine.length) {
      if (i.assigneeAgentId && graded(i.assigneeAgentId)) throw fail(503, "check_failed", `the finish gate is unavailable: ${i.identifier ?? i.id}'s assignee is graded and no finish check covers it: the task stays as it is`);
      return { pass: true };
    }
    const task = { id: i.id, identifier: i.identifier, status: i.status, assigneeAgentId: i.assigneeAgentId ?? null, assigneeUserId: i.assigneeUserId ?? null, createdByAgentId: i.createdByAgentId ?? null, parentId: i.parentId ?? null };
    const verdicts = await Promise.all(mine.map(async ([id, c]) => ({ id, c, v: await ask(id, c, { task, agent: caller.agent ?? null, tool: caller.tool ?? null, via: caller.via }) })));
    const deny = verdicts.find((x) => x.v.verdict === "deny");
    if (deny) throw fail(deny.v.status === 409 ? 409 : 403, "refused", String(deny.v.reason ?? `refused by ${deny.id}`).slice(0, 500));
    const reopen = verdicts.find((x) => x.v.verdict === "reopen");
    if (reopen) {
      const reason = String(reopen.v.reason ?? "").slice(0, 2000);
      for (const x of verdicts) await unlabel(i, x.c);
      await patch(i, { status: "todo", ...(reason ? { comment: `[${reopen.id}] ${reason}` } : {}) });
      log("finish reopened", { task: i.identifier, check: reopen.id });
      return { pass: false, reopened: true, reason };
    }
    const held = verdicts.filter((x) => x.v.verdict === "hold" || x.v.verdict === "pending");
    if (held.length) {
      // In review, with each holding check's label and the first scheduled check (the control plane's review path: without
      // one it wakes the assignee to repair the review instead of leaving it to the check).
      const ids = labelIds(i);
      const add = (await Promise.all(held.map((x) => (x.c.label ? label(i, x.c.label) : undefined)))).filter((l): l is { id: string } => Boolean(l) && !ids.includes(l!.id));
      const timed = held.find((x) => x.v.until);
      const monitor = timed && i.assigneeAgentId && !i.assigneeUserId ? { executionPolicy: { ...(i.executionPolicy ?? {}), monitor: { nextCheckAt: timed.v.until, notes: String(timed.v.reason ?? "").slice(0, 500) } } } : {};
      await patch(i, { ...(i.status !== "in_review" ? { status: "in_review" } : {}), ...(add.length ? { labelIds: [...ids, ...new Set(add.map((l) => l.id))] } : {}), ...monitor });
      for (const x of held) db.prepare("INSERT OR REPLACE INTO check_holds (task, check_id, at) VALUES (?, ?, ?)").run(i.id, x.id, new Date().toISOString());
      log("finish held", { task: i.identifier, via: caller.via, checks: held.map((x) => x.id) });
      return { pass: false, held: true, state: String(held[0]!.v.state ?? held[0]!.v.verdict), reason: String(held[0]!.v.reason ?? "") };
    }
    for (const x of verdicts) if (x.v.unlabel) await unlabel(i, x.c);
    return { pass: true };
  }

  /**
   * A check's module on a task: `release` takes its label off (the hold is over; the module's own flow moves the task on);
   * `ok` and `reopen` resolve a hold this check placed, moving the task to done or todo as the owner. Only the check's
   * own module, and ok/reopen only on a task it holds.
   */
  async function resolve(module: string, ref: string, b: { check?: unknown; verdict?: unknown; comment?: unknown }) {
    const mine = finishing().filter(([id, c]) => c.module === module && (b.check === undefined || id === `${module}.${String(b.check)}`));
    if (mine.length !== 1) throw fail(403, "forbidden", `${module} has ${mine.length ? "several finish checks: name one (check)" : "no finish check"}`);
    const [id, c] = mine[0]!;
    if (!["release", "ok", "reopen"].includes(String(b.verdict))) throw fail(400, "bad_request", "verdict is release, ok or reopen");
    const i = await issue(ref);
    const held = db.prepare("SELECT 1 FROM check_holds WHERE task = ? AND check_id = ?").get(i.id, id);
    if (b.verdict !== "release" && !held) throw fail(409, "conflict", `${id} holds no finish on ${i.identifier ?? i.id}`);
    await unlabel(i, c);
    db.prepare("DELETE FROM check_holds WHERE task = ? AND check_id = ?").run(i.id, id);
    const comment = typeof b.comment === "string" && b.comment ? { comment: b.comment.slice(0, 60_000) } : {};
    if (b.verdict !== "release") await patch(await issue(i.id), { status: b.verdict === "ok" ? "done" : "todo", ...comment });
    log("finish check resolved", { task: i.identifier, check: id, verdict: b.verdict });
    return { ok: true };
  }
  return { finish, resolve };
}
export type Checks = ReturnType<typeof createChecks>;
