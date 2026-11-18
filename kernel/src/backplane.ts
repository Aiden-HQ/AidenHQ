// The kernel's backplane listener (10.231.0.1:3130): the tool proxy, caller identity, the keys modules check assertions
// with, the agent directory modules read, and the control plane as the calling agent.
//   GET  /healthz              ok
//   GET  /v1/jwks              the caller-assertion keys
//   GET  /v1/whoami            (run, job or module token) who the bearer is and its granted tools
//   GET  /v1/agents            (module token) every agent's key, roles, profile and the fields setup records for it, never its tools
//   POST /c/<connection>/mcp   (run or module token) the tool proxy (proxy.ts)
//   ANY  /v1/cp/agent/<path>   (module token + caller assertion) cp.ts; a status change to done passes the finish gate
//   POST /v1/finish            (the runner's key) the finish gate for one of the runner's own closes (checks.ts)
//   POST /v1/checks/:task      (a check's module) release its label on a task, or resolve a hold it placed (checks.ts)
//   POST /v1/writes            (run, module, or job token naming the kind) request a write (writes.ts); with the runner's key, one
//                              of its kinds (or kernel.apply) with its plan; GET /v1/writes/:id its record (own only; the board
//                              and the runner: any)
//   POST /v1/writes/:id/outcome (the kind's executor module, or the runner for its kinds) the outcome of an execute
//   GET  /v1/writes            (the board's or the runner's key) records by state or task (`tier0=1`: Tier 0 runs too)
//   POST /v1/writes/:id/claim  (the runner's key) an approved record of its kinds, claimed once
//   POST /v1/writes/:id/review (the runner's key) a record's review: its tier input and what the reviewer reads (writes.ts)
//   GET  /v1/channel/cards, POST /v1/channel/{decide,owner-message,stop,thread}, GET /v1/channel/notices  (a speaks-as-owner
//                              channel's token) cards with decision tokens, a token spent, the owner's words, notices (channels.ts)
//   POST /v1/channel/outbox, GET /v1/channel/outbox  (a channel) a message for the owner handed to another channel; drained by it
//   GET  /v1/cp/read/<path>    (a channel, or a module with role kernel.cp-read) the control plane's read routes, as the owner
//   POST /v1/brake/notify      (a channel, or the owner's router) may an agent message the owner about a task again (brake.ts)
//   POST /v1/channel/exchange  (a module with role kernel.lane) a fast-lane turn written to its agent's chat task (lane.ts)
//   POST /v1/notify            (the board's or the runner's key) a message for the owner, queued for the owner's router (notify.ts)
//   GET  /v1/notify/take, POST /v1/notify/send  (the module with role kernel.notify) the queued owner messages, each once; one
//                              message to a channel's transport
//   POST /v1/wake              (a module with role kernel.wake) a labelled wake notice on a task, which wakes its agent
//   POST /v1/wakes/events      (the paperclip-events plugin's key) a Paperclip event's ids: its task is scanned (wakes.ts)
//   POST /v1/wakes             (a module with role kernel.wake) a scheduled wake {task, agent?, at?, cause?, id?}
//   POST /v1/wakes/claim, POST /v1/wakes/:key/drop  (a module with role kernel.jobs) claim inbox rows; give one up
//   POST /v1/wakes/:key/note   (the module that claimed it) {body}: a note on its task as its agent, once (no job answers it)
//   POST /v1/reviews           (the runner's reviewer key) a check before filing: one review by the bound reviewer module → its verdict
//   POST /v1/reviews/:review   (that review's token, once) the reviewer module's verdict
//   POST /v1/jobs, GET/DELETE /v1/jobs/:job, POST /v1/jobs/:job/input  (a module with role kernel.jobs) start a job in the
//                              sandbox, its status (?after=<version>&wait=<ms> waits for a change), stop it, a comment into it (jobs.ts; `wake`: the claimed comment wake it delivers);
//                              POST /v1/jobs {wake, prompt, session?}: a job on a wake it claimed, admitted (admission.ts)
//   GET  /v1/work[?task=], GET /v1/work/metrics  (a module with role kernel.work-read) the jobs and records of the kernel's
//                              work: a task's, or what runs and ended lately; Prometheus text (work.ts)
//   POST /v1/work/grader-token  (the one module with role kernel.grader) {task} -> a gateway
//                              token billed to the task's assignee under its caps, for a task its finish check holds; one live token per task
//   POST /v1/jobs/:job/post    (that job's module) {kind: reply|status|notice, body, status?, blocked_by?}: posted on the job's
//                              task as its agent, once per kind (outcomes.ts)
//   POST /v1/checks, GET /v1/checks/:check, POST /v1/receipts/verify  (a module with role kernel.checks) a credential-free check
//                              job of repo@head and its signed receipt (?after=<version>&wait=<ms>), a receipt checked against
//                              {repo, head, run, judge?, policy?} (checkjobs.ts)
//   GET  /v1/advisories        (the board's key) the marketplace advisories open against installed modules (loader/advisories.ts)
//   POST /v1/auth/:op, /v1/accounts/:op, /v1/apps/:op, /v1/operator/:op  the accounts' routes (auth-api.ts): module UI
//                              sessions and account admin (the board), in-app requests (apps-platform), setup links (operator)
import type { IncomingMessage, ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { Asserter } from "./assert.ts";
import type { Brake } from "./brake.ts";
import type { Checks } from "./checks.ts";
import type { Lane } from "./lane.ts";
import type { Checks as CheckJobs } from "./checkjobs.ts";
import { CP_READ_PATHS, isChannel, neutral, type Api, type Channels, type ModulesFile } from "./channels.ts";
import type { Grant, Whoami } from "./identity.ts";
import type { Jobs } from "./jobs.ts";
import type { Admission } from "./admission.ts";
import { JOB_KINDS, type Outcomes } from "./outcomes.ts";
import { notice, type Notify } from "./notify.ts";
import { fail } from "./proxy.ts";
import type { Records, State } from "./records.ts";
import type { Work } from "./work.ts";
import type { Reviews } from "./reviews.ts";
import type { Wakes } from "./wakes.ts";
import { CONN_TOOL, type Writes } from "./writes.ts";

const MAX_ATTACHMENT = 25 * 1024 * 1024;
type Handler = (req: IncomingMessage, res: ServerResponse, ...a: string[]) => Promise<void>;
/** Directory fields a module may read; everything else in the grants table (tools, models, caps, images) stays here. */
const DIRECTORY = ["key", "roles", "profile", "trial", "description", "delegate_to", "memory_inbox", "review_log", "graded", "feedback_for"];

/** What the listener serves: the router dispatches from this table and scripts/lean/contract-lock.mjs reads it, so the lock can't miss a route. */
export const ROUTES = [
  { method: "GET", path: "/healthz", auth: "none" },
  { method: "GET", path: "/v1/jwks", auth: "none" },
  { method: "GET", path: "/v1/whoami", auth: "bearer" },
  { method: "GET", path: "/v1/agents", auth: "module" },
  { method: "POST", path: "/c/:connection/mcp", auth: "bearer" },
  { method: "DELETE", path: "/c/:connection/mcp", auth: "bearer" },
  { method: "ANY", path: "/v1/cp/agent/*", auth: "module+assertion" },
  { method: "POST", path: "/v1/finish", auth: "runner" },
  { method: "POST", path: "/v1/checks/:task", auth: "module" },
  { method: "POST", path: "/v1/writes", auth: "bearer" },
  { method: "GET", path: "/v1/writes", auth: "board|runner" },
  { method: "GET", path: "/v1/writes/:id", auth: "bearer" },
  { method: "POST", path: "/v1/writes/:id/outcome", auth: "module|runner" },
  { method: "POST", path: "/v1/writes/:id/claim", auth: "runner" },
  { method: "POST", path: "/v1/writes/held", auth: "runner" },
  { method: "POST", path: "/v1/writes/:id/review", auth: "runner" },
  { method: "GET", path: "/v1/channel/cards", auth: "module" },
  { method: "POST", path: "/v1/channel/decide", auth: "module" },
  { method: "POST", path: "/v1/channel/owner-message", auth: "module" },
  { method: "POST", path: "/v1/channel/stop", auth: "module" },
  { method: "POST", path: "/v1/channel/thread", auth: "module" },
  { method: "GET", path: "/v1/channel/notices", auth: "module" },
  { method: "POST", path: "/v1/channel/outbox", auth: "module" },
  { method: "GET", path: "/v1/channel/outbox", auth: "module" },
  { method: "POST", path: "/v1/channel/exchange", auth: "module" },
  { method: "GET", path: "/v1/cp/read/*", auth: "module" },
  { method: "POST", path: "/v1/brake/notify", auth: "module" },
  { method: "POST", path: "/v1/notify", auth: "board|runner" },
  { method: "GET", path: "/v1/notify/take", auth: "module" },
  { method: "POST", path: "/v1/notify/send", auth: "module" },
  { method: "POST", path: "/v1/wake", auth: "module" },
  { method: "POST", path: "/v1/wakes/events", auth: "events-key" },
  { method: "POST", path: "/v1/wakes", auth: "module" },
  { method: "POST", path: "/v1/wakes/claim", auth: "module" },
  { method: "POST", path: "/v1/wakes/:key/drop", auth: "module" },
  { method: "POST", path: "/v1/wakes/:key/note", auth: "module" },
  { method: "POST", path: "/v1/reviews", auth: "reviewer-key" },
  { method: "POST", path: "/v1/reviews/:review", auth: "review-token" },
  { method: "POST", path: "/v1/jobs", auth: "module" },
  { method: "GET", path: "/v1/jobs/:job", auth: "module" },
  { method: "DELETE", path: "/v1/jobs/:job", auth: "module" },
  { method: "POST", path: "/v1/jobs/:job/input", auth: "module" },
  { method: "GET", path: "/v1/work", auth: "module" },
  { method: "GET", path: "/v1/work/metrics", auth: "module" },
  { method: "POST", path: "/v1/work/grader-token", auth: "module" },
  { method: "POST", path: "/v1/jobs/:job/post", auth: "module" },
  { method: "POST", path: "/v1/checks", auth: "module" },
  { method: "GET", path: "/v1/checks/:check", auth: "module" },
  { method: "POST", path: "/v1/receipts/verify", auth: "module" },
  { method: "GET", path: "/v1/advisories", auth: "board" },
  { method: "POST", path: "/v1/auth/:op", auth: "board" },
  { method: "POST", path: "/v1/accounts/:op", auth: "board+session" },
  { method: "POST", path: "/v1/apps/:op", auth: "module" },
  { method: "POST", path: "/v1/operator/:op", auth: "operator-key" },
] as const;
// `:id` matches a record id, any other `:name` [a-z0-9_]+, a trailing `/*` the rest of the path, slash included.
const compiled = ROUTES.map((r) => ({ ...r, re: new RegExp(`^${r.path.replace(/:id\b/g, "(k-[0-9a-f]{16})").replace(/:review\b/g, "(r-[0-9a-f]{16})").replace(/:job\b/g, "(j-[0-9a-f]{16})").replace(/:check\b/g, "(c-[0-9a-f]{16})").replace(/:task\b/g, "([0-9a-f-]{36})").replace(/:key\b/g, "([^/]{1,200})").replace(/:\w+/g, "([a-z0-9_]+)").replace(/\/\*$/, "(/.*)")}$`) }));
/** The record lists the board and the runner read (`?state=`). */
const ALL: State[] = ["review", "owner", "approved", "claimed", "done", "failed", "rejected", "stale", "cancelled", "unknown"];
const LISTS: { [k: string]: State[] } = { review: ["review"], owner: ["owner"], pending: ["review", "owner"], approved: ["approved"], recent: ALL, finished: ["done", "failed", "unknown"] };

async function json(req: IncomingMessage, max = 1_000_000): Promise<any> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req) { n += c.length; if (n > max) throw fail(413, "too_large", "too large"); chunks.push(c); }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch { throw fail(400, "bad_request", "the body must be JSON"); }
}

