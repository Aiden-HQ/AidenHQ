// The code-review state service: its sqlite state (CODE_REVIEW_DB), the engine's tick every CODE_REVIEW_POLL_SECONDS, flow facts
// and the HTTP API on :8098. Idle until settings.code_review lists a repo or someone asks for a one-off: nothing is read or spent.
// Its module token (code_review_token) is asked for fresh, so the token the kernel writes after start is picked up.
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { factEmitter, kernelClient } from "./aidenhq-sdk/kernel-client.ts";
import { githubReview, githubSource, shipAdmission, kernelCodeHost, kernelPoster, kernelRunner, reviewExecutor } from "./adapters.ts";
import { loadCatalog } from "./catalog.ts";
import { primerPublisher } from "./primer-client.ts";
import { serveExecutor } from "./aidenhq-sdk/executor.ts";
import { handler } from "./api.ts";
import { readConfig } from "./config.ts";
import { createEngine } from "./engine.ts";
import { deepsecStore } from "./deepsec-store.ts";
import { configTools } from "./config-tool.ts";
import { createMcp, serveMcp } from "./mcp.ts";
import { isModule } from "./module-caller.ts";
import { kernelJwks, verifyCaller } from "./aidenhq-sdk/caller.ts";

const env = process.env;
const file = (p: string | undefined) => { try { return p ? readFileSync(p, "utf8").trim() : ""; } catch { return ""; } };
const token = () => file(env.CODE_REVIEW_TOKEN_FILE);
const log = (msg: string, f?: Record<string, unknown>) => console.log(new Date().toISOString(), msg, JSON.stringify(f ?? {}));
const kernelUrl = env.AIDENHQ_KERNEL_URL ?? "http://10.231.0.1:3130";
// One client per call, so a token written after start is used at once.
const kernel = new Proxy({} as ReturnType<typeof kernelClient>, { get: (_, k) => (kernelClient(kernelUrl, token()) as Record<string | symbol, unknown>)[k] });

const config = readConfig(env.CODE_REVIEW_SETTINGS);
for (const e of config.errors) log("WARNING: settings.code_review", { error: e });
const facts = factEmitter(kernel, log);
const dbFile = env.CODE_REVIEW_DB ?? "/data/code-review.sqlite";
const source = githubSource(env.CODE_REVIEW_GITHUB_URL ?? "http://github:8086", token);
const engine = createEngine({
  db: new DatabaseSync(dbFile),
  // deepsec's records per repo, beside the database (never in the repo).
  deepsec: deepsecStore(join(dirname(dbFile), "deepsec")),
  config: () => config,
  source,
  // Ship, when installed, admits a PR before anything is spent on it (an outside contributor's waits for a trusted hand-off).
  admit: shipAdmission(env.CODE_REVIEW_SHIP_URL ?? "http://ship:8101", token, async (repo, author) => ["admin", "maintain", "write"].includes(await source.permission(repo, author)), log),
  runner: kernelRunner(kernel),
  poster: kernelPoster(kernel, log),
  codehost: kernelCodeHost(kernelUrl, token, kernel),
  // The option catalog (catalog.json beside this file), read when a repo review asks for it.
  catalog: () => loadCatalog(readFileSync(new URL("./catalog.json", import.meta.url), "utf8")),
  // Primer: the report as a primer.publish write record, a new private document per review.
  publisher: primerPublisher(kernel),
  emit: (f) => facts.emit(f),
  log,
});

// Two cadences, one at a time: GitHub is read every CODE_REVIEW_POLL_SECONDS; finished checks, filed posts, due runs and the
// status mirror move every FAST_SECONDS (the kernel's answers only), so a review posts seconds after its check ends.
const FAST_SECONDS = 10;
// A GitHub read asked for while a tick runs runs right after it, never skipped.
let busy = false, wantGithub = false;
const tick = async (github: boolean) => {
  wantGithub ||= github;
  if (busy || !token()) return;
  busy = true;
  try {
    do {
      const g = wantGithub;
      wantGithub = false;
      try { await engine.tick({ github: g }); } catch (e) { log("WARNING: tick failed", { err: String((e as Error).message).slice(0, 300) }); }
    } while (wantGithub);
  } finally { busy = false; }
};
setInterval(() => void tick(true), Math.max(15, Number(env.CODE_REVIEW_POLL_SECONDS) || 60) * 1000);
setInterval(() => void tick(false), FAST_SECONDS * 1000);
setTimeout(() => void tick(true), 5_000);

// executor@1 for code-review.post, .notice and .status: the kernel calls it with this module's service key, read fresh per request.
const github = env.CODE_REVIEW_GITHUB_URL ?? "http://github:8086";
const executor = reviewExecutor(githubReview(github, token), (id) => engine.binding(id));
// A POST /reviews that carries the kernel's signed caller (the Reviewer Manager's tool, through the MCP connection below) says
// whose task hears the batch's summary; the board's own calls send no assertion and the owner hears it instead. Never a body field.
const api = handler(engine, () => file(env.CODE_REVIEW_API_TOKEN_FILE), (auth) => isModule(kernelUrl, auth, "github"), async (req) => {
  if (!req.headers["x-aidenhq-caller"]) return undefined;
  try {
    const c = await verifyCaller(req, jwks, "code-review");
    return { requester: c.name || c.agent || "an agent", ...(c.task && /^[A-Za-z0-9_-]{1,100}$/.test(c.task) ? { task: c.task } : {}) };
  } catch (e) {
    log("reviews: a caller assertion the service can't verify; the batch's summary goes to the owner", { err: String((e as Error).message).slice(0, 200) });
    return undefined;
  }
});
// The Reviewer Manager's tools on the module's connection (code_review): its setting as instance.yaml holds it, and its changes
// filed as the calling job (its assertion goes along).
const raw = () => { try { const v = JSON.parse(env.CODE_REVIEW_SETTINGS || "{}"); return v && typeof v === "object" && !Array.isArray(v) ? v : {}; } catch { return {}; } };
const mcp = serveMcp(createMcp(configTools({
  raw, repos: () => engine.repos(), runs: (q) => engine.runs(q), oneoff: (b, asker) => engine.oneoff(b, asker), resolve: (b) => engine.resolve(b), findings: (r, n) => engine.openFindings(r, n), repoReview: (b) => engine.repoReview(b),
  file: async (changes, assertion) => {
    const r = await kernel.raw("POST", "/v1/settings/agent", { changes }, { "x-aidenhq-caller": assertion });
    if (r.status >= 300) throw new Error(`Refused: ${String(r.json?.error?.message ?? r.json?.error ?? r.status).slice(0, 1000)}`);
    return r.json;
  },
})), () => file(env.CODE_REVIEW_SERVICE_KEY_FILE), async (req) => ({ ...(await verifyCaller(req, jwks, "code-review")), assertion: String(req.headers["x-aidenhq-caller"] ?? "") }));
const jwks = kernelJwks(`${kernelUrl}/v1/jwks`);
// One executor handler (its once-per-id map must live across requests), made anew only when the service key changes.
let serving: { key: string; handle: ReturnType<typeof serveExecutor> } | undefined;
createServer(async (req, res) => {
  const key = file(env.CODE_REVIEW_SERVICE_KEY_FILE);
  if (serving?.key !== key) serving = { key, handle: serveExecutor(executor, { key, kernelUrl, log }) };
  if (await serving.handle(req, res)) return;
  if (await mcp(req, res)) return;
  await api(req, res);
}).listen(8098, "0.0.0.0", () => log("code-review listening", { port: 8098, repos: config.repos.length }));
for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => void facts.flush().finally(() => process.exit(0)));
