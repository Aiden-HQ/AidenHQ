// The ship service: its state (SHIP_STATE_FILE), the watch loop (loop.ts) and the contributor-PR pass (contributor.ts), the HTTP
// API and the MCP connection `ship` on :8101.
//   GET /v1/generation?repo&pr   (the github module's token) -> { generation, hold, task? }: a PR's adoption, for github's write
//                                checks. `generation` null when it isn't adopted; `hold` non-null when it is held, its repo is off
//                                or ship is paused (github then writes nothing for it).
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { kernelClient } from "./aidenhq-sdk/kernel-client.ts";
import { kernelJwks, verifyCaller } from "./aidenhq-sdk/caller.ts";
import { parseRepos } from "./aidenhq-sdk/maintained-repos.ts";
import { configTools } from "./config-tool.ts";
import { contributorPrs, contributorPrWake, prTick } from "./contributor.ts";
import { startLoop, type Flow } from "./loop.ts";
import { createMcp, serveMcp } from "./mcp.ts";
import { effective, scopeFrom } from "./settings.ts";
import { openState } from "./state.ts";

const env = process.env;
const file = (p: string | undefined) => { try { return p ? readFileSync(p, "utf8").trim() : ""; } catch { return ""; } };
const log = (msg: string, f?: Record<string, unknown>) => console.log(new Date().toISOString(), msg, JSON.stringify(f ?? {}));
const kernelUrl = env.AIDENHQ_KERNEL_URL ?? "http://10.231.0.1:3130";
const token = () => file(env.SHIP_TOKEN_FILE);
const kernel = new Proxy({} as ReturnType<typeof kernelClient>, { get: (_, k) => (kernelClient(kernelUrl, token()) as Record<string | symbol, unknown>)[k] });

const json = (v: string | undefined) => { try { return JSON.parse(v || "null"); } catch { return null; } };
const raw = () => { const v = json(env.SHIP_SETTINGS); return v && typeof v === "object" && !Array.isArray(v) ? v : {}; };
const scope = () => scopeFrom(env);
const paused = () => raw().paused === true;
/** The repo's settings when ship works it (on, in scope), else null. */
const settingsOf = (repo: string) => { const s = effective(raw(), repo, scope()); return s?.enabled ? s : null; };

const stateFile = env.SHIP_STATE_FILE ?? "/data/state.json";
const state = openState(stateFile);
const jwks = kernelJwks(`${kernelUrl}/v1/jwks`);
const mcp = serveMcp(createMcp(configTools({
  raw, scope, state,
  file: async (changes, assertion) => {
    const r = await kernel.raw("POST", "/v1/settings/agent", { changes }, { "x-aidenhq-caller": assertion });
    if (r.status >= 300) throw new Error(`Refused: ${String(r.json?.error?.message ?? r.json?.error ?? r.status).slice(0, 1000)}`);
    return r.json;
  },
})), () => file(env.SHIP_SERVICE_KEY_FILE), async (req) => ({ ...(await verifyCaller(req, jwks, "ship")), assertion: String(req.headers["x-aidenhq-caller"] ?? "") }));

/** Whether a bearer is the named module's own token, asked of the kernel (undefined: the kernel couldn't say now). */
async function isModule(authorization: string, module: string): Promise<boolean | undefined> {
  const bearer = authorization.replace(/^Bearer\s+/i, "").trim();
  if (!bearer) return false;
  try {
    const r = await fetch(new URL("/v1/whoami", kernelUrl), { headers: { authorization: `Bearer ${bearer}` }, signal: AbortSignal.timeout(5_000) });
    if (!r.ok) return r.status === 401 || r.status === 403 ? false : undefined;
    const who = (await r.json()) as { kind?: string; module?: string };
    return who.kind === "module" && who.module === module;
  } catch { return undefined; }
}

