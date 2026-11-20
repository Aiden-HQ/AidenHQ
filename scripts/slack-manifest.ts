#!/usr/bin/env node
// The Slack module's one manifest source (modules/slack/slack-app-manifest.yml) as the two things its setup flow shows: the
// basic "create app" link (a sign-in app) and the advanced manifest to paste into that app's App Manifest page (adds the bot,
// Socket Mode and events: Slack only pre-fills a NEW app from a link, so an upgrade is a paste). Both sit in
// modules/slack/module.yaml as plain text; a test compares them with the source, and `--write` rewrites them there.
//   node scripts/slack-manifest.ts            prints both manifests as JSON
//   node scripts/slack-manifest.ts --write    rewrites the links in module.yaml
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const here = join(dirname(fileURLToPath(import.meta.url)), "..", "modules", "slack");
const isMap = (v: unknown): v is Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v)) as boolean;
/** Maps merge, lists add, anything else the overlay wins. */
const merge = (a: unknown, b: unknown): unknown => (isMap(a) && isMap(b) ? Object.fromEntries([...new Set([...Object.keys(a), ...Object.keys(b)])].map((k) => [k, k in b ? (k in a ? merge(a[k], b[k]) : b[k]) : a[k]])) : Array.isArray(a) && Array.isArray(b) ? [...a, ...b] : b);

export function manifests(source = readFileSync(join(here, "slack-app-manifest.yml"), "utf8")) {
  const { advanced, ...basic } = YAML.parse(source);
  return { basic, advanced: merge(basic, advanced) };
}

/** Slack's pre-filled new-app URL. */
export const createLink = (manifest: unknown) =>
  `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(JSON.stringify(manifest)).replace(/[()']/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`;

/** The advanced manifest as one line of JSON, for the page's copy button. */
export const pasteText = (manifest: unknown) => JSON.stringify(manifest);

const LINK = /https:\/\/api\.slack\.com\/apps\?new_app=1&manifest_json=[^)\s]*/g;
const PASTE = /`\{"display_information"[^`]*`/g;

/** The basic link and the advanced paste text as module.yaml holds them (one each). */
export const found = (moduleYaml: string) => ({ link: moduleYaml.match(LINK) ?? [], paste: (moduleYaml.match(PASTE) ?? []).map((t: string) => t.slice(1, -1)) });

/** module.yaml's text with its basic link and its advanced paste text made from the source. */
export function withManifests(moduleYaml: string, m = manifests()) {
  return moduleYaml.replace(LINK, () => createLink(m.basic)).replace(PASTE, () => `\`${pasteText(m.advanced)}\``);
}

if (import.meta.main) {
  const file = join(here, "module.yaml");
  if (process.argv.includes("--write")) {
    const text = readFileSync(file, "utf8");
    writeFileSync(file, withManifests(text));
    console.log("slack-manifest: written");
  } else console.log(JSON.stringify(manifests(), null, 2));
}
