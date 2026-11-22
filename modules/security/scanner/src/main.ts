// security-scanner: the src_security writer (src/scan.ts) and the optional App Auditor pass (src/auditor.ts). No inbound
// port, no MCP: it wakes hourly and runs a pass when the last one is a day old or the host wrote a newer SBOM batch.
//   node dist/src/main.js          the service
//   node dist/src/main.js once     one pass now (on demand: docker compose exec security-scanner node dist/src/main.js once)
// After a pass that wrote anything, it fires the Security Watch routine's signed webhook (coalesced by Paperclip).
import { execFile } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import YAML from "yaml";
import { auditorClient, auditorPass } from "./auditor.js";
import { DDL, parseTargets, scanPass, type Batch } from "./scan.js";
import { SourceStore } from "./source-store.js";
import { zerowirePass } from "./zerowire.js";

const run = promisify(execFile);
const env = (k: string, d = "") => process.env[k] || d;
const file = (k: string) => {
  try {
    return readFileSync(env(k), "utf8").trim();
  } catch {
    return "";
  }
};
const log = (msg: string, extra: Record<string, unknown> = {}) => console.log(JSON.stringify({ t: new Date().toISOString(), msg, ...extra }));

const SBOM = join(env("SBOM_DIR", "/sbom"), "current");
const GRYPE_ENV = { ...process.env, GRYPE_DB_AUTO_UPDATE: "false", GRYPE_CHECK_FOR_APP_UPDATE: "false" };
// The cache is a bind-mounted module data folder, so the image's own folders under it are hidden: create them here.
for (const k of ["GRYPE_DB_CACHE_DIR", "TMPDIR"]) if (process.env[k]) mkdirSync(process.env[k]!, { recursive: true });

async function readBatch(): Promise<Batch> {
  const index = join(SBOM, "targets.tsv");
  let text: string;
  try {
    text = readFileSync(index, "utf8");
  } catch {
    return { finishedAt: null, targets: [] };
  }
  return { finishedAt: statSync(index).mtime, targets: parseTargets(text, SBOM) };
}

async function grype(sbomFile: string): Promise<unknown> {
  const { stdout } = await run("grype", [`sbom:${sbomFile}`, "-o", "json", "-q"], { env: GRYPE_ENV, timeout: 45 * 60_000, maxBuffer: 512 * 1024 * 1024 });
  return JSON.parse(stdout);
}

/** Apps in the instance's registry (apps.yaml) with their GitHub repo. */
/** Only the instance's own agents-org repos go to the auditor: its token can read every team's reports. */
const agentsOrgRepo = (r: string) =>
  /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(r) && r.split("/")[0]!.toLowerCase() === env("AGENTS_ORG", "").toLowerCase();

function registryApps(): { name: string; repo: string }[] {
  const out = new Map<string, string>();
  for (const f of env("APPS_REGISTRY_FILES").split(",").filter(Boolean)) {
    try {
      for (const a of (YAML.parse(readFileSync(f, "utf8"))?.apps ?? []) as { name?: string; repo?: string }[]) if (a?.name && a.repo && agentsOrgRepo(a.repo)) out.set(a.name, a.repo);
    } catch {
      // a missing registry file just lists nothing
    }
  }
  return [...out].map(([name, repo]) => ({ name, repo }));
}

async function poke(): Promise<void> {
  const url = file("SCAN_WEBHOOK_URL_FILE");
  const secret = file("SCAN_WEBHOOK_SECRET_FILE");
  if (!url || !secret) return;
  const ts = String(Math.floor(Date.now() / 1000));
  const body = '{"event":"security_scan_done"}';
  const sig = createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");
  try {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-paperclip-timestamp": ts, "x-paperclip-signature": `sha256=${sig}` }, body, signal: AbortSignal.timeout(15_000) });
    if (![202, 409].includes(res.status)) log("scan webhook failed", { status: res.status });
  } catch (err) {
    log("scan webhook failed", { err: String(err) });
  }
}

async function pass(store: SourceStore): Promise<void> {
  const started = new Date();
  let written = await store.run("security", "pass", () =>
    scanPass(store, {
      dbUpdate: async () => void (await run("grype", ["db", "update"], { env: GRYPE_ENV, timeout: 20 * 60_000, maxBuffer: 16 * 1024 * 1024 })),
      readBatch,
      grype,
      log,
    }),
  );
  const clientId = file("AUDITOR_CF_ID_FILE");
  const clientSecret = file("AUDITOR_CF_SECRET_FILE");
  const auditorUrl = env("AUDITOR_URL", "");
  if (auditorUrl && clientId && clientSecret) {
    // Its own ingest_run rows; an auditor outage never fails the CVE pass.
    written += await auditorPass(store, auditorClient({ url: auditorUrl, clientId, clientSecret }), registryApps()).catch((err) => {
      log("app auditor pass failed", { err: String(err) });
      return 0;
    });
  }
  // Its own ingest_run row (scope zerowire); a feed outage never fails the CVE pass.
  await zerowirePass(store).catch((err) => log("zero wire pass failed", { err: String(err) }));
  await store.saveScope("pass", started.toISOString(), true);
  log("pass done", { written });
  if (written > 0) await poke();
}

async function due(store: SourceStore): Promise<boolean> {
  const last = Date.parse((await store.scope("pass")).cursor ?? "") || 0;
  if (Date.now() - last > 23 * 3_600_000) return true;
  try {
    return statSync(join(SBOM, "targets.tsv")).mtimeMs > last; // the host just wrote a new batch
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const once = process.argv[2] === "once";
  for (;;) {
    const store = SourceStore.fromEnv("security");
    if (!store) log("no warehouse password yet (warehouse module or warehouse_src_security_password missing); idle");
    if (!store && once) process.exitCode = 1;
    if (store) {
      try {
        await store.migrate(DDL); // due() reads src_security.scope, which the first migrate creates
        if (once || (await due(store))) await pass(store);
      } catch (err) {
        log("pass failed", { err: String((err as Error).message ?? err).slice(0, 500) });
        if (once) process.exitCode = 1;
      } finally {
        await store.pool.end().catch(() => undefined);
      }
    }
    if (once) return;
    await new Promise((r) => setTimeout(r, 3_600_000));
  }
}

void main();
