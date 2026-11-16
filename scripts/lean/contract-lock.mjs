#!/usr/bin/env node
// The kernel's contract lock (spec §3.3.5): kernel/contract.lock.json lists every public contract with a lifecycle state,
// and this script derives the same list from code and fails when the two differ.
//   node scripts/lean/contract-lock.mjs --check [--base <git ref>]   code vs lock (and, with --base, the lock vs that ref's)
//   node scripts/lean/contract-lock.mjs --write                      regenerate fingerprints; keeps states, new entries start `experimental`
// States: stable (never removed or changed), experimental (may change; edit the lock), obsolete (+ `remove_after`, a date, or
// null until scheduled; removable once it has passed), removed (a tombstone: the entry must be gone from code).
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import YAML from "yaml";

const STATES = ["stable", "experimental", "obsolete", "removed"];
const NOTICE_DAYS = 60;
const HOW = "run `node scripts/lean/contract-lock.mjs --write`, set the state of any new entry, and commit kernel/contract.lock.json";
const DAY = 86400000;

/** Every public contract in code: route -> auth kind, schema node -> its shape, manifest key, provider contract major. */
export async function generate(repo) {
  const out = {};
  const { ROUTES } = await import(pathToFileURL(join(repo, "kernel/src/backplane.ts")).href);
  for (const r of ROUTES) out[`route ${r.method} ${r.path}`] = `auth=${r.auth}`;
  const { ROUTES: ADMIN } = await import(pathToFileURL(join(repo, "kernel/src/admin.ts")).href);
  for (const r of ADMIN) out[`admin route ${r.method} ${r.path}`] = `auth=${r.auth}`;

  const walk = (id, node, req) => {
    const { description, title, $schema, $id, properties, additionalProperties, items, required, ...shape } = node;
    out[id] = JSON.stringify({ req, ...(additionalProperties === false ? { closed: true } : {}), ...shape });
    for (const [k, v] of Object.entries(properties ?? {})) walk(`${id}.${k}`, v, (required ?? []).includes(k));
    if (additionalProperties && typeof additionalProperties === "object") walk(`${id}.*`, additionalProperties, false);
    if (items) walk(`${id}[]`, items, false);
  };
  const dir = join(repo, "kernel/schemas");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) walk(`schema ${f}`, JSON.parse(readFileSync(join(dir, f), "utf8")), true);

  // The manifest's top-level keys, as the shipped modules and fixtures use them.
  for (const root of ["modules", "fixtures"]) {
    if (!existsSync(join(repo, root))) continue;
    for (const m of readdirSync(join(repo, root))) {
      const f = join(repo, root, m, "module.yaml");
      if (existsSync(f)) for (const k of Object.keys(YAML.parse(readFileSync(f, "utf8")) ?? {})) out[`manifest key ${k}`] = "";
    }
  }

  const types = readFileSync(join(repo, "kernel/sdk/src/types.ts"), "utf8");
  for (const [, name, major] of types.matchAll(/contract: "([a-z]+)@(\d+)"/g)) out[`provider ${name}@${major}`] = "";
  return out;
}

const isDate = (d) => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(d));
const passed = (e, today) => isDate(e.remove_after) && e.remove_after <= today;

/** What the lock gets wrong: `head` is the lock in this change, `base` the lock it started from (or null), `generated` the code's. */
export function contractLockProblems(base, head, generated, today) {
  const p = [];
  const he = head.entries ?? {};
  for (const [id, e] of Object.entries(he)) {
    if (!STATES.includes(e.state)) p.push(`${id}: state must be one of ${STATES.join(", ")} (got ${e.state})`);
    if (e.state === "obsolete" && e.remove_after !== null && !isDate(e.remove_after)) p.push(`${id}: obsolete needs remove_after, a YYYY-MM-DD date (or null until scheduled)`);
    if (e.state === "removed" && id in generated) p.push(`${id}: marked removed but still in code`);
    if (e.state !== "removed" && !(id in generated)) p.push(`${id}: in the lock but gone from code; ${HOW}`);
    else if (e.state !== "removed" && e.fp !== generated[id]) p.push(`${id}: its shape changed (lock ${e.fp || "-"}, code ${generated[id] || "-"}); ${HOW}`);
  }
  for (const id of Object.keys(generated)) if (!(id in he)) p.push(`${id}: in code but not in the lock; ${HOW}`);

  const notice = new Date(Date.parse(today) + NOTICE_DAYS * DAY).toISOString().slice(0, 10);
  for (const [id, b] of Object.entries(base?.entries ?? {})) {
    const h = he[id];
    if (!h) {
      if (b.state === "stable") p.push(`${id}: a stable entry can't be removed; mark it obsolete with remove_after at least ${NOTICE_DAYS} days out, remove it after that date`);
      else if (b.state === "obsolete" && !passed(b, today)) p.push(`${id}: obsolete until ${b.remove_after ?? "an unscheduled date"}; it can't be removed before then`);
      continue;
    }
    if (b.state === "stable" && h.state === "experimental") p.push(`${id}: a stable entry can't go back to experimental`);
    if (b.state === "stable" && h.state === "stable" && b.fp !== h.fp) p.push(`${id}: stable, so its shape can't change (add a new entry or bump the major)`);
    if (b.state === "stable" && h.state === "obsolete" && !(isDate(h.remove_after) && h.remove_after >= notice)) p.push(`${id}: stable -> obsolete needs remove_after of at least ${notice} (${NOTICE_DAYS} days from ${today})`);
    if (b.state === "obsolete" && h.state === "removed" && !passed(b, today)) p.push(`${id}: obsolete until ${b.remove_after ?? "an unscheduled date"}; it can't be removed before then`);
  }
  return p;
}

const LOCK = "kernel/contract.lock.json";

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const repo = fileURLToPath(new URL("../..", import.meta.url));
  const args = process.argv.slice(2);
  const generated = await generate(repo);
  const head = existsSync(join(repo, LOCK)) ? JSON.parse(readFileSync(join(repo, LOCK), "utf8")) : { entries: {} };
  if (args.includes("--write")) {
    const entries = {};
    for (const id of Object.keys(generated).sort()) entries[id] = { ...(head.entries[id] ?? { state: "experimental" }), fp: generated[id] };
    for (const [id, e] of Object.entries(head.entries)) if (e.state === "removed") entries[id] = e;
    writeFileSync(join(repo, LOCK), `${JSON.stringify({ version: 1, entries }, null, 2)}\n`);
    console.log(`wrote ${LOCK}: ${Object.keys(entries).length} entries`);
  } else {
    const ref = args.includes("--base") ? args[args.indexOf("--base") + 1] : null;
    let base = null;
    if (ref) try { base = JSON.parse(execFileSync("git", ["show", `${ref}:${LOCK}`], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })); } catch { /* the base has no lock yet */ }
    const problems = contractLockProblems(base, head, generated, new Date().toISOString().slice(0, 10));
    for (const m of problems) console.error(`contract lock: ${m}`);
    if (problems.length) process.exit(1);
    console.log(`contract lock ok: ${Object.keys(head.entries).length} entries${base ? " (against the base lock)" : ""}`);
  }
}
