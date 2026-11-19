#!/usr/bin/env node
// Before an apply stops the modules it removes or replaces (spec §5.7.1 step 4), while they still run: each claimed record
// of their kinds is settled through its executor's status (done or failed; anything else is marked unknown and listed, never
// run again), and their open records are cancelled. The apply (ops/apply-config-work.sh) runs it between validate and the
// snapshot:   node kernel/src/reconcile.ts <running config/modules.json> <staged config.next/modules.json>
// Prints one line per unresolved record. No records yet (no kernel.db) or nothing removed: nothing to do.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { watched } from "./gateway/lib.ts";
import { configDir, dataDir, env, secret } from "./env.ts";
import { createResolver } from "./net.ts";
import { openRecords } from "./records.ts";
import { createWrites, type Kind } from "./writes.ts";
import type { Connection } from "./identity.ts";

const [running, staged] = process.argv.slice(2);
type Entry = { name: string; enabled?: boolean; replaces?: string[] };
const load = (f?: string): Entry[] => (f && existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as Entry[]).filter((m) => m.enabled) : []);
const enabled = (f?: string) => new Set(load(f).map((m) => m.name));
const next = enabled(staged);
const successor = (m: string) => load(staged).find((n) => n.replaces?.includes(m))?.name; // the module that absorbed m (`replaces`)
const removed = [...enabled(running)].filter((m) => !next.has(m));
const db = path.join(dataDir, "kernel", "kernel.db");
if (removed.length && existsSync(db)) {
  const records = openRecords(db);
  const writes = createWrites({
    records,
    registry: watched(path.join(configDir, "kernel", "writes.json"), (j) => j as Record<string, Kind>, {}), // the running modules' kinds
    connections: watched(path.join(configDir, "kernel", "connections.json"), (j) => j as Record<string, Connection>, {}),
    secret, resolver: createResolver({ project: env("COMPOSE_PROJECT_NAME", "aidenhq") }),
    onTask: { open: async () => true, notify: async () => {} }, // the apply log carries what it did
    replay: async () => ({ ok: false, text: "not replayed" }),
  });
  // A removed module's successor carries on its claimed records (its executor is still delivering them): they move to its kinds.
  for (const m of removed) {
    const to = successor(m);
    if (to) for (const r of records.ofModules([m], ["claimed"])) if (r.kind.startsWith(`${m}.`) && records.carry(r.id, `${to}${r.kind.slice(m.length)}`, to)) console.log(`apply records: ${r.id} ${r.kind} carried to ${to}`);
  }
  for (const line of await writes.reconcile(removed)) console.log(`apply records: ${line} (its module ${removed.join(", ")} is being removed)`);
}
