// The apps platform's write kinds (modules/apps-platform/module.yaml), executor@1: the kernel files app_deploy, app_run_request,
// app_restart, app_rollback and app_api calls as records and calls here. plan checks the caller and pins what runs (the exact
// commit, the running commit a script runs at), and raises a stateful deploy to the reviewer (labelled when it touches a
// migration); execute runs only an approved, revalidated record.
import { remoteHead } from "./git.js";
import { callApi, authorize, METHODS, type Method } from "./api.js";
import { canMutate, type Caller } from "./mcp.js";
import { canView } from "./view.js";
import type { Platform } from "./platform.js";
import { assertOwner, RUN_TIMEOUT_MS } from "./run.js";
import type { Executor, PlanResult, Requester } from "./aidenhq-sdk/executor.js";

/** Where a deploy card's details end and the author's commit message begins (the runner's reviewer splits on it). */
export const DEPLOY_CLAIM = "\n\nCommit message (written by the app's author): ";
/** A deploy whose diff touches a migration, .sql or schema file (file names from `diff --git` headers only, which a hunk can't forge). */
export const touchesMigrations = (diff: string) => diff.split("\n").some((l) => l.startsWith("diff --git ") && /migrat|\.sql\b|schema/i.test(l));
const oneLine = (s: unknown, max: number) => String(s ?? "").replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/g, " ").trim().slice(0, max);

