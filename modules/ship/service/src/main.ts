// The ship service: its state (SHIP_STATE_FILE), the watch loop (loop.ts, driven by the github change feed: every PR through one engine, adopted.ts and rounds.ts,
// after its CI recoveries, ci-recover.ts), the contributor-PR pass (contributor.ts), the HTTP API and the MCP connection `ship` on :8101.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { kernelClient } from "./aidenhq-sdk/kernel-client.ts";
import { kernelJwks, verifyCaller } from "./aidenhq-sdk/caller.ts";
import { adoptedPass, ended } from "./adopted.ts";
import type { Kept } from "./handoff.ts";
import { ciRecover } from "./ci-recover.ts";
import { configTools } from "./config-tool.ts";
import { contributorPrAct, contributorPrs, prTick } from "./contributor.ts";
import { withFooter } from "./aidenhq-sdk/attribution.ts";
import { shipEffects } from "./effects.ts";
import { effectRefusal } from "./safe.ts";
import { followFeed, startLoop, watchSet } from "./loop.ts";
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
const paused = () => raw().paused === true;
/** The repo's settings when ship works it (on, in scope), else null. */
const settingsOf = (repo: string) => { const s = effective(raw(), repo, scope()); return s?.enabled ? s : null; };

const stateFile = env.SHIP_STATE_FILE ?? "/data/state.json";
const state = openState(stateFile);
const jwks = kernelJwks(`${kernelUrl}/v1/jwks`);
const mcp = serveMcp(createMcp("ship", configTools({
  raw, scope, state,
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
const gh = async (method: string, path: string, body?: unknown, o?: { deadline?: number; covers?: string[] }) => {
  const r = await github("POST", "gh", { method, path, body, deadline: o?.deadline, ...(o?.covers ? { covers: o.covers } : {}) });
  // A refusal the client threw there (a typed need: rate_limited, unreachable, scope) is thrown here the same way.
  if (r.thrown) throw Object.assign(new Error(String(r.thrown.message)), { cause: r.thrown.cause });
  return r as { status: number; body: any };
};

const dataDir = dirname(stateFile);
// The repos the loop watches, from Ship's own entries (loop.ts watchSet): no other module's list is read.
const repos = watchSet({
  repos: [...(env.SHIP_PRODUCT_REPO ? [env.SHIP_PRODUCT_REPO] : []), ...Object.keys((raw().repos as Record<string, unknown>) ?? {})],
  settings: (repo) => effective(raw(), repo, scope()),
  // Whether the loop still tracks a Dependabot task it filed on this repo (its loop.json).
  tracked: (repo) => { try { return Object.keys(JSON.parse(readFileSync(join(dataDir, "loop.json"), "utf8"))[repo.toLowerCase()]?.dependabot ?? {}).length > 0; } catch { return false; } },
});
const effects = shipEffects(kernel, { codeReview: "http://code-review:8098", key: token });
const loop = startLoop({
  repos: [...repos].map(([repo, v]) => ({ repo, ...v })), kernelUrl, get key() { return token(); }, cacheDir: dataDir, gh, log, paused,
  // An open PR's adoption that isn't held (a cancelled task's kept PR too: its task may resume) or whose report is still to post, or a
  // closed one gone() hasn't ended or settled (a task close the kernel refused is retried until it lands).
  busy: (repo, open) => (state.all() as Kept[]).some((a) => a.repo.toLowerCase() === repo.toLowerCase() && (open.has(a.number) ? !a.hold || !!a.reportStale || !!a.closing?.length : !ended(a) || !!a.closing?.length || !a.tasksClosed)),
  openers: () => github("GET", "openers"),
  recover: ciRecover({ gh, log }),
  // Every PR but Dependabot's: the hand-off (or a task's own PR) and its rounds (handoff.ts, rounds.ts), on GitHub through the same routes.
  adopted: adoptedPass({
    gh, state, settings: settingsOf, paused, kernel, log,
    // The list read's node and default branch go along, so github reads neither again.
    decision: (repo, number, head, view) => github("POST", "decision", { repo, number, head, pr: view.pr, main: view.main, ...(view.stackedOn ? { stackedOn: view.stackedOn } : {}), ...(view.comments ? { comments: view.comments } : {}) }),
    effects,
  }),
});
// What changed on GitHub: the change feed's events (module.yaml subscribes:), with this module's token. No GitHub timer.
followFeed(loop, { feed: (after) => kernel.call("GET", `/v1/events/log?connection=github&limit=200${after === undefined ? "" : `&after=${after}`}`), paused: () => paused() || !token(), log });
log("ship watch loop", { repos: [...repos].map(([r, v]) => `${r}:${v.duties}:${v.dependabot}`) });

// The quiet-PR pass (contributor.ts): its one state value in data/contributor-prs.json, checked every five minutes (at most
// hourly reads).
const prFile = join(dataDir, "contributor-prs.json");
const prStore = {
  meta: (k: string) => (json((() => { try { return readFileSync(prFile, "utf8"); } catch { return "{}"; } })()) ?? {})[k],
  setMeta(k: string, v: string) { mkdirSync(dataDir, { recursive: true }); writeFileSync(`${prFile}.tmp`, JSON.stringify({ [k]: v })); renameSync(`${prFile}.tmp`, prFile); },
};
const prLog = { info: (o: object, m: string) => log(m, o as Record<string, unknown>), warn: (o: object, m: string) => log(m, o as Record<string, unknown>) };
const prs = contributorPrs({
  url: env.SHIP_CONTRIBUTOR_PRS_URL ?? "http://github:8086/internal/ship/contributor-prs", token,
  repos: () => [...new Set([...(env.SHIP_PRODUCT_REPO ? [env.SHIP_PRODUCT_REPO] : []), ...Object.keys((raw().repos as Record<string, unknown>) ?? {})])].flatMap((repo) => { const d = effective(raw(), repo, scope())?.quiet_pr_days; return d ? [{ repo, quiet_pr_days: d }] : []; }),
});
const firePr = contributorPrAct({
  comment: async (repo, n, text) => (await gh("POST", `/repos/${repo}/issues/${n}/comments`, { body: withFooter(text, "Ship") })).status < 300,
  close: async (repo, n) => (await gh("PATCH", `/repos/${repo}/pulls/${n}`, { state: "closed" })).status < 300,
});
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
    let gen = generationOf(state, paused() || !settingsOf(repo), repo, n, q.get("at") ?? undefined);
    // The final tier check before an approve, a merge or an enqueue (docs/design/code-review.md, Risk tiers), with github's live head, base and author: this
    // adoption's tier says whether the write may go; a verdict that can't be read, or a head not classified, is a no.
    let refused: { why: string; retry: boolean } | undefined;
    const s = settingsOf(repo);
    if ((what === "approve" || what === "merge") && s && gen.generation !== null && !gen.hold) {
      try {
        const v = await effects.verdict(repo, n, q.get("head") ?? "", { base: q.get("base") ?? undefined, association: q.get("association") ?? undefined });
        refused = effectRefusal(s, v, what, (state.get(repo, n) as { approve?: { head: string; why?: string; policy?: string } } | undefined)?.approve, q.get("head") ?? "", q.get("policy") ?? undefined);
      } catch (e) { refused = { why: `code review's verdict couldn't be read (${String((e as Error).message).slice(0, 150)})`, retry: true }; }
      // The adoption is read again after the verdict: a hand-back, a stop or a re-adoption meanwhile ends the write.
      gen = generationOf(state, paused() || !settingsOf(repo), repo, n, q.get("at") ?? undefined);
    }
    // Members' comments are read again by github right before an approve, an enqueue or a merge goes on.
    const comments = (what === "approve" || what === "merge") && s?.fix.includes("review") && gen.generation !== null && !gen.hold ? (state.get(repo, n) as Kept | undefined)?.commentsFor : undefined;
    return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ...gen, ...(comments ? { comments } : {}), ...(refused ? { refused: refused.why, ...(refused.retry ? { retry: true } : {}) } : {}) }));
  }
  res.writeHead(req.url === "/healthz" ? 200 : 404).end();
}).listen(8101, "0.0.0.0", () => log("ship listening", { port: 8101 }));
