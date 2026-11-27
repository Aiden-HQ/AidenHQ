// The finish gate and the modules' rubric checks (spec §3.5). Every move to `done` passes the gate, an agent's own (a module acting
// for it) through /v1/cp/agent (cp.ts) and a job's posted outcome (outcomes.ts). The gate refuses a close only for what would
// be lost by it: an approval card still undecided (claimed on a closed task, its write would be dropped) or the task's own change
// request on this server still open (not shipped). Otherwise the task closes; nothing holds it.
//
// A module declares its checks (`checks:`, compiled into config/kernel/checks.json). The `task.rubric` ones take the rubric of a
// task a module filed with one (modtasks.ts): asked with the check's own key, so the filer is the kernel's word. The
// `write.filed` ones run in process on filings (writes.ts) and `validate` on settings changes (module-validate.ts).
import http from "node:http";
import { readFileSync, statSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import type { Api } from "./channels.ts";
import type { Resolver } from "./net.ts";
import { fail } from "./proxy.ts";

export type Check = { module: string; at: string; url: string; auth_secret: string; mode?: "observe" };
type Issue = { id: string; identifier?: string; companyId?: string; status?: string; labelIds?: string[]; labels?: { id: string; name?: string }[] };

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

export function createChecks({ db, registry, owner, secret, resolver, pending = () => [], localChanges = async () => [], log = () => {} }: {
  db: DatabaseSync; registry: () => Record<string, Check>; owner: Api; secret: (n: string) => string; resolver: Resolver;
  /** The task's records still undecided (records.list over review, owner and approved): none may when it closes. */
  pending?: (task: string) => { id: string; kind: string }[];
  /** A task's own change requests on this server that are still open (codehost-local's host), with their checks: none may when it closes. */
  localChanges?: (task: { id: string; identifier?: string }) => Promise<{ url: string; checks: { ok: boolean; pending: boolean }[] }[]>;
  log?: (msg: string, f?: Record<string, unknown>) => void;
}) {
  async function issue(ref: string): Promise<Issue> {
    const r = await owner("GET", `/api/issues/${encodeURIComponent(ref)}`);
    if (r.status === 404) throw fail(404, "not_found", `no task ${ref}`);
    if (r.status !== 200) throw fail(502, "upstream", `the control plane answered ${r.status}`);
    return r.json as Issue;
  }

  /** The finish gate for one task: returns when it may close, throws the refusal otherwise. */
  async function finish(ref: string): Promise<void> {
    const i = await issue(ref);
    const undecided = pending(i.id);
    if (undecided.length) {
      const named = undecided.slice(0, 10).map((r) => `${r.id} (${r.kind})`).join(", ");
      throw fail(409, "refused", `${undecided.length} approval${undecided.length === 1 ? " is" : "s are"} on ${i.identifier ?? i.id} still undecided: ${named}${undecided.length > 10 ? `, and ${undecided.length - 10} more` : ""}. They run when approved, so the task can't be done until they are decided: decide or reject them, or finish again once they have run.`);
    }
    await noOpenChange(i);
  }

  /**
   * A task's own change request on this server still open: refused, with what is true of it now. An open change on another
   * task holds nothing, and neither does one the task closed (closing writes its `closed` ref, so it is no longer open).
   */
  async function noOpenChange(i: { id: string; identifier?: string }) {
    let changes: Awaited<ReturnType<typeof localChanges>>;
    try {
      changes = await localChanges({ id: i.id, ...(i.identifier ? { identifier: i.identifier } : {}) });
    } catch (e) {
      log("local changes unread", { task: i.identifier ?? i.id, err: String((e as Error).message ?? e).slice(0, 200) });
      throw fail(503, "check_failed", `the finish gate couldn't read ${i.identifier ?? i.id}'s change requests on this server (${String((e as Error).message ?? e).slice(0, 200)}): the task stays as it is`);
    }
    if (!changes.length) return;
    const one = changes[0]!;
    const green = one.checks.length > 0 && one.checks.every((c) => c.ok);
    const settling = green ? "every named check is green, but the merge hasn't landed" : one.checks.some((c) => c.pending) ? "its checks are still running" : "its checks aren't all green";
    throw fail(409, "refused", `${i.identifier ?? i.id}'s change request ${one.url} is still open (${settling}). A task closes after its change merges: ask for the merge (a green change merges on its own once the reviewer approves it), then finish again.`);
  }

  /** One POST to a check: its JSON answer. A deny names its reason; any other failure throws. */
  function ask(c: Check, body: unknown): Promise<{ verdict?: string; reason?: string }> {
    const key = secret(c.auth_secret);
    if (!key) return Promise.reject(new Error("its key is missing"));
    return resolver.resolve(c.url).then((to) => new Promise((resolve, reject) => {
      const data = Buffer.from(JSON.stringify(body));
      const req = http.request({ host: to.host, port: to.port, path: to.path, method: "POST", timeout: 10_000, headers: { host: new URL(c.url).host, authorization: `Bearer ${key}`, "content-type": "application/json", "content-length": data.length } }, (res) => {
        let text = "";
        res.setEncoding("utf8").on("data", (d) => { if (text.length < 100_000) text += d; }).on("end", () => {
          let v: { verdict?: string; reason?: string };
          try { v = JSON.parse(text); } catch { return reject(new Error(`answered ${res.statusCode} with no JSON`)); }
          if (v?.verdict === "deny" && (res.statusCode ?? 500) < 500) return resolve(v);
          if ((res.statusCode ?? 500) >= 300 || v?.verdict !== "ok") return reject(new Error(`answered ${res.statusCode}`));
          resolve(v);
        });
      });
      req.on("timeout", () => req.destroy(new Error("didn't answer in 10 s")));
      req.on("error", (e) => { resolver.forget(c.url); reject(e); });
      req.end(data);
    }));
  }

  /**
   * A rubric for a task a module filed (modtasks.ts, after its own check of kernel.tasks): asked of the `task.rubric` checks.
   * None, a refusal or a failure: the filing fails and the module files again (same source, same task, same rubric).
   */
  async function rubric(task: { id: string; identifier?: string }, module: string, b: { rubric: string[]; deliverable: unknown }) {
    const takers = Object.entries(registry()).filter(([, c]) => c.at === "task.rubric" && c.url);
    if (!takers.length) throw fail(409, "conflict", "no module takes a rubric");
    for (const [id, c] of takers) {
      const v = await ask(c, { task, module, ...b }).catch((e: Error) => { throw fail(503, "check_failed", `${id} didn't take the rubric (${e.message})`); });
      if (v.verdict !== "ok") throw fail(409, "refused", `${id} refused the rubric${v.reason ? `: ${v.reason}` : ""}`);
    }
  }

  /**
   * Tasks the removed finish hold left waiting in review (its `check_holds` rows): each closes done, as its agent finished it,
   * once the gate passes, with the hold's label taken off; then the table goes. A read or move that fails (or a gate that still
   * refuses) is tried again on the next run.
   */
  async function releaseHolds() {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'check_holds'").get()) return;
    const tasks = (db.prepare("SELECT DISTINCT task FROM check_holds").all() as { task: string }[]).map((r) => r.task);
    for (const t of tasks) {
      try {
        const i = await issue(t).catch((e: { status?: number }) => (e.status === 404 ? undefined : Promise.reject(e)));
        if (i?.status === "in_review") {
          await finish(i.id);
          const labels = await owner("GET", `/api/companies/${encodeURIComponent(i.companyId ?? "")}/labels`);
          if (labels.status !== 200 || !Array.isArray(labels.json)) throw new Error(`the control plane answered ${labels.status} for the company's labels`);
          const grading = (labels.json as { id: string; name?: string }[]).find((l) => l.name === "grading")?.id;
          // Read again just before the move: a task reopened or cancelled meanwhile keeps its new state and labels.
          const now = await issue(i.id);
          const ids = now.labelIds ?? (now.labels ?? []).map((l) => l.id);
          // Still held: in review with the hold's label. A task moved or unlabelled since was taken over by hand and is left alone.
          if (now.status !== "in_review" || !grading || !ids.includes(grading)) { db.prepare("DELETE FROM check_holds WHERE task = ?").run(t); continue; }
          const r = await owner("PATCH", `/api/issues/${encodeURIComponent(i.id)}`, { status: "done", labelIds: ids.filter((x) => x !== grading) });
          if (r.status >= 300) throw new Error(`the control plane answered ${r.status}`);
          log("held task released", { task: i.identifier ?? i.id });
        }
        db.prepare("DELETE FROM check_holds WHERE task = ?").run(t);
      } catch (e) {
        log("a held task stays in review until the next start", { task: t, err: String((e as Error).message ?? e).slice(0, 200) });
      }
    }
    if (!db.prepare("SELECT 1 FROM check_holds LIMIT 1").get()) db.exec("DROP TABLE check_holds");
  }

  return { finish, rubric, releaseHolds };
}
export type Checks = ReturnType<typeof createChecks>;