export function appsExecutor(p: Platform): Executor {
  const caller = (r: Requester): Caller => {
    if (!r?.agent || !r.key) throw new Error("agent identity required");
    return { id: r.agent, key: r.key, name: r.name, roles: r.roles ?? [] };
  };
  const mutable = (name: unknown, c: Caller) => {
    const a = p.find(String(name ?? ""));
    if (!canMutate(p, a, c)) throw new Error(`${c.name} can't change ${a.name}: only its owner (${a.owner}), or the app builder (app-maintainer) during an incident`);
    return a;
  };

  return {
    async plan({ kind, args, requester }): Promise<PlanResult> {
      const c = caller(requester);
      switch (kind) {
        case "apps-platform.deploy": {
          const a = mutable(args?.name, c);
          const want = typeof args?.sha === "string" && args.sha ? args.sha : await remoteHead(p.cfg.git, a);
          const com = await p.commit(a, want);
          const base = { args: { name: a.name, sha: com.sha, stateful: Boolean(a.stateful) }, targets: { repo: a.repo, ref: a.branch, commit: com.sha }, card: { short: com.sha.slice(0, 12), kept: a.stateful ? " (a stateful app; its data stays)" : "" } };
          if (!a.stateful) return { ...base, card: { ...base.card, details: `app: ${a.name}\ncommit: ${com.sha}` } };
          // Stateful: the reviewer's (a migration labelled as one). Already running, healthy: nothing to file.
          const running = p.cached(a) as { sha?: string; healthy?: boolean };
          if (running.sha === com.sha && running.healthy) return { ...base, satisfied: { evidence: `${a.name} already runs ${com.sha.slice(0, 12)} and is healthy` } };
          if (com.truncated) throw new Error(`the change to ${a.name} since its running commit is too large (or couldn't be read) to review; deploy it in smaller steps, or try again`);
          const migration = touchesMigrations(com.diff);
          return {
            ...base,
            raise: { tier: 1, rule: migration ? "deploy-migration" : "deploy-stateful", reason: migration ? "a stateful deploy that touches a migration or schema file" : "a stateful deploy with no migration or schema change" },
            card: { ...base.card, details: `app: ${a.name}\ncommit: ${com.sha}\n\nChanges since the running commit:\n${com.diff || "(none in the app's directory: a redeploy of its last healthy commit, or a commit that changed only other files)"}${DEPLOY_CLAIM}${oneLine(com.subject, 120)}` },
          };
        }
        case "apps-platform.run": {
          const a = p.find(String(args?.name ?? ""));
          assertOwner(a, c.key);
          const r = await p.runPlan(a, String(args?.script ?? ""), typeof args?.service === "string" && args.service ? args.service : undefined);
          if (/[\p{Cc}\p{Cf}]/u.test(r.command) || r.command.length > 500) throw new Error("the script's command has control characters or is too long to show");
          return {
            args: { name: a.name, script: String(args.script), service: r.service, sha: r.sha }, targets: { commit: r.sha },
            card: { short: r.sha.slice(0, 12), details: `app: ${a.name}\nservice: ${r.service}\ncommit: ${r.sha}\nruns: npm run ${args.script}\nScript (from the app's package.json): ${r.command}\nReason (written by the requesting agent): ${oneLine(args.reason, 300)}` },
          };
        }
        case "apps-platform.restart": return { args: { name: mutable(args?.name, c).name } };
        case "apps-platform.rollback": {
          const a = mutable(args?.name, c);
          if (a.stateful) throw new Error(`${a.name} is stateful: rollback needs the owner's approval`);
          return { args: { name: a.name } };
        }
        case "apps-platform.api_write": {
          const a = p.find(String(args?.name ?? ""));
          const method = String(args?.method ?? "") as Method;
          if (!METHODS.includes(method)) throw new Error(`method must be one of ${METHODS.join(", ")}`);
          // The kernel routes recorded arguments here, so the MCP enum is not the gate: only an omitted role defaults.
          if (args.role !== undefined && args.role !== "admin" && args.role !== "member") throw new Error(`role must be admin or member, not ${JSON.stringify(args.role)}`);
          const role = args.role ?? "admin";
          // A member request is what app_view would do: the same caller and the same read-access policy, so an agent that
          // cannot view a restricted app cannot reach it through app_api either.
          if (role === "member" && !canView(a, c.roles)) throw new Error(`no access to ${a.name}`);
          authorize(a, c.key, String(args?.path ?? ""), method, role);
          const out = { name: a.name, caller: c.key, method, path: String(args.path), role, ...(args.body !== undefined ? { body: args.body } : {}) };
          return { args: out, card: { details: `${method} ${out.path} as ${role}${args.body !== undefined ? `\nbody (written by the requesting agent): ${JSON.stringify(args.body).slice(0, 2000)}` : ""}` } };
        }
      }
      throw new Error(`no write kind ${kind} here`);
    },

    async execute({ id, kind, args }) {
      const a = p.find(String(args.name));
      const by = `approval ${id}`;
      switch (kind) {
        case "apps-platform.deploy": {
          const r = await p.engine.deploy(a, { sha: args.sha, by, allowStateful: true });
          return { ok: r.status === "healthy", text: JSON.stringify(r) };
        }
        case "apps-platform.run": {
          const r = await p.engine.run(a, { script: args.script, service: args.service, sha: args.sha, timeoutMs: RUN_TIMEOUT_MS });
          const what = `\`npm run ${args.script}\` in app ${a.name} at ${String(args.sha).slice(0, 8)}`;
          return { ok: r.ok, text: `${r.ok ? `Ran ${what}.` : `${what} did not succeed${r.timed_out ? " (timed out after 10 minutes; the process may still be running in the container)" : ""}.`}\n\nOutput tail (written by the app):\n${String(r.output ?? "").slice(-3000)}` };
        }
        case "apps-platform.restart": { const r = await p.engine.restart(a); return { ok: r.healthy, text: JSON.stringify(r) }; }
        case "apps-platform.rollback": { const r = await p.engine.rollback(a, { by }); return { ok: r.status === "healthy", text: JSON.stringify(r) }; }
        case "apps-platform.api_write": {
          const r = await callApi(a, args.caller, { method: args.method, path: args.path, body: args.body, role: args.role }, { sign: p.sign, send: p.sendApi, resolve: p.resolveApi, audit: p.auditApi });
          return { ok: r.status >= 200 && r.status < 300, text: JSON.stringify(r) };
        }
      }
      throw new Error(`no write kind ${kind} here`);
    },
  };
}
