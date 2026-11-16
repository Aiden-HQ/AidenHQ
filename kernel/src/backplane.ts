// The kernel's backplane listener (10.231.0.1:3130): the tool proxy, caller identity, the keys modules check assertions
// with, the agent directory modules read, and the control plane as the calling agent.
//   GET  /healthz              ok
//   GET  /v1/jwks              the caller-assertion keys
//   GET  /v1/whoami            (run, job or module token) who the bearer is and its granted tools
//   GET  /v1/agents            (module token) every agent's key, roles and the fields setup records for it, never its tools
//   POST /c/<connection>/mcp   (run or module token) the tool proxy (proxy.ts)
//   ANY  /v1/cp/agent/<path>   (module token + caller assertion) cp.ts
//   POST /v1/writes            (run, module, or job token naming the kind) request a write (writes.ts); with the runner's key, one
//                              of its kinds (or kernel.apply) with its plan; GET /v1/writes/:id its record (own only; the board
//                              and the runner: any)
//   POST /v1/writes/:id/outcome (the kind's executor module, or the runner for its kinds) the outcome of an execute
//   GET  /v1/writes            (the board's or the runner's key) records by state or task
//   POST /v1/writes/:id/claim  (the runner's key) an approved record of its kinds, claimed once
//   POST /v1/writes/:id/review (the runner's key) a record's review: its tier input and what the reviewer reads (writes.ts)
//   GET  /v1/channel/cards, POST /v1/channel/{decide,owner-message,stop}, GET /v1/channel/notices  (a speaks-as-owner
//                              channel's token) cards with decision tokens, a token spent, the owner's words, notices (channels.ts)
//   POST /v1/channel/outbox, GET /v1/channel/outbox  (a channel) a message for the owner handed to another channel; drained by it
//   GET  /v1/cp/read/<path>    (a channel, or a module with role kernel.cp-read) the control plane's read routes, as the owner
//   POST /v1/brake/notify      (a channel) may an agent message the owner about a task again (brake.ts)
//   POST /v1/wake              (a module with role kernel.wake) a labelled wake notice on a task, which wakes its agent
//   POST /v1/reviews           (the runner's reviewer key) a check before filing: one review by the bound reviewer module → its verdict
//   POST /v1/reviews/:review   (that review's token, once) the reviewer module's verdict
import type { IncomingMessage, ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { Asserter } from "./assert.ts";
import type { Brake } from "./brake.ts";
import { CP_READ_PATHS, isChannel, neutral, type Api, type Channels, type ModulesFile } from "./channels.ts";
import type { Grant, Whoami } from "./identity.ts";
import { fail } from "./proxy.ts";
import type { Records, State } from "./records.ts";
import type { Reviews } from "./reviews.ts";
import { CONN_TOOL, type Writes } from "./writes.ts";

type Handler = (req: IncomingMessage, res: ServerResponse, ...a: string[]) => Promise<void>;
/** Directory fields a module may read; everything else in the grants table (tools, models, caps, images) stays here. */
const DIRECTORY = ["key", "roles", "trial", "delegate_to", "memory_inbox", "review_log", "graded", "feedback_for"];
const SETTINGS = ["grading", "loop_brake"];

/** What the listener serves: the router dispatches from this table and scripts/lean/contract-lock.mjs reads it, so the lock can't miss a route. */
export const ROUTES = [
  { method: "GET", path: "/healthz", auth: "none" },
  { method: "GET", path: "/v1/jwks", auth: "none" },
  { method: "GET", path: "/v1/whoami", auth: "bearer" },
  { method: "GET", path: "/v1/agents", auth: "module" },
  { method: "POST", path: "/c/:connection/mcp", auth: "bearer" },
  { method: "DELETE", path: "/c/:connection/mcp", auth: "bearer" },
  { method: "ANY", path: "/v1/cp/agent/*", auth: "module+assertion" },
  { method: "POST", path: "/v1/writes", auth: "bearer" },
  { method: "GET", path: "/v1/writes", auth: "board|runner" },
  { method: "GET", path: "/v1/writes/:id", auth: "bearer" },
  { method: "POST", path: "/v1/writes/:id/outcome", auth: "module|runner" },
  { method: "POST", path: "/v1/writes/:id/claim", auth: "runner" },
  { method: "POST", path: "/v1/writes/:id/review", auth: "runner" },
  { method: "GET", path: "/v1/channel/cards", auth: "module" },
  { method: "POST", path: "/v1/channel/decide", auth: "module" },
  { method: "POST", path: "/v1/channel/owner-message", auth: "module" },
  { method: "POST", path: "/v1/channel/stop", auth: "module" },
  { method: "GET", path: "/v1/channel/notices", auth: "module" },
  { method: "POST", path: "/v1/channel/outbox", auth: "module" },
  { method: "GET", path: "/v1/channel/outbox", auth: "module" },
  { method: "GET", path: "/v1/cp/read/*", auth: "module" },
  { method: "POST", path: "/v1/brake/notify", auth: "module" },
  { method: "POST", path: "/v1/wake", auth: "module" },
  { method: "POST", path: "/v1/reviews", auth: "reviewer-key" },
  { method: "POST", path: "/v1/reviews/:review", auth: "review-token" },
] as const;
// `:id` matches a record id, any other `:name` [a-z0-9_]+, a trailing `/*` the rest of the path, slash included.
const compiled = ROUTES.map((r) => ({ ...r, re: new RegExp(`^${r.path.replace(/:id\b/g, "(k-[0-9a-f]{16})").replace(/:review\b/g, "(r-[0-9a-f]{16})").replace(/:\w+/g, "([a-z0-9_]+)").replace(/\/\*$/, "(/.*)")}$`) }));
/** The record lists the board and the runner read (`?state=`). */
const ALL: State[] = ["review", "owner", "approved", "claimed", "done", "failed", "rejected", "stale", "cancelled", "unknown"];
const LISTS: { [k: string]: State[] } = { review: ["review"], owner: ["owner"], pending: ["review", "owner"], approved: ["approved"], recent: ALL, finished: ["done", "failed", "unknown"] };

async function json(req: IncomingMessage, max = 1_000_000): Promise<any> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req) { n += c.length; if (n > max) throw fail(413, "too_large", "too large"); chunks.push(c); }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch { throw fail(400, "bad_request", "the body must be JSON"); }
}

