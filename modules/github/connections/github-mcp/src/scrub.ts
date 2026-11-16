// The owner-data scrub (spec §6.9a): an upstream issue is public, so nothing naming the instance's owner, its hosts or its
// accounts leaves. Two layers: the instance's own literals (compile's owner_terms: the owner's names, email and orgs, and
// every host and email an instance setting holds), and classes of data no product issue needs (any email, any IP outside
// loopback, documentation ranges and the product's backplane, control-plane and chat ids, credentials). A hit refuses the
// whole write with the matches, so the agent redacts and files again; nothing is rewritten here.

const SECRETS: [string, RegExp][] = [
  ["a GitHub token", /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/g],
  ["an API key", /\bsk-[A-Za-z0-9_-]{20,}/g],
  ["a Slack token", /\bxox[abposr]-[A-Za-z0-9-]{10,}/g],
  ["an AWS key", /\bAKIA[0-9A-Z]{16}\b/g],
  ["a Google key", /\bAIza[0-9A-Za-z_-]{35}/g],
  ["a bot token", /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/g],
  ["a JWT", /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g],
  ["a private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/g],
];
const CLASSES: [string, RegExp][] = [
  ["an email address", /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g],
  ["an IP address", /(?<![\w.])\d{1,3}(?:\.\d{1,3}){3}(?![\w.])/g],
  ["an IPv6 address", /(?<![\w:])[0-9a-f]{1,4}(?::[0-9a-f]{0,4}){3,7}(?![\w:])/gi],
  ["an id (uuid)", /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi],
  ["a Slack id", /\b[UCGWDT]0[A-Z0-9]{7,11}\b/g],
  ["a chat id", /(?<![\w-])-100\d{9,}\b/g],
];
// Product-public values that look like the classes above: documentation addresses, loopback, the product's own backplane.
const ALLOWED = [/@example\.(com|org|net)$/i, /^127\./, /^0\.0\.0\.0$/, /^10\.231\./, /^192\.0\.2\./, /^198\.51\.100\./, /^203\.0\.113\./];
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** What in `text` is owner data, as `kind: match` lines (credentials masked); empty when it may go out. */
export function scrubProblems(text: string, terms: string[]): string[] {
  const out = new Set<string>();
  for (const [kind, re] of SECRETS) for (const m of text.matchAll(re)) out.add(`${kind}: ${m[0].slice(0, 4)}…`);
  for (const [kind, re] of CLASSES)
    for (const m of text.matchAll(re)) {
      if (kind === "an IPv6 address" && !/[a-f]/i.test(m[0]) && !m[0].includes("::")) continue; // a time, not an address
      if (!ALLOWED.some((a) => a.test(m[0]))) out.add(`${kind}: ${m[0]}`);
    }
  for (const t of terms) if (new RegExp(`(?<![A-Za-z0-9])${escape(t)}(?![A-Za-z0-9])`, "i").test(text)) out.add(`this instance's own name or host: ${t}`);
  return [...out];
}

/**
 * The instance's literals from OWNER_TERMS (comma-separated, compiled from its settings), without the upstream's own org and
 * host (they name the product, not the owner) and anything too short to match safely.
 */
export function ownerTerms(list: string, upstream: string): string[] {
  const org = upstream.split("/")[0]!.toLowerCase();
  return [...new Set(list.split(",").map((t) => t.trim()).filter((t) => t.length >= 3 && ![org, "github.com", "www.github.com"].includes(t.toLowerCase())))];
}
