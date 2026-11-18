// codehost-github's service (module.yaml services): reads its files and settings, then serves service.ts.
//   CODEHOST_KEY_FILE       the module's own token: the kernel calls the executor with it, and it reports outcomes with it
//   GITHUB_APP_DIR          the App's vault dir (app_id, key.pem); absent: every GitHub action fails, saying so
//   TASKS_DIR               the job workspaces (work/tasks); absent: push, pr and clone fail, saying so
//   OPS_GRANTS_FILE         the compiled point codehost-github.ops (config/points/codehost-github.json); absent: no grants
//   CACHE_DIR               the bare cache clones (its data dir)
//   AGENTS_ORG, INSTANCE_REPO, PRODUCT_REPO, MODULES_REPO, LANDS_PLATFORM_REPOS
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { appClient } from "./github-app.ts";
import { createService, type Grant } from "./service.ts";

const env = process.env;
const read = (f?: string) => (f && existsSync(f) ? readFileSync(f, "utf8").trim() : "");
const log = (msg: string, f: Record<string, unknown> = {}) => console.log(JSON.stringify({ svc: "codehost-github", msg, ...f }));
const key = read(env.CODEHOST_KEY_FILE);
if (!key) throw new Error("codehost-github: CODEHOST_KEY_FILE is empty");
const appDir = env.GITHUB_APP_DIR ?? "";
const app = appDir && read(join(appDir, "app_id")) && read(join(appDir, "key.pem")) ? appClient({ appId: read(join(appDir, "app_id")), key: read(join(appDir, "key.pem")), log }) : undefined;
const agentsOrg = env.AGENTS_ORG ?? "";
const gh = async (method: string, path: string, token: string, body?: unknown) => {
  const r = await fetch(`https://api.github.com${path}`, {
    method, signal: AbortSignal.timeout(20_000),
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

const handle = createService({
  key, kernelUrl: env.AIDENHQ_KERNEL_URL ?? "http://10.231.0.1:3130", cacheDir: env.CACHE_DIR ?? "/cache", tasksDir: env.TASKS_DIR || undefined,
  app, gh, agentsOrg, instanceRepo: env.INSTANCE_REPO || undefined,
  productRepo: env.PRODUCT_REPO || undefined, modulesRepo: env.MODULES_REPO || undefined,
  landsPlatformRepos: env.LANDS_PLATFORM_REPOS === "true",
  grants: () => (read(env.OPS_GRANTS_FILE) ? ((JSON.parse(read(env.OPS_GRANTS_FILE)).ops ?? []) as Grant[]) : []),
  log,
});
log("starting", { app: Boolean(app), tasks: Boolean(env.TASKS_DIR), agentsOrg });
const server = createServer((req, res) => void handle(req, res));
server.listen(Number(env.PORT ?? 8100), "0.0.0.0");
for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => server.close(() => process.exit(0)));
