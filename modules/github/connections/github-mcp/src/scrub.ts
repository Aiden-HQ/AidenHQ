import { createHmac } from "node:crypto";
import { GitHubRefused } from "./github.js";

// The owner-data scrub (spec §6.9a): an upstream issue is public, so nothing naming the instance's owner, its hosts or its
// accounts leaves. Two layers: the instance's own literals (compile's owner_terms: the owner's names, email and orgs, and
// every host and email an instance setting holds), and classes of data no product issue needs (any email, any IP outside
// loopback, documentation ranges and the product's backplane, control-plane and chat ids, credentials). Outgoing issue text
// is rewritten with those matches replaced (scrubText); anything the rewrite can't reach — data hidden behind entities,
// tags or look-alikes — still refuses the whole write, so nothing leaks.

export const SECRETS: [string, RegExp][] = [
  ["a GitHub token", /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/g],
  ["an API key", /\bsk-[A-Za-z0-9_-]{20,}/g],
  ["a Slack token", /\bxox[abposr]-[A-Za-z0-9-]{10,}/g],
  ["an AWS key", /\bAKIA[0-9A-Z]{16}\b/g],
  ["a Google key", /\bAIza[0-9A-Za-z_-]{35}/g],
  ["a bot token", /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/g],
  ["a JWT", /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g],
  // The header alone is no use: the key is the body under it, so the whole block goes, to its matching END or the end.
  ["a private key", /-----BEGIN ([A-Z ]*PRIVATE KEY)-----[\s\S]*?(?:-----END \1-----\n?|$)/g],
];
const CLASSES: [string, RegExp][] = [
  ["an email address", /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g],
  // A sentence's full stop may follow (`on 10.0.0.5.`); a further `.digit` means a longer dotted number (a version), not an IP.
  ["an IP address", /(?<![\w.])\d{1,3}(?:\.\d{1,3}){3}(?!\w|\.\d)/g],
  ["an IPv6 address", /(?<![\w:])[0-9a-f]{1,4}(?::[0-9a-f]{0,4}){3,7}(?![\w:])/gi],
  ["an id (uuid)", /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi],
  ["a Slack id", /\b[UCGWDT]0[A-Z0-9]{7,11}\b/g],
  ["a chat id", /(?<![\w-])-100\d{9,}\b/g],
];
// Product-public values that look like the classes above: documentation addresses, loopback, the product's own backplane.
const ALLOWED = [/@example\.(com|org|net)$/i, /^127\./, /^0\.0\.0\.0$/, /^10\.231\./, /^192\.0\.2\./, /^198\.51\.100\./, /^203\.0\.113\./];
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/**
 * The text as GitHub renders it, for matching: HTML entities decoded, comments and tags dropped, format characters
 * (zero-width and the like) removed, NFKC look-alikes folded, Markdown escapes and emphasis marks dropped.
 */
export function rendered(text: string): string {
  let t = text;
  for (let i = 0; i < 3; i++) // nested entities (&amp;#65;) decode in a few rounds
    t = t.replace(/&(?:#(\d{1,7})|#x([0-9a-f]{1,6})|([a-z]{2,8}));?/gi, (m, d, h, n) => (d ? String.fromCodePoint(Math.min(+d, 0x10ffff)) : h ? String.fromCodePoint(Math.min(parseInt(h, 16), 0x10ffff)) : (ENTITIES[n.toLowerCase()] ?? m)));
  return t
    .replace(/<!--[\s\S]*?(?:-->|$)/g, "")
    .replace(/<\/?[a-z][^>]*>/gi, "")
    .replace(/\p{Cf}/gu, "")
    .normalize("NFKC")
    .replace(/\\(?=[!-\/:-@[-`{-~])/g, "")
    .replace(/[*_~`]/g, "");
}

/**
 * Opaque, stable ids for where a report came from: the instance and the agent, keyed by this instance's own origin key
 * (github_origin_key, used for nothing else). Without a key nothing is filed: throws.
 */
export function originIds(secret: string, agent: string): { instance: string; agent: string } {
  if (secret.length < 16) throw new Error("no origin key (github_origin_key) is mounted, so nothing is filed upstream; the next apply generates it");
  const id = (s: string) => createHmac("sha256", secret).update(s).digest("hex").slice(0, 12);
  return { instance: id("aidenhq-instance"), agent: id(`aidenhq-agent:${agent}`) };
}

/** What in `text` (as written, and as GitHub renders it) is owner data, as `kind: match` lines (credentials masked); empty when it may go out. */
export function scrubProblems(raw: string, terms: string[]): string[] {
  const out = new Set<string>();
  const text = `${raw}\n${rendered(raw)}`;
  for (const [kind, re] of SECRETS) for (const m of text.matchAll(re)) out.add(`${kind}: ${m[0].slice(0, 4)}…`);
  for (const [kind, re] of CLASSES)
    for (const m of text.matchAll(re)) {
      if (kind === "an IPv6 address" && !/[a-f]/i.test(m[0]) && !m[0].includes("::")) continue; // a time, not an address
      if (!ALLOWED.some((a) => a.test(m[0]))) out.add(`${kind}: ${m[0]}`);
    }
  for (const t of terms) if (new RegExp(`(?<![A-Za-z0-9])${escape(t)}(?![A-Za-z0-9])`, "i").test(text)) out.add(`this instance's own name or host: ${t}`);
  return [...out];
}

/** `text` with every piece of owner data replaced by `[redacted]`, matched by the same rules as scrubProblems. */
export function scrubText(raw: string, terms: string[]): string {
  let text = raw;
  for (const [, re] of SECRETS) text = text.replace(re, "[redacted]");
  for (const [kind, re] of CLASSES)
    text = text.replace(re, (m) => (kind === "an IPv6 address" && !/[a-f]/i.test(m) && !m.includes("::")) || ALLOWED.some((a) => a.test(m)) ? m : "[redacted]");
  for (const t of terms) text = text.replace(new RegExp(`(?<![A-Za-z0-9])${escape(t)}(?![A-Za-z0-9])`, "gi"), "[redacted]");
  return text;
}

/**
 * The instance's literals from OWNER_TERMS (comma-separated, compiled from its settings), without the upstream's own org and
 * host (they name the product, not the owner) and anything too short to match safely.
 */
export function ownerTerms(list: string, upstream: string): string[] {
  const org = upstream.split("/")[0]!.toLowerCase();
  return [...new Set(list.split(",").map((t) => t.trim()).filter((t) => t.length >= 3 && ![org, "github.com", "www.github.com"].includes(t.toLowerCase())))];
}

/**
 * The one gate for text posted in public as the owner (a comment, a thread reply): owner data rewritten out (scrubText), then
 * checked raw and as GitHub renders it (scrubProblems); anything left refuses the post. The refusal names only the kinds found,
 * never the values, so the logs that carry it hold no owner data.
 */
export function publicText(body: string, terms: string[], what: string): string {
  const text = scrubText(body, terms);
  const left = scrubProblems(text, terms);
  if (left.length) throw new GitHubRefused(`owner data can't go into a public ${what}; take out ${[...new Set(left.map((p) => p.split(":")[0]))].join(", ")} and try again`);
  return text;
}