// github's routes for ship (github service/src/ship-routes.ts), with this module's token.
const githubUrl = (env.SHIP_GITHUB_URL ?? "http://github:8100").replace(/\/+$/, "");
async function github(method: "GET" | "POST", op: string, body?: unknown, timeoutMs = 60_000): Promise<any> {
  const r = await fetch(`${githubUrl}/internal/ship/${op}`, { method, headers: { authorization: `Bearer ${token()}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(timeoutMs) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`github /internal/ship/${op}: ${r.status} ${String(j?.error ?? "").slice(0, 200)}`);
  return j;
}
const gh = async (method: string, path: string, body?: unknown, o?: { deadline?: number }) => {
  const r = await github("POST", "gh", { method, path, body, deadline: o?.deadline });
  // A refusal the client threw there (a typed need: rate_limited, unreachable, scope) is thrown here the same way.
  if (r.thrown) throw Object.assign(new Error(String(r.thrown.message)), { cause: r.thrown.cause });
  return r as { status: number; body: any };
};
const fact = (fn: string) => (...args: unknown[]) => void github("POST", "flow", { fn, args }).catch((e) => log("flow fact not sent", { fn, err: String(e.message).slice(0, 200) }));
const flow: Flow = {
  opened: fact("opened"), pushed: fact("pushed"), merged: fact("merged"), closed: fact("closed"), checksStarted: fact("checksStarted"), checksCompleted: fact("checksCompleted"),
  authored: async (...args) => (await github("POST", "flow", { fn: "authored", args })).value ?? {},
};

// The repos the loop watches: the product repo and every maintained repo ship works (all duties), and the other maintained repos
// with Dependabot on (that duty only).
const maintained = (() => { try { return parseRepos(env.SHIP_MAINTAINER_REPOS ?? ""); } catch (e) { log("maintainer_repos unreadable: only the product repo is watched", { err: String((e as Error).message).slice(0, 200) }); return []; } })();
const repos = new Map<string, "all" | "dependabot">();
if (env.SHIP_PRODUCT_REPO && settingsOf(env.SHIP_PRODUCT_REPO)) repos.set(env.SHIP_PRODUCT_REPO, "all");
for (const m of maintained) {
  if (repos.has(m.repo)) continue;
  if (settingsOf(m.repo)) repos.set(m.repo, "all");
  else if (m.dependabot) repos.set(m.repo, "dependabot");
}
const dataDir = dirname(stateFile);
startLoop({
  repos: [...repos].map(([repo, duties]) => ({ repo, duties })), kernelUrl, get key() { return token(); }, cacheDir: dataDir, gh, log, flow, state, paused,
  settings: settingsOf,
  openers: () => github("GET", "openers"),
  decide: (data, head) => github("POST", "decide", { data, head }),
  reviewGate: async (repo, number, head) => (await github("POST", "verdict", { repo, number, head }, 20_000)) ?? undefined,
});
log("ship watch loop", { repos: [...repos].map(([r, d]) => `${r}:${d}`) });

// The contributor_prs pass (contributor.ts): its one state value in data/contributor-prs.json, checked every five minutes (at most
// hourly reads).
const prFile = join(dataDir, "contributor-prs.json");
const prStore = {
  meta: (k: string) => (json((() => { try { return readFileSync(prFile, "utf8"); } catch { return "{}"; } })()) ?? {})[k],
  setMeta(k: string, v: string) { mkdirSync(dataDir, { recursive: true }); writeFileSync(`${prFile}.tmp`, JSON.stringify({ [k]: v })); renameSync(`${prFile}.tmp`, prFile); },
};
const prLog = { info: (o: object, m: string) => log(m, o as Record<string, unknown>), warn: (o: object, m: string) => log(m, o as Record<string, unknown>) };
const prs = contributorPrs({ url: env.SHIP_CONTRIBUTOR_PRS_URL ?? "http://github:8086/internal/ship/contributor-prs", token });
const firePr = contributorPrWake(async (t) => (await kernel.raw("POST", "/v1/tasks", t)).status < 300);
setInterval(() => { if (!paused() && token()) void prTick({ prs, firePr, store: prStore, log: prLog }).catch((e) => log("contributor PR pass failed", { err: String(e) })); }, 5 * 60_000).unref();

createServer(async (req, res) => {
  if (await mcp(req, res)) return;
  const url = new URL(req.url ?? "/", "http://x");
  if (req.method === "GET" && url.pathname === "/v1/generation") {
    const ok = await isModule(String(req.headers.authorization ?? ""), "github");
    if (!ok) return void res.writeHead(ok === undefined ? 503 : 401).end();
    const repo = String(url.searchParams.get("repo") ?? ""), n = Number(url.searchParams.get("pr"));
    const a = Number.isInteger(n) && n > 0 ? state.get(repo, n) : undefined;
    const hold = paused() ? { reason: "paused" } : !settingsOf(repo) ? { reason: "off" } : a?.hold ?? null;
    return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ generation: a?.generation ?? null, hold, ...(a?.task ? { task: a.task } : {}) }));
  }
  res.writeHead(url.pathname === "/healthz" ? 200 : 404).end();
}).listen(8101, "0.0.0.0", () => log("ship listening", { port: 8101 }));
