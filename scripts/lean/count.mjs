#!/usr/bin/env node
// Lean-core ratchet counters (spec §9): kernel and SDK lines, the trusted base, vendor and module names in the kernel and
// in today's core, kernel settings and kill switches. Counts tracked files only, so the Mac, CI and the host agree.
// scripts/test/lean.test.mjs fails when any number grows past scripts/lean/baseline.json.
//   node scripts/lean/count.mjs [--json]
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const CODE = /\.(ts|tsx|mjs|js|sh)$/;
const SKIP = /(^|\/)(test|node_modules|dist|fixtures)\/|\.test\./;
const VENDORS = ["GitHub", "OpenRouter", "Codex", "Claude", "Anthropic", "Slack", "Telegram", "Google", "Glean", "Grafana", "ClickHouse", "Jira", "Primer", "Cloudflare", "Tailscale", "Dependabot", "Paperclip"];
const CONTROLPLANE = "kernel/src/controlplane/";
const CORE = ["services/runner/src/", "services/board/src/", "services/computer/", "services/shared/", "services/paperclip-tasks-mcp/", "scripts/modules.mjs", "scripts/compile.mjs", "scripts/paperclip-setup.mjs"];
const CORE_EXCEPT = ["services/computer/images/"];
const LEGACY_TRUSTED = ["services/apps-mcp/src/", "services/gate/", "modules/chat-lane/"];

const under = (f, paths) => paths.some((p) => (p.endsWith("/") ? f.startsWith(p) : f === p));
const isSource = (f) => CODE.test(f) && !SKIP.test(f);

/** Non-blank, non-comment lines. */
function lines(text, file) {
  let n = 0;
  for (const raw of text.split("\n")) {
    const t = raw.trim();
    if (!t || t.startsWith("//") || t.startsWith("/*") || t.startsWith("*") || (file.endsWith(".sh") && t.startsWith("#"))) continue;
    n++;
  }
  return n;
}

const yamlOf = (repo, f) => YAML.parse(readFileSync(join(repo, f), "utf8")) ?? {};
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function measure(repo) {
  const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: repo, maxBuffer: 64 << 20, encoding: "utf8" }).split("\0").filter(Boolean).filter((f) => existsSync(join(repo, f)));
  const read = (f) => readFileSync(join(repo, f), "utf8");
  const sum = (files) => files.reduce((n, f) => n + lines(read(f), f), 0);
  const src = tracked.filter(isSource);

  const manifests = tracked.filter((f) => /^modules\/[^/]+\/module\.yaml$/.test(f));
  // Privileged modules and those that enforce a check (P5: a check raises or denies every write it covers) are trusted.
  const privileged = manifests.filter((f) => [yamlOf(repo, f).privileged ?? []].flat().length || [yamlOf(repo, f).checks ?? []].flat().length).map((f) => f.slice(0, -"module.yaml".length));
  const core = src.filter((f) => under(f, CORE) && !under(f, CORE_EXCEPT));
  const trusted = new Set([...src.filter((f) => under(f, ["kernel/src/", "kernel/ops/", "ops/", ...privileged, ...LEGACY_TRUSTED]) || /^scripts\/[^/]+\.sh$/.test(f)), ...core]);

  // Vendors match anywhere in a word (githubToken); module names only as whole words (`core`, `ci`).
  const market = existsSync(join(repo, "modules/marketplace.json")) ? JSON.parse(read("modules/marketplace.json")).plugins.map((p) => p.name) : [];
  const vendors = VENDORS.map((v) => v.toLowerCase());
  const names = market.filter((m) => !vendors.includes(m.toLowerCase()));
  const byLength = (a, b) => b.length - a.length;
  const vendorRe = new RegExp(vendors.sort(byLength).map(escape).join("|"), "gi");
  const nameRe = names.length ? new RegExp(`(?<![a-z0-9])(${names.sort(byLength).map(escape).join("|")})(?![a-z0-9])`, "gi") : null;
  const hits = (f) => {
    const text = read(f);
    const v = [...text.matchAll(vendorRe)].filter((m) => !(m[0].toLowerCase() === "paperclip" && f.startsWith(CONTROLPLANE))).length;
    return v + (nameRe ? [...text.matchAll(nameRe)].length : 0);
  };
  const coupling = tracked.filter((f) => f.startsWith("kernel/") && !f.includes("/node_modules/")).reduce((n, f) => n + hits(f), 0);

  const coreSettings = Object.keys(yamlOf(repo, "modules/core/module.yaml").settings ?? {}).length;
  const kernelSettings = existsSync(join(repo, "kernel/settings.json")) ? Object.keys(JSON.parse(read("kernel/settings.json"))).length : 0;
  const onOff = (d) => {
    const v = Array.isArray(d?.values) ? d.values.map(String) : [];
    return (v.length === 2 && v.includes("on") && v.includes("off")) || d?.default === "on" || d?.default === "off";
  };
  const killswitches = manifests.reduce((n, f) => n + Object.values(yamlOf(repo, f).settings ?? {}).filter(onOff).length, 0);

  return {
    kernel: sum(src.filter((f) => f.startsWith("kernel/src/"))),
    sdk: sum(src.filter((f) => f.startsWith("kernel/sdk/"))),
    core: sum(core),
    trusted: sum([...trusted]),
    coupling,
    core_coupling: core.reduce((n, f) => n + hits(f), 0),
    settings: coreSettings + kernelSettings,
    killswitches,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const repo = fileURLToPath(new URL("../..", import.meta.url));
  const m = measure(repo);
  if (process.argv.includes("--json")) console.log(JSON.stringify(m, null, 2));
  else {
    const base = JSON.parse(readFileSync(join(repo, "scripts/lean/baseline.json"), "utf8"));
    for (const [k, v] of Object.entries(m)) console.log(`${k.padEnd(14)} ${String(v).padStart(7)}  (baseline ${base[k]})`);
  }
}
