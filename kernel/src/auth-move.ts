#!/usr/bin/env node
// The accounts' move into the kernel (lean-core 3a, spec §2.6): data/board/auth.db and its auth.secret go to
// data/kernel/auth/, kept as they are (the owner's account, password and TOTP survive; nobody enrols again). Apply runs it
// with the board stopped, before the kernel restarts (ops/apply-config-work.sh). Never overwrites: once the kernel's copy
// exists it is the accounts, whatever an older board left behind at the old path since.
//   node kernel/src/auth-move.ts <data dir>     prints moved | present | fresh
import { existsSync, mkdirSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const authPath = (dataDir: string) => join(dataDir, "kernel", "auth", "auth.db");
const SIBLINGS = ["-journal", "-wal", "-shm"];

export function moveAccounts(dataDir: string): "moved" | "present" | "fresh" {
  const to = authPath(dataDir), from = join(dataDir, "board", "auth.db");
  if (existsSync(to)) return "present";
  if (!existsSync(from)) return "fresh";
  if (!existsSync(join(dataDir, "board", "auth.secret"))) throw new Error(`${from} has no auth.secret beside it: not moving (its TOTP secrets can't be read without it)`);
  mkdirSync(join(dataDir, "kernel", "auth"), { recursive: true, mode: 0o700 });
  // The secret first: a move cut short leaves the old file in place, which the kernel refuses to start on.
  renameSync(join(dataDir, "board", "auth.secret"), join(dataDir, "kernel", "auth", "auth.secret"));
  for (const s of SIBLINGS) if (existsSync(from + s)) renameSync(from + s, to + s);
  renameSync(from, to);
  return "moved";
}

/** At the kernel's start: the accounts file, or a refusal while the old one hasn't been moved (a fresh install has neither). */
export function accountsFile(dataDir: string): string {
  const to = authPath(dataDir);
  if (!existsSync(to) && existsSync(join(dataDir, "board", "auth.db"))) throw new Error(`the accounts are still at ${join(dataDir, "board", "auth.db")}: move them with the board stopped (node kernel/src/auth-move.ts ${dataDir})`);
  return to;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2];
  if (!dir) { console.error("usage: auth-move.ts <data dir>"); process.exit(2); }
  console.log(moveAccounts(resolve(dir)));
}
