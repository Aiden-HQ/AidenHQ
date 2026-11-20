#!/usr/bin/env node
// The connections build merged channel-slack into slack: the live listener's data (its SQLite: pairing, bindings, channel notes,
// the event log) moves from data/modules/channel-slack/slack-live to data/modules/slack/slack-live, once. apply-config runs this
// with the old container stopped, after compile (which made the new folder, empty) and before compose starts the new one.
//   node ops/slack-live-move.ts <data dir>     prints moved | done | fresh
import { existsSync, readdirSync, renameSync, rmSync, rmdirSync } from "node:fs";
import { join } from "node:path";

export function moveSlackLive(dataDir: string) {
  const from = join(dataDir, "modules", "channel-slack"), src = join(from, "slack-live");
  const dst = join(dataDir, "modules", "slack", "slack-live");
  if (!existsSync(src)) return existsSync(from) ? "done" : "fresh";
  // The new folder is empty (compile made it); a database already there is newer than this move and stays.
  if (existsSync(dst) && readdirSync(dst).length) throw new Error(`slack-live: ${dst} already has data; move ${src} by hand`);
  if (existsSync(dst)) rmdirSync(dst);
  renameSync(src, dst);
  // Only the old module's data-version marker is left: nothing else of it lives here.
  if (readdirSync(from).every((f) => f === ".data_version")) rmSync(from, { recursive: true });
  return "moved";
}

if (import.meta.main) {
  const dir = process.argv[2];
  if (!dir) { console.error("usage: slack-live-move.ts <data dir>"); process.exit(2); }
  console.log(moveSlackLive(dir));
}
