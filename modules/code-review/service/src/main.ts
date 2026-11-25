// The code-review state service: its sqlite state (CODE_REVIEW_DB), the engine's tick (the change feed's events, then the kernel's answers), flow facts
// and the HTTP API on :8098. Idle until settings.code_review lists a repo or someone asks for a one-off: nothing is read or spent.
// Its module token (code_review_token) is asked for fresh, so the token the kernel writes after start is picked up.
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { factEmitter, kernelClient } from "./aidenhq-sdk/kernel-client.ts";
import { githubReview, githubSource, kernelCodeHost, kernelPoster, kernelRunner, reviewExecutor } from "./adapters.ts";
import { loadCatalog } from "./catalog.ts";
import { primerPublisher } from "./primer-client.ts";
import { serveExecutor } from "./aidenhq-sdk/executor.ts";
import { handler } from "./api.ts";
import { readConfig } from "./config.ts";
import { createEngine } from "./engine.ts";
import { deepsecStore } from "./deepsec-store.ts";
import { configTools } from "./config-tool.ts";
import { createMcp, pageHtml, serveMcp } from "./mcp.ts";
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
const engine = createEngine({
  db: new DatabaseSync(dbFile),
  // deepsec's records per repo, beside the database (never in the repo).
  deepsec: deepsecStore(join(dirname(dbFile), "deepsec")),
  config: () => config,
  source: githubSource(env.CODE_REVIEW_GITHUB_URL ?? "http://github:8086", token),
  runner: kernelRunner(kernel),
  poster: kernelPoster(kernel, log),
  codehost: kernelCodeHost(kernelUrl, token, kernel),
  // The option catalog (catalog.json beside this file), read when a repo review asks for it.
  catalog: () => loadCatalog(readFileSync(new URL("./catalog.json", import.meta.url), "utf8")),
  // Primer: the report as a primer.publish write record, a new private document per review.
  publisher: primerPublisher(kernel),
  // The github change feed's events on the watched repos (module.yaml subscribes:), with this module's token.
  feed: (after) => kernel.call("GET", `/v1/events/log?connection=github&limit=200${after === undefined ? "" : `&after=${after}`}`),
  emit: (f) => facts.emit(f),
  log,
});

// One tick every TICK_SECONDS, one at a time: the change feed's events (the kernel's log), then what the kernel answers (finished
// checks, filed posts, due runs) and the status mirror, so a review posts seconds after its check ends. No GitHub timer.
const TICK_SECONDS = 10;
let busy = false;
setInterval(async () => {
  if (busy || !token()) return;
  busy = true;
  try { await engine.tick(); } catch (e) { log("WARNING: tick failed", { err: String((e as Error).message).slice(0, 300) }); } finally { busy = false; }
}, TICK_SECONDS * 1000);

// executor@1 for code-review.post, .notice and .status: the kernel calls it with this module's service key, read fresh per request.
const github = env.CODE_REVIEW_GITHUB_URL ?? "http://github:8086";
const executor = reviewExecutor(githubReview(github, token), (id) => engine.binding(id));
const api = handler(engine, (auth, module) => isModule(kernelUrl, auth, module));
// The Reviewer Manager's tools on the module's connection (code_review): its setting as instance.yaml holds it, and its changes
// filed as the calling job (its assertion goes along).
const raw = () => { try { const v = JSON.parse(env.CODE_REVIEW_SETTINGS || "{}"); return v && typeof v === "object" && !Array.isArray(v) ? v : {}; } catch { return {}; } };
const mcp = serveMcp(createMcp("code-review", configTools({
  raw, repos: () => engine.repos(), runs: (q) => engine.runs(q), oneoff: (b, asker) => engine.oneoff(b, asker), resolve: (b) => engine.resolve(b), findings: (r, n) => engine.openFindings(r, n), repoReview: (b) => engine.repoReview(b),
  batches: (q) => engine.batches(q), detail: (id) => engine.run(id) ?? (() => { throw new Error(`no review ${id}`); })(), report: (b) => engine.report(b), catalog: (q) => engine.catalogFor(q), available: (q) => engine.available(q), dismiss: (b) => engine.dismiss(b),
  file: async (changes, assertion) => {
    const r = await kernel.raw("POST", "/v1/settings/agent", { changes }, { "x-aidenhq-caller": assertion });
    if (r.status >= 300) throw new Error(`Refused: ${String(r.json?.error?.message ?? r.json?.error ?? r.status).slice(0, 1000)}`);
    return r.json;
  },
}), [{ uri: "ui://code-review/page", html: pageHtml(new URL("./", import.meta.url)) }]), () => file(env.CODE_REVIEW_SERVICE_KEY_FILE), async (req) => ({ ...(await verifyCaller(req, jwks, "code-review")), assertion: String(req.headers["x-aidenhq-caller"] ?? "") }));
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
