// The ship service: its state (SHIP_STATE_FILE), the watch loop (loop.ts: every PR through one engine, adopted.ts and rounds.ts,
// after its CI recoveries, ci-recover.ts), the contributor-PR pass (contributor.ts), the HTTP API and the MCP connection `ship` on :8101.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { kernelClient } from "./aidenhq-sdk/kernel-client.ts";
import { kernelJwks, verifyCaller } from "./aidenhq-sdk/caller.ts";
import { parseRepos } from "./aidenhq-sdk/maintained-repos.ts";
import { adoptedPass } from "./adopted.ts";
import { ciRecover } from "./ci-recover.ts";
import { configTools } from "./config-tool.ts";
import { contributorPrs, contributorPrWake, prTick } from "./contributor.ts";
import { shipEffects } from "./effects.ts";
import { effectRefusal } from "./safe.ts";
import { startLoop, type Flow } from "./loop.ts";
import { createMcp, pageHtml, serveMcp } from "./mcp.ts";
import { effective, scopeFrom } from "./settings.ts";
import { openState } from "./state.ts";
import { generationOf } from "./handoff.ts";
import { isModule } from "./module-caller.ts";

const env = process.env;
const file = (p: string | undefined) => { try { return p ? readFileSync(p, "utf8").trim() : ""; } catch { return ""; } };
const log = (msg: string, f?: Record<string, unknown>) => console.log(new Date().toISOString(), msg, JSON.stringify(f ?? {}));
const kernelUrl = env.AIDENHQ_KERNEL_URL ?? "http://10.231.0.1:3130";
const token = () => file(env.SHIP_TOKEN_FILE);
const kernel = new Proxy({} as ReturnType<typeof kernelClient>, { get: (_, k) => (kernelClient(kernelUrl, token()) as Record<string | symbol, unknown>)[k] });

const json = (v: string | undefined) => { try { return JSON.parse(v || "null"); } catch { return null; } };
// The ship setting with the kill switch (its own setting, ship_paused, so a repo proposal never carries it) folded in.
const raw = () => { const v = json(env.SHIP_SETTINGS); return { ...(v && typeof v === "object" && !Array.isArray(v) ? v : {}), paused: env.SHIP_PAUSED === "true" }; };
const scope = () => scopeFrom(env);
const maintainerRepos = (): unknown[] => { const t = String(env.SHIP_MAINTAINER_REPOS ?? "").trim(); const v = t.startsWith("[") ? json(t) : t.split(",").map((x) => x.trim()).filter(Boolean); return Array.isArray(v) ? v : []; };
const paused = () => raw().paused === true;
/** The repo's settings when ship works it (on, in scope), else null. */
const settingsOf = (repo: string) => { const s = effective(raw(), repo, scope()); return s?.enabled ? s : null; };
const codeReview = () => { const v = json(env.SHIP_CODE_REVIEW); return v && typeof v === "object" && !Array.isArray(v) ? v : {}; };

const stateFile = env.SHIP_STATE_FILE ?? "/data/state.json";
const state = openState(stateFile);
const jwks = kernelJwks(`${kernelUrl}/v1/jwks`);
const mcp = serveMcp(createMcp("ship", configTools({
  raw, scope, state, maintainerRepos, codeReview,
  file: async (changes, assertion) => {
    const r = await kernel.raw("POST", "/v1/settings/agent", { changes }, { "x-aidenhq-caller": assertion });
    if (r.status >= 300) throw new Error(`Refused: ${String(r.json?.error?.message ?? r.json?.error ?? r.status).slice(0, 1000)}`);
    return r.json;
  },
}), [{ uri: "ui://ship/page", html: pageHtml(new URL("./", import.meta.url)) }]), () => file(env.SHIP_SERVICE_KEY_FILE), async (req) => ({ ...(await verifyCaller(req, jwks, "ship")), assertion: String(req.headers["x-aidenhq-caller"] ?? "") }));

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
const effects = shipEffects(kernel, { codeReview: "http://code-review:8098", key: token });
const dataDir = dirname(stateFile);
startLoop({
  repos: [...repos].map(([repo, duties]) => ({ repo, duties })), kernelUrl, get key() { return token(); }, cacheDir: dataDir, gh, log, flow, paused,
  openers: () => github("GET", "openers"),
  recover: ciRecover({ gh, log }),
  // Every PR but Dependabot's: the hand-off (or a task's own PR) and its rounds (handoff.ts, rounds.ts), on GitHub through the same routes.
  adopted: adoptedPass({
    gh, state, settings: settingsOf, paused, kernel, log,
    // The list read's node and default branch go along, so github reads neither again.
    decision: (repo, number, head, view) => github("POST", "decision", { repo, number, head, pr: view.pr, main: view.main, ...(view.stackedOn ? { stackedOn: view.stackedOn } : {}) }),
    effects,
  }),
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
  // github's check before each adopted-PR write: the adoption's generation, hold and task, to the github module's token only. A
  // repo switched off reads as paused, so a write already in flight for it (a ship-filed merge too: merges.ts) is refused.
  if (req.method === "GET" && req.url?.startsWith("/v1/generation?")) {
    const ok = await isModule(kernelUrl, String(req.headers.authorization ?? ""), "github");
    if (!ok) return void res.writeHead(ok === undefined ? 503 : 401).end();
    const q = new URL(req.url, "http://x").searchParams;
    const repo = q.get("repo") ?? "", n = Number(q.get("pr")), what = q.get("do");
    let gen = generationOf(state, paused() || !settingsOf(repo), repo, n);
    // The final tier check before an approve, a merge or an enqueue (risk tiers §7), with github's live head, base and author: this
    // adoption's tier says whether the write may go; a verdict that can't be read, or a head not classified, is a no.
    let refused: { why: string; retry: boolean } | undefined;
    const s = settingsOf(repo);
    if ((what === "approve" || what === "merge") && s && gen.generation !== null && !gen.hold) {
      try {
        const v = await effects.verdict(repo, n, q.get("head") ?? "", { base: q.get("base") ?? undefined, association: q.get("association") ?? undefined });
        refused = effectRefusal(s, v, what, (state.get(repo, n) as { approve?: { head: string; why?: string; policy?: string } } | undefined)?.approve, q.get("head") ?? "", q.get("policy") ?? undefined);
      } catch (e) { refused = { why: `code review's verdict couldn't be read (${String((e as Error).message).slice(0, 150)})`, retry: true }; }
      // The adoption is read again after the verdict: a hand-back, a stop or a re-adoption meanwhile ends the write.
      gen = generationOf(state, paused() || !settingsOf(repo), repo, n);
    }
    return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ...gen, ...(refused ? { refused: refused.why, ...(refused.retry ? { retry: true } : {}) } : {}) }));
  }
  res.writeHead(req.url === "/healthz" ? 200 : 404).end();
}).listen(8101, "0.0.0.0", () => log("ship listening", { port: 8101 }));