export function createBackplane({ whoami, asserter, proxy, cp, grantsFile, writes, records, channels, brake, notify, owner, modules = () => ({}), boardKey = () => "", reviews, runnerKey = () => "", reviewerKey = () => "", jobs, admission, outcomes, wakes, eventsKey = () => "", work, graderToken = () => "", dropGraderToken = () => {}, advisories = () => [], accounts, checks, checkJobs, ownerRaw, lane, log = () => {} }: {
  whoami: Whoami; asserter: Asserter; proxy: Handler; cp: Handler; grantsFile: () => { agents?: Record<string, Grant> } & Record<string, unknown>;
  writes?: Writes; records?: Records; boardKey?: () => string; log?: (msg: string, f?: Record<string, unknown>) => void;
  /** The reviewer slot; the runner's key for its kinds (filing, claim, outcome, reads, a record's review: runner_writes_key)
   * and the one its checks before filing ask with (reviewer_key, which the board holds too), each its own secret. */
  reviews?: Reviews; runnerKey?: () => string; reviewerKey?: () => string;
  /** 2f: channel tokens and owner messages, the notify brake, and the control plane as the owner (reads, wake notices). */
  channels?: Channels; brake?: Brake; owner?: Api; modules?: () => ModulesFile;
  /** The control plane as the owner, the raw response (an attachment's bytes, which `owner`'s JSON can't carry). */
  ownerRaw?: (path: string) => Promise<Response>;
  /** The fast chat lane's exchanges onto its agents' chat tasks (lane.ts). */
  lane?: Lane;
  /** 3.2: the owner's messages, queued for the owner-channel module and handed to channels' transports. */
  notify?: Notify;
  /** 3e: jobs in the sandbox. */
  jobs?: Jobs;
  /** Admission (admission.ts): a job on a wake the module claimed, its authority frozen, its computer the kernel's (boxes.ts). */
  admission?: Admission;
  /** F5: a job's outcome posted as its agent. */
  outcomes?: Outcomes;
  /** The wake inbox (wakes.ts), and the paperclip-events plugin's key. */
  wakes?: Wakes; eventsKey?: () => string;
  /** Reads of the work the kernel owns (work.ts). */
  work?: Work;
  /** A grader-kind gateway token for a task (the kernel is the only minter). */
  graderToken?: (task: string, agent: string) => string;
  /** Forget a task's cached grader token (its hold resolved or was released). */
  dropGraderToken?: (task: string) => void;
  /** 4e: the open marketplace advisories. */
  advisories?: () => unknown[];
  /** 3g: the accounts' routes (auth-api.ts). */
  accounts?: (req: IncomingMessage, res: ServerResponse, group: string, op: string) => Promise<void>;
  /** 3h: the finish gate (checks.ts). */
  checks?: Checks;
  /** Check jobs and their receipts (checkjobs.ts). */
  checkJobs?: CheckJobs;
}) {
  /** The calling module (its own token), or 401. */
  const moduleOf = async (req: IncomingMessage) => {
    const w = await whoami(bearer(req)).catch(() => undefined);
    if (w?.kind !== "module" || !w.module) throw fail(401, "unauthorized", "a module's own token is required");
    return w;
  };
  /** The chief of staff's agent id, from the grants table (where owner messages go by default). */
  const cos = () => chiefOfStaff(grantsFile().agents);
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
          // The instance's settings setup writes beside the agents (kill switches, the repos): every top-level string.
          return send(res, 200, { agents, settings: Object.fromEntries(Object.entries(t).filter(([, v]) => typeof v === "string")) });
        }
        case "POST /c/:connection/mcp": case "DELETE /c/:connection/mcp": return await proxy(req, res, m[0]!);
        case "ANY /v1/cp/agent/*": return await cp(req, res, m[0]!, query);
        case "POST /v1/finish": {
          runner(req);
          if (!checks) throw fail(503, "unavailable", "checks are off");
          const b = await json(req);
          if (typeof b.task !== "string" || !["finish_turn", "finish_merges"].includes(b.via)) throw fail(400, "bad_request", "send {task, via: finish_turn|finish_merges}");
          const f = await checks.finish(b.task.slice(0, 100), { via: b.via });
          return send(res, 200, f.pass ? { pass: true } : "held" in f ? { pass: false, state: f.state } : { pass: false, reopened: true });
        }
        case "POST /v1/checks/:task": {
          const w = await moduleOf(req);
          if (!checks) throw fail(503, "unavailable", "checks are off");
          const resolved = await checks.resolve(w.module!, m[0]!, await json(req));
          dropGraderToken(m[0]!);
          return send(res, 200, resolved);
        }
        case "POST /v1/notify": {
          if (!isBoard(req) && !isRunner(req)) throw fail(401, "unauthorized", "the board's or the runner's key is required");
          if (!notify) throw fail(503, "unavailable", "notify is off");
          notify.queue(notice(await json(req)));
          return send(res, 200, { queued: true });
        }
        case "GET /v1/notify/take": case "POST /v1/notify/send": {
          const w = await moduleOf(req);
          if (!notify) throw fail(503, "unavailable", "notify is off");
          return send(res, 200, hit!.method === "GET" ? notify.take(w.roles) : await notify.send(w.roles, await json(req)));
        }
        case "GET /v1/advisories": if (!isBoard(req)) throw fail(401, "unauthorized", "the board's key is required"); return send(res, 200, { advisories: advisories() });
      }
      if (hit && hit.path.startsWith("/v1/wakes")) {
        if (!wakes) throw fail(503, "unavailable", "the wake inbox is off");
        if (hit.path === "/v1/wakes/events") {
          if (!keyIs(req, eventsKey())) throw fail(401, "unauthorized", "the events plugin's key is required");
          return send(res, 200, await wakes.event(await json(req)));
        }
        const w = await moduleOf(req);
        if (hit.path === "/v1/wakes") {
          if (!w.roles.includes("kernel.wake")) throw fail(403, "forbidden", `${w.module} may not schedule wakes (role kernel.wake)`);
          const r = await wakes.schedule(w.module!, await json(req));
          if ("error" in r) throw fail(400, "bad_request", r.error!);
          return send(res, 200, r);
        }
        if (!w.roles.includes("kernel.jobs")) throw fail(403, "forbidden", `${w.module} may not claim wakes (role kernel.jobs)`);
        const b = await json(req);
        if (hit.path === "/v1/wakes/claim") return send(res, 200, { wakes: wakes.claim(w.module!, Math.min(Math.max(Number(b.limit) || 20, 1), 100)) });
        if (hit.path === "/v1/wakes/:key/note") {
          const r = await wakes.note(w.module!, decodeURIComponent(m[0]!), b.body).catch((e: { name?: string; status?: number; code?: string; message: string }) => {
            throw e.name === "OutcomeError" ? fail(e.status!, e.code!, e.message) : e;
          });
          if ("error" in r) throw fail(r.status, "bad_request", r.error);
          return send(res, 200, r);
        }
        return send(res, 200, wakes.drop(w.module!, decodeURIComponent(m[0]!), String(b.why ?? "")));
      }
      if (hit && /^\/v1\/(channel|cp\/read|brake|wake)/.test(hit.path)) {
        const w = await moduleOf(req);
        const mod = w.module!;
        if (!channels || !brake || !owner) throw fail(503, "unavailable", "channels are off");
        switch (`${hit.method} ${hit.path}`) {
          case "GET /v1/channel/cards": return send(res, 200, await channels.cards(mod, new URLSearchParams(q ?? "").get("resync") === "1"));
          case "POST /v1/channel/decide": return send(res, 200, await channels.decide(mod, await json(req)));
          case "POST /v1/channel/owner-message": return send(res, 200, await channels.ownerMessage(mod, await json(req), cos));
          case "POST /v1/channel/thread": {
            const b = await json(req);
            return send(res, 200, await channels.thread(mod, b, (key) => { const e = Object.entries(grantsFile().agents ?? {}).find(([, g]) => key && g.key === key); return e && { id: e[0], trial: Boolean(e[1].trial) }; }));
          }
          case "POST /v1/channel/stop": return send(res, 200, await channels.stop(mod, await json(req)));
          case "GET /v1/channel/notices": return send(res, 200, await channels.notices(mod));
          case "POST /v1/channel/outbox": return send(res, 200, channels.file(mod, await json(req)));
          case "GET /v1/channel/outbox": return send(res, 200, channels.drain(mod));
          case "POST /v1/channel/exchange": {
            if (!w.roles.includes("kernel.lane")) throw fail(403, "forbidden", `${mod} may not write lane exchanges (role kernel.lane)`);
            if (!lane) throw fail(503, "unavailable", "the lane is off");
            return send(res, 200, await lane.exchange(mod, await json(req)));
          }
          case "GET /v1/cp/read/*": {
            if (!isChannel(modules().modules?.[mod]) && !w.roles.includes("kernel.cp-read")) throw fail(403, "forbidden", `${mod} has no read access to the control plane (role kernel.cp-read)`);
            const att = /^\/attachments\/([A-Za-z0-9_-]{1,100})\/content$/.exec(m[0]!);
            if (att) {
              // One attachment's bytes: only one listed on the task named by ?task= (the same listing a module reads), at most 25 MB.
              const task = new URLSearchParams(q ?? "").get("task") ?? "";
              if (!task || task.length > 100) throw fail(400, "bad_request", "send ?task=<the task the attachment is on>");
              if (!ownerRaw) throw fail(503, "unavailable", "the control plane is off");
              const list = await owner("GET", `/api/issues/${encodeURIComponent(task)}/attachments`);
              if (list.status !== 200 || !Array.isArray(list.json) || !list.json.some((a: { id?: string }) => a?.id === att[1])) throw fail(404, "not_found", `no attachment ${att[1]} on task ${task.slice(0, 100)}`);
              const r = await ownerRaw(`/api/attachments/${att[1]}/content`);
              if (!r.ok) throw fail(r.status === 404 ? 404 : 502, r.status === 404 ? "not_found" : "upstream", `the control plane answered ${r.status}`);
              if (Number(r.headers.get("content-length") ?? 0) > MAX_ATTACHMENT) throw fail(413, "too_large", `the attachment is over ${MAX_ATTACHMENT} bytes`);
              const bytes = Buffer.from(await r.arrayBuffer());
              if (bytes.length > MAX_ATTACHMENT) throw fail(413, "too_large", `the attachment is over ${MAX_ATTACHMENT} bytes`);
              return void res.writeHead(200, { "content-type": r.headers.get("content-type") ?? "application/octet-stream", "content-length": bytes.length }).end(bytes);
            }
            if (!CP_READ_PATHS.some((re) => re.test(m[0]!))) throw fail(403, "forbidden", `GET ${m[0]} isn't a read route`);
            const r = await owner("GET", `${m[0]}${query}`);
            return send(res, r.status, r.json);
          }
          case "POST /v1/brake/notify": {
            if (!isChannel(modules().modules?.[mod]) && !w.roles.includes("kernel.notify")) throw fail(403, "forbidden", "only a channel or the owner's router asks the notify brake");
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
      if (hit && /^\/v1\/(auth|accounts|apps|operator)\/:op$/.test(hit.path)) {
        if (!accounts) throw fail(503, "unavailable", "accounts are off");
        return await accounts(req, res, hit.path.split("/")[2]!, m[0]!);
      }
      if (hit && hit.path.startsWith("/v1/work")) {
        const w = await moduleOf(req);
        if (hit.path !== "/v1/work/grader-token" && !w.roles.includes("kernel.work-read")) throw fail(403, "forbidden", `${w.module} may not read kernel work (role kernel.work-read)`);
        if (!work) throw fail(503, "unavailable", "work reads are off");
        if (hit.path === "/v1/work/grader-token") {
          if (!w.roles.includes("kernel.grader")) throw fail(403, "forbidden", `${w.module} may not ask for grader tokens (role kernel.grader)`);
          const b = await json(req);
          if (typeof b.task !== "string" || !b.task) throw fail(400, "bad_request", "send {task}");
          // Only a task the module's own finish check holds (finished, waiting for its verdict), and only for as long as it does.
          if (!checks?.held(w.module!, b.task.slice(0, 100))) throw fail(403, "forbidden", `no finish check of ${w.module} holds task ${b.task.slice(0, 100)}`);
          if (!owner) throw fail(503, "unavailable", "the control plane is off");
          const issue = await owner("GET", `/api/issues/${encodeURIComponent(b.task.slice(0, 100))}`);
          if (issue.status !== 200 || typeof issue.json.assigneeAgentId !== "string") throw fail(404, "not_found", `no task ${b.task.slice(0, 100)} with an assignee`);
          return send(res, 200, { token: graderToken(b.task.slice(0, 100), issue.json.assigneeAgentId) });
        }
        const task = new URLSearchParams(q ?? "").get("task");
        if (hit.path === "/v1/work/metrics") return void res.writeHead(200, { "content-type": "text/plain; version=0.0.4" }).end(work.metrics());
        return send(res, 200, task ? work.task(task.slice(0, 100)) : work.activity());
      }
      if (hit && hit.path.startsWith("/v1/jobs")) {
        const w = await moduleOf(req);
        if (!w.roles.includes("kernel.jobs")) throw fail(403, "forbidden", `${w.module} may not run jobs (role kernel.jobs)`);
        if (!jobs) throw fail(503, "unavailable", "jobs are off");
        try {
          switch (`${hit.method} ${hit.path}`) {
            case "POST /v1/jobs": {
              // {wake, prompt, session?}: admitted by the kernel; the runner's box-carrying request stays until C1b.
              const b = await json(req, 4_000_000);
              return send(res, 200, admission && typeof (b as { wake?: unknown })?.wake === "string" ? await admission.admit(w.module!, b as never) : await jobs.start(w.module!, b as never));
            }
            case "GET /v1/jobs/:job": {
              const p = new URLSearchParams(q ?? "");
              return send(res, 200, await jobs.get(w.module!, m[0]!, { ...(p.has("after") ? { after: Number(p.get("after")) } : {}), waitMs: Number(p.get("wait") ?? 0) || 0 }));
            }
            case "DELETE /v1/jobs/:job": return send(res, 200, jobs.stop(w.module!, m[0]!));
            case "POST /v1/jobs/:job/input": {
              const b = await json(req);
              if (typeof b.text !== "string") throw fail(400, "bad_request", "send {text}");
              const r = jobs.input(w.module!, m[0]!, b.text, typeof b.from === "string" ? b.from : "owner");
              // A claimed comment wake is delivered only once the run took it.
              if (r.sent && typeof b.wake === "string") wakes?.delivered(w.module!, b.wake);
              return send(res, 200, r);
            }
            case "POST /v1/jobs/:job/post": {
              if (!outcomes) throw fail(503, "unavailable", "outcomes are off");
              const job = await jobs.get(w.module!, m[0]!);
              const b = await json(req);
              if (!JOB_KINDS.includes(b.kind) || typeof b.body !== "string") throw fail(400, "bad_request", `send {kind: ${JOB_KINDS.join("|")}, body, status?, blocked_by?}`);
              if (b.blocked_by !== undefined && !(Array.isArray(b.blocked_by) && b.blocked_by.every((x: unknown) => typeof x === "string"))) throw fail(400, "bad_request", "blocked_by is a list of task ids");
              return send(res, 200, await outcomes.post(job, { kind: b.kind, body: b.body, ...(typeof b.status === "string" ? { status: b.status } : {}), ...(b.blocked_by ? { blockedBy: b.blocked_by } : {}) }));
            }
          }
        } catch (e) {
          const j = e as { name?: string; status?: number; code?: string; message: string };
          if (j.name === "JobError" || j.name === "OutcomeError") throw fail(j.status!, j.code!, j.message);
          throw e;
        }
      }
      if (hit && (hit.path === "/v1/checks" || hit.path === "/v1/checks/:check" || hit.path === "/v1/receipts/verify")) {
        const w = await moduleOf(req);
        if (!w.roles.includes("kernel.checks")) throw fail(403, "forbidden", `${w.module} may not run checks (role kernel.checks)`);
        if (!checkJobs) throw fail(503, "unavailable", "check jobs are off");
        try {
          if (hit.path === "/v1/checks") return send(res, 200, checkJobs.start(w.module!, await json(req)));
          if (hit.path === "/v1/receipts/verify") { const b = await json(req); return send(res, 200, checkJobs.verify(b.receipt, b.for ?? {})); }
          const p = new URLSearchParams(q ?? "");
          return send(res, 200, await checkJobs.get(w.module!, m[0]!, { ...(p.has("after") ? { after: Number(p.get("after")) } : {}), waitMs: Number(p.get("wait") ?? 0) || 0 }));
        } catch (e) {
          const c = e as { name?: string; status?: number; code?: string; message: string };
          if (c.name === "CheckError") throw fail(c.status!, c.code!, c.message);
          throw e;
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
              const r = await writes.fileRunner({ kind: String(b.kind ?? ""), task: String(b.task ?? ""), ...(typeof b.identifier === "string" ? { identifier: b.identifier.slice(0, 40) } : {}), args: b.args, plan: b.plan ?? {} });
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
            // The reviewed ones only (every Tier 0 write is a record too, and would crowd the cards out), unless `tier0=1`
            // asks for every record (the board's history shows Tier 0 runs after the fact); the runner's approved list is its
            // own kinds, and its review list says which wait out a failed review's backoff.
            const rows = records.list(list, Math.min(Number(p.get("limit")) || 100, 1000), { reviewed: p.get("tier0") !== "1", ...(task ? { task } : {}) });
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
          case "POST /v1/writes/held": {
            // What the kernel would do with a Tier 0 write on this task now: run it, or hold it for the owner (the caps).
            runner(req);
            const b = await json(req);
            return send(res, 200, { held: (await writes.held(String(b.task ?? ""))) ?? null });
          }
          case "POST /v1/writes/:id/claim": {
            runner(req);
            const r = await writes.claim(id);
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

/** The chief of staff: the agent holding the fleet-admin role in the grants table (found by role, never by key). */
export const chiefOfStaff = (agents: Record<string, Grant> | undefined) => Object.entries(agents ?? {}).find(([, g]) => (g.roles ?? []).includes("fleet-admin"))?.[0];
