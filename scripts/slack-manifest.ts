#!/usr/bin/env node
// The Slack module's one manifest source (modules/slack/slack-app-manifest.yml) as the JSON slack-live sends to Slack's
// apps.manifest.create and apps.manifest.update (connections/slack-live/src/manifests.json; a test compares the two):
// `basic`, the sign-in app, and `advanced`, the same app with the bot, Socket Mode and events.
//   node scripts/slack-manifest.ts            prints the manifests as JSON
//   node scripts/slack-manifest.ts --write    rewrites slack-live's manifests.json
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const here = join(dirname(fileURLToPath(import.meta.url)), "..", "modules", "slack");
export const MANIFESTS_JSON = join(here, "connections", "slack-live", "src", "manifests.json");
const isMap = (v: unknown): v is Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v)) as boolean;
/** Maps merge, lists add, anything else the overlay wins. */
const merge = (a: unknown, b: unknown): unknown => (isMap(a) && isMap(b) ? Object.fromEntries([...new Set([...Object.keys(a), ...Object.keys(b)])].map((k) => [k, k in b ? (k in a ? merge(a[k], b[k]) : b[k]) : a[k]])) : Array.isArray(a) && Array.isArray(b) ? [...a, ...b] : b);

export function manifests(source = readFileSync(join(here, "slack-app-manifest.yml"), "utf8")) {
  const { advanced, ...basic } = YAML.parse(source);
  return { basic, advanced: merge(basic, advanced) };
}

/** manifests.json's text. */
export const manifestsJson = (m = manifests()) => `${JSON.stringify(m, null, 2)}\n`;

if (import.meta.main) {
  if (process.argv.includes("--write")) {
    writeFileSync(MANIFESTS_JSON, manifestsJson());
    console.log("slack-manifest: written");
  } else console.log(manifestsJson());
}