export function createBackplane({ whoami, asserter, proxy, cp, grantsFile, writes, records, channels, brake, owner, modules = () => ({}), boardKey = () => "", reviews, runnerKey = () => "", reviewerKey = () => "", log = () => {} }: {
  whoami: Whoami; asserter: Asserter; proxy: Handler; cp: Handler; grantsFile: () => { agents?: Record<string, Grant> } & Record<string, unknown>;
  writes?: Writes; records?: Records; boardKey?: () => string; log?: (msg: string, f?: Record<string, unknown>) => void;
  /** The reviewer slot; the runner's key for its kinds (filing, claim, outcome, reads, a record's review: runner_writes_key)
   * and the one its checks before filing ask with (reviewer_key, which the board holds too), each its own secret. */
  reviews?: Reviews; runnerKey?: () => string; reviewerKey?: () => string;
  /** 2f: channel tokens and owner messages, the notify brake, and the control plane as the owner (reads, wake notices). */
  channels?: Channels; brake?: Brake; owner?: Api; modules?: () => ModulesFile;
}) {
  /** The calling module (its own token), or 401. */
  const moduleOf = async (req: IncomingMessage) => {
    const w = await whoami(bearer(req)).catch(() => undefined);
    if (w?.kind !== "module" || !w.module) throw fail(401, "unauthorized", "a module's own token is required");
    return w;
  };
  /** The chief of staff's agent id, from the grants table (where owner messages go by default). */
  const cos = () => Object.entries(grantsFile().agents ?? {}).find(([, g]) => g.key === "chief-of-staff")?.[0];
  const keyIs = (req: IncomingMessage, key: string) => { const a = Buffer.from(bearer(req)), b = Buffer.from(key); return b.length > 0 && a.length === b.length && timingSafeEqual(a, b); };
  const isBoard = (req: IncomingMessage) => keyIs(req, boardKey());
  const isRunner = (req: IncomingMessage) => keyIs(req, runnerKey());
  const runner = (req: IncomingMessage) => { if (!isRunner(req)) throw fail(401, "unauthorized", "the runner's key is required"); };
  const reviewer = (req: IncomingMessage) => { if (!keyIs(req, reviewerKey())) throw fail(401, "unauthorized", "the runner's reviewer key is required"); };
  const record = (id: string) => records?.get(id) ?? (() => { throw fail(404, "not_found", `no record ${id}`); })();
  const send = (res: ServerResponse, status: number, body: unknown): void => void res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
  const bearer = (req: IncomingMessage) => String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "").trim();
  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const [path = "", q] = String(req.url ?? "").split(/\?(.*)/s);
    const query = q ? `?${q}` : "";
    try {
      const hit = compiled.find((r) => (r.method === "ANY" || r.method === req.method) && r.re.test(path));
      const m = hit ? hit.re.exec(path)!.slice(1) : [];
      switch (hit && `${hit.method} ${hit.path}`) {
        case "GET /healthz": return void res.writeHead(200, { "content-type": "text/plain" }).end("ok");
        case "GET /v1/jwks": return send(res, 200, asserter.jwks);
        case "GET /v1/whoami": {
          const w = await whoami(bearer(req)).catch((e: Error) => { throw fail(401, "unauthorized", e.message); });
          return send(res, 200, { kind: w.kind, ...(w.agent ? { agent: w.agent } : {}), roles: w.roles, ...(w.task ? { task: w.task } : {}), ...(w.run ? { run: w.run } : {}), ...(w.module ? { module: w.module } : {}), tools: w.tools });
        }
        case "GET /v1/agents": {
          const w = await whoami(bearer(req)).catch(() => undefined);
          if (w?.kind !== "module") throw fail(401, "unauthorized", "a module's own token is required");
          const t = grantsFile();
          const agents = Object.fromEntries(Object.entries(t.agents ?? {}).map(([id, g]) => [id, Object.fromEntries(DIRECTORY.filter((k) => g[k] !== undefined).map((k) => [k, g[k]]))]));
          return send(res, 200, { agents, settings: Object.fromEntries(SETTINGS.map((k) => [k, t[k] ?? "on"])) });
        }
        case "POST /c/:connection/mcp": case "DELETE /c/:connection/mcp": return await proxy(req, res, m[0]!);
        case "ANY /v1/cp/agent/*": return await cp(req, res, m[0]!, query);
      }
      if (hit && /^\/v1\/(channel|cp\/read|brake|wake)/.test(hit.path)) {
        const w = await moduleOf(req);
        const mod = w.module!;
        if (!channels || !brake || !owner) throw fail(503, "unavailable", "channels are off");
        switch (`${hit.method} ${hit.path}`) {
          case "GET /v1/channel/cards": return send(res, 200, await channels.cards(mod, new URLSearchParams(q ?? "").get("resync") === "1"));
          case "POST /v1/channel/decide": return send(res, 200, await channels.decide(mod, await json(req)));
          case "POST /v1/channel/owner-message": return send(res, 200, await channels.ownerMessage(mod, await json(req), cos));
          case "POST /v1/channel/stop": return send(res, 200, await channels.stop(mod, await json(req)));
          case "GET /v1/channel/notices": return send(res, 200, await channels.notices(mod));
          case "POST /v1/channel/outbox": return send(res, 200, channels.file(mod, await json(req)));
          case "GET /v1/channel/outbox": return send(res, 200, channels.drain(mod));
          case "GET /v1/cp/read/*": {
            if (!isChannel(modules().modules?.[mod]) && !w.roles.includes("kernel.cp-read")) throw fail(403, "forbidden", `${mod} has no read access to the control plane (role kernel.cp-read)`);
            if (!CP_READ_PATHS.some((re) => re.test(m[0]!))) throw fail(403, "forbidden", `GET ${m[0]} isn't a read route`);
            const r = await owner("GET", `${m[0]}${query}`);
            return send(res, r.status, r.json);
          }
          case "POST /v1/brake/notify": {
            if (!isChannel(modules().modules?.[mod])) throw fail(403, "forbidden", "only a channel asks the notify brake");
            return send(res, 200, await brake(await json(req)));
          }
          case "POST /v1/wake": {
            if (!w.roles.includes("kernel.wake")) throw fail(403, "forbidden", `${mod} may not post wake notices (role kernel.wake)`);
            const b = await json(req);
            const task = typeof b.task === "string" ? b.task.slice(0, 100) : "", text = typeof b.text === "string" ? neutral(b.text).trim().slice(0, 2000) : "";
            if (!task || !text) throw fail(400, "bad_request", "send {task, text}");
            const issue = await owner("GET", `/api/issues/${encodeURIComponent(task)}`);
            if (issue.status !== 200) throw fail(404, "not_found", `no task ${task}`);
            if (["done", "cancelled"].includes(issue.json.status)) return send(res, 200, { posted: false, closed: true });
            const c = await owner("POST", `/api/issues/${encodeURIComponent(issue.json.id)}/comments`, { body: `[wake] ${text}\n\n<!-- aidenhq-wake -->` });
            if (c.status >= 300) throw fail(502, "upstream", `the control plane answered ${c.status}`);
            log("wake notice", { module: mod, task: issue.json.identifier });
            return send(res, 200, { posted: true });
          }
        }
      }
      if (hit && hit.path.startsWith("/v1/reviews")) {
        if (!reviews) throw fail(503, "unavailable", "reviews are off");
        // A review request carries the whole diff: one past the reviewer's limit is still sent, so its verdict can say how large.
        if (hit.path === "/v1/reviews") {
          reviewer(req);
          const b = await json(req, 64_000_000);
          if (!b.request || typeof b.request !== "object") throw fail(400, "bad_request", "send {request}");
          return send(res, 200, await reviews.request(b.request));
        }
        const b = await json(req);
        if (!b || typeof b !== "object" || !reviews.verdict(m[0]!, bearer(req), b)) throw fail(404, "not_found", "no review waits for that token");
        return send(res, 200, { ok: true });
      }
      if (hit && hit.path.startsWith("/v1/writes")) {
        if (!writes || !records) throw fail(503, "unavailable", "records are off");
        const id = m[0] ?? "";
        switch (`${hit.method} ${hit.path}`) {
          case "POST /v1/writes": {
            if (isRunner(req)) {
              const b = await json(req, 8_000_000);
              const r = writes.fileRunner({ kind: String(b.kind ?? ""), task: String(b.task ?? ""), ...(typeof b.identifier === "string" ? { identifier: b.identifier.slice(0, 40) } : {}), args: b.args, plan: b.plan ?? {} });
              return send(res, 200, r);
            }
            const w = await whoami(bearer(req)).catch((e: Error) => { throw fail(401, "unauthorized", e.message); });
            const b = await json(req);
            const r = await writes.request(w, { kind: String(b.kind ?? ""), args: b.args, ...(typeof b.task === "string" ? { task: b.task } : {}), ...(b.evidence !== undefined ? { evidence: b.evidence } : {}) });
            return send(res, 200, { id: r.id, tier: r.tier, state: r.state });
          }
          case "GET /v1/writes": {
            const asRunner = isRunner(req);
            if (!asRunner && !isBoard(req)) throw fail(401, "unauthorized", "the board's or the runner's key is required");
            const p = new URLSearchParams(q ?? "");
            const list = LISTS[p.get("state") ?? ""];
            if (!list) throw fail(400, "bad_request", `state=${Object.keys(LISTS).join(", ")}`);
            const task = p.get("task") || undefined;
            // The reviewed ones only (every Tier 0 write is a record too, and would crowd the cards out); the runner's
            // approved list is its own kinds, and its review list says which wait out a failed review's backoff.
            const rows = records.list(list, Math.min(Number(p.get("limit")) || 100, 1000), { reviewed: true, ...(task ? { task } : {}) });
            const shown = asRunner && list === LISTS.approved ? rows.filter((r) => writes.isRunnerKind(r.kind)) : rows;
            return send(res, 200, { records: shown.map((r) => ({ ...r, state: records.shownState(r), ...(writes.retryAt(r.id) ? { retry_at: writes.retryAt(r.id) } : {}) })) });
          }
          case "GET /v1/writes/:id": {
            if (isBoard(req) || isRunner(req)) return send(res, 200, record(id));
            const w = await whoami(bearer(req)).catch((e: Error) => { throw fail(401, "unauthorized", e.message); });
            const r = record(id);
            const own = w.kind === "module" ? w.module === r.requester.module && r.requester.kind === "module" : Boolean(w.agent) && w.agent === r.requester.agent;
            if (!own) throw fail(404, "not_found", `no record ${id}`);
            return send(res, 200, { id: r.id, kind: r.kind, tier: r.tier, state: r.state, outcome: r.outcome });
          }
          case "POST /v1/writes/:id/outcome": {
            const r = record(id);
            if (isRunner(req) ? !writes.isRunnerKind(r.kind) : await whoami(bearer(req)).then((w) => w.kind !== "module" || r.kind === CONN_TOOL || w.module !== r.executor.module, () => true)) throw fail(403, "forbidden", "only the kind's executor reports its outcome");
            const b = await json(req);
            if (!writes.outcome(id, b.ok === true, String(b.text ?? "").slice(0, 200_000))) throw fail(409, "conflict", `this record is ${record(id).state}`);
            return send(res, 200, { ok: true });
          }
          case "POST /v1/writes/:id/claim": {
            runner(req);
            const r = writes.claim(id);
            if (!r) throw fail(409, "conflict", `this record is ${records.shownState(record(id))}`);
            return send(res, 200, r);
          }
          case "POST /v1/writes/:id/review": {
            runner(req);
            const b = await json(req, 64_000_000);
            if (!b.input || typeof b.input !== "object" || typeof b.input.tier !== "number") throw fail(400, "bad_request", "send {input: {tier, …}, request}");
            return send(res, 200, await writes.review(id, { input: b.input, request: b.request && typeof b.request === "object" ? b.request : {} }));
          }
        }
      }
      send(res, 404, { error: "no such route" });
    } catch (err) {
      const e = err as Error & { status?: number; type?: string };
      const status = e.status ?? 500;
      if (status >= 500) log("backplane error", { url: path, status, err: String(e.message).slice(0, 300) });
      if (!res.headersSent) send(res, status, { error: { code: status, type: e.type ?? "error", message: e.message } });
      else res.destroy();
    }
  };
}
