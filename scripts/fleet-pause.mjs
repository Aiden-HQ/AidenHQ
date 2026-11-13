#!/usr/bin/env node
// Drain the fleet before host maintenance or a move to another host, and bring it back afterwards.
//   node scripts/fleet-pause.mjs pause [--timeout-minutes 60]
//       pauses every active routine in every company, stops the running CI runner units (aidenhq-ci-runner@*), then
//       waits until Paperclip's live runs, the runner's running jobs and agent computers are all zero (exit 1 on timeout;
//       run it again to keep waiting). Event wakes (Slack, the board's wake-ups) can still start runs; it waits for those.
//   node scripts/fleet-pause.mjs resume
//       reactivates exactly the routines and starts exactly the units pause recorded, then deletes the record.
// The record is <data dir>/fleet-paused.json, so it travels with the data dir to a new host. A second pause adds to it.
// A routine paused this way stays paused through applies (paperclip-setup resumes only the ones it paused itself), except
// one whose instance config sets a `status:`.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The record after another pause: earlier entries are kept (they are paused now, so this pass didn't see them as active). */
export function mergePaused(prev, next) {
  const routines = { ...(prev?.routines ?? {}) };
  for (const [company, ids] of Object.entries(next.routines ?? {})) routines[company] = [...new Set([...(routines[company] ?? []), ...ids])];
  const units = [...new Set([...(prev?.units ?? []), ...(next.units ?? [])])];
  return { pausedAt: prev?.pausedAt ?? next.pausedAt, routines, units };
}

async function main() {
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const envPath = process.env.AIDENHQ_ENV_FILE ?? join(repo, ".env");
  const dotenv = existsSync(envPath)
    ? Object.fromEntries(readFileSync(envPath, "utf8").split("\n").map((l) => /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(l)).filter(Boolean).map((m) => [m[1], m[2].replace(/^["']|["']$/g, "")]))
    : {};
  const env = (k, d) => process.env[k] ?? dotenv[k] ?? d;
  const expand = (p) => (p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);
  const dataDir = resolve(repo, expand(env("AIDENHQ_DATA_DIR", "data")));
  const recordPath = join(dataDir, "fleet-paused.json");
  const runnerYaml = join(resolve(repo, env("AIDENHQ_CONFIG_DIR", "config")), "runner.yaml");
  const stateDir = expand((existsSync(runnerYaml) && /^state_dir:\s*["']?([^"'\s#]+)/m.exec(readFileSync(runnerYaml, "utf8"))?.[1]) || "~/.local/state/aidenhq-runner");
  const base = env("PAPERCLIP_URL", "http://127.0.0.1:3100");
  const key = readFileSync(join(expand(env("AIDENHQ_SECRETS_DIR", "~/.config/aidenhq")), "paperclip_board_key"), "utf8").trim();

  const api = async (method, path, body) => {
    const res = await fetch(new URL(path, base), {
      method,
      headers: { authorization: `Bearer ${key}`, accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw Object.assign(new Error(`${method} ${path} → ${res.status}`), { status: res.status });
    return res.json();
  };
  const sh = (cmd, args) => { try { return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); } catch { return ""; } };
  const companies = async () => (await api("GET", "/api/companies")).map((c) => c.id);

  async function counts() {
    let runs = 0;
    for (const id of await companies()) runs += (await api("GET", `/api/companies/${id}/live-runs`)).length;
    let jobs = 0;
    const db = join(stateDir, "state.sqlite");
    if (existsSync(db)) {
      const { DatabaseSync } = await import("node:sqlite");
      const d = new DatabaseSync(db, { readOnly: true });
      try { jobs = d.prepare("SELECT count(*) AS n FROM jobs WHERE status = 'running'").get().n; } finally { d.close(); }
    }
    const computers = sh("docker", ["ps", "-q", "--filter", "name=aidenhq-computer-"]).split("\n").filter(Boolean).length;
    return { runs, jobs, computers };
  }

  const cmd = process.argv[2];
  if (cmd === "pause") {
    const i = process.argv.indexOf("--timeout-minutes");
    const timeoutMs = (i > 0 ? Number(process.argv[i + 1]) : 60) * 60_000;
    const routines = {};
    for (const company of await companies()) {
      const active = (await api("GET", `/api/companies/${company}/routines`)).filter((r) => r.status === "active");
      for (const r of active) await api("PATCH", `/api/routines/${r.id}`, { status: "paused" });
      routines[company] = active.map((r) => r.id);
      console.log(`company ${company}: paused ${active.length} routines`);
    }
    // Active or activating: with Restart=always an instance sits in "activating (auto-restart)" between jobs.
    const units = sh("systemctl", ["--user", "list-units", "aidenhq-ci-runner@*", "--all", "--plain", "--no-legend"])
      .split("\n").map((l) => l.trim().split(/\s+/)).filter(([u, , active]) => u && ["active", "activating", "reloading"].includes(active)).map(([u]) => u);
    if (units.length) { execFileSync("systemctl", ["--user", "stop", ...units], { stdio: "inherit" }); console.log(`stopped ${units.join(", ")}`); }
    const prev = existsSync(recordPath) ? JSON.parse(readFileSync(recordPath, "utf8")) : undefined;
    writeFileSync(recordPath, JSON.stringify(mergePaused(prev, { pausedAt: new Date().toISOString(), routines, units }), null, 2) + "\n");
    console.log(`recorded in ${recordPath}; waiting for live runs, runner jobs and agent computers to reach zero`);
    const until = Date.now() + timeoutMs;
    let last = "";
    for (;;) {
      const c = await counts();
      const line = `live runs ${c.runs}, runner jobs ${c.jobs}, agent computers ${c.computers}`;
      if (line !== last) console.log(`${new Date().toISOString().slice(11, 19)} ${line}`);
      last = line;
      if (!c.runs && !c.jobs && !c.computers) { console.log("drained"); return; }
      if (Date.now() > until) { console.error("timed out while work is still running; run pause again to keep waiting (everything stays paused)"); process.exit(1); }
      await new Promise((r) => setTimeout(r, 15_000));
    }
  } else if (cmd === "resume") {
    if (!existsSync(recordPath)) { console.error(`nothing to resume: no ${recordPath}`); process.exit(1); }
    const rec = JSON.parse(readFileSync(recordPath, "utf8"));
    let failed = 0;
    for (const [company, ids] of Object.entries(rec.routines ?? {})) {
      for (const id of ids) {
        try { await api("PATCH", `/api/routines/${id}`, { status: "active" }); } catch (e) {
          if (e.status === 404) { console.warn(`routine ${id} is gone, skipped`); continue; }
          failed++; console.error(`routine ${id}: ${e.message}`);
        }
      }
      console.log(`company ${company}: resumed ${ids.length} routines`);
    }
    if (rec.units?.length) { execFileSync("systemctl", ["--user", "start", ...rec.units], { stdio: "inherit" }); console.log(`started ${rec.units.join(", ")}`); }
    if (failed) { console.error(`${failed} routines could not be resumed; the record stays at ${recordPath}`); process.exit(1); }
    rmSync(recordPath);
    console.log("resumed");
  } else {
    console.error("usage: fleet-pause.mjs pause [--timeout-minutes N] | resume");
    process.exit(2);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
