// What a GitHub thread, which is outside the instance, must not carry: a tailnet host, a home path or an address. One scan, used by
// the reviewer's code check (reviewer.ts), the kernel's write.filed check on code review's posts and the code-review service that
// removes these from its own text before filing (copied to each by scripts/sync-shared.ts).

/** The instance details in plain text (see instanceDetails): the hosts, home paths and addresses it holds, each once. */
export function instanceDetailsIn(text: string, versions = new Set<string>()): string[] {
  const found = [
    // An IPv6 address, by shape: eight groups (never a MAC address, six groups, or a clock time), or a compressed form that holds a
    // digit (`2001:db8::1`, `fd12::34`; never a scoped name like `DB::Feed`); loopback (`::1`) is not.
    ...[...text.matchAll(/(?<![\w:])(?:(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}|(?:[0-9a-f]{1,4}:){1,7}(?::[0-9a-f]{1,4}){1,7}|(?:[0-9a-f]{1,4}:){1,7}:|::(?:[0-9a-f]{1,4}:){0,6}[0-9a-f]{1,4})(?!\w|:[\w:])/gi)].filter((m) => !/^(?:0{0,4}:){1,7}0{0,3}1$/.test(m[0]) && (!m[0].includes("::") || /\d/.test(m[0]))),
    // Hosts are the tailnet's MagicDNS names (`*.ts.net`), the only host shape an instance has: a bare short name is ordinary text.
    ...text.matchAll(/\b[\w-]+(?:\.[\w-]+)*\.ts\.net\b/gi),
    // A Windows profile directory, with or without a tail.
    ...text.matchAll(/(?<![\w])[A-Za-z]:\\Users\\[\w.-]+(?:\\\S*)?/g),
    ...text.matchAll(/(?<![\w.~])\/(?:home|Users|root)(?![\w-])(?:\/[\w.-]+(?:\/\S*)?)?/g),
    ...[...text.matchAll(/(?<![\w.])\d{1,3}(?:\.\d{1,3}){3}(?!\w|\.\d)/g)]
      .filter((m) => m[0].split(".").every((o) => Number(o) <= 255))
      .filter((m) => !/^(127\.|0\.0\.0\.0$)/.test(m[0]) && !(versions.has(m[0]) && !addressShaped(text, m.index ?? 0, m[0].length))),
  ].map((m) => m[0].replace(/[`'"),.\\]+$/, ""));
  return [...new Set(found)];
}

/**
 * Whether a quad is used as an address rather than a number: a URL host, a host with a port, or a bare host after a scheme or
 * `@`. A version argument's value is still refused when the text uses it to reach something, since a version never is one.
 */
function addressShaped(text: string, at: number, length: number): boolean {
  const before = text.slice(Math.max(0, at - 8), at), after = text.slice(at + length, at + length + 2);
  // A scheme or user part right before it (`https://`, `user@`), or a port right after it (`:8443`), means a host.
  return /(?:\/\/|@)$/.test(before) || /^:\d/.test(after);
}

/** The keys whose string values a review or reply publishes as comment text: what a model or run wrote. A finding's path and the repo are the PR's own names and the anchors of the comments, so they are not read. */
const TEXT_KEYS = new Set(["title", "why", "evidence", "fix_brief", "option", "incomplete", "body", "stale_guidance"]);
/** Text as GitHub receives it: invisible format and control characters dropped (the poster's `plain` does the same), so none can hide a match. */
const normal = (t: string) => t.replace(/[^\P{Cc}\n\t]|\p{Cf}/gu, "");
/** The comment text in a write's args: each string under a text key (and each one of a text list). */
export function publishedText(args: unknown): string[] {
  const out: string[] = [];
  const read = (x: unknown) => { if (typeof x === "string") out.push(normal(x)); else if (Array.isArray(x)) x.forEach(read); };
  JSON.parse(JSON.stringify(args ?? null), (k, x) => { if (TEXT_KEYS.has(k)) read(x); return x; });
  return out;
}
/**
 * The args with the instance's details removed from their comment text: the longest match first (so a path that holds a host goes
 * whole), again until none is left (a removed host can expose a path), by a marker shorter than any match so no field outgrows
 * its schema limit.
 */
export function withoutInstanceDetails<T>(args: T): T {
  const clean = (t: string) => {
    let out = normal(t);
    for (let i = 0; i < 3; i++) {
      const found = instanceDetailsIn(out).sort((a, b) => b.length - a.length);
      if (!found.length) break;
      out = out.replace(new RegExp(found.map((f) => f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g"), "[x]");
    }
    return out;
  };
  const cleanAll = (x: unknown): unknown => (typeof x === "string" ? clean(x) : Array.isArray(x) ? x.map(cleanAll) : x);
  return JSON.parse(JSON.stringify(args), (k, x) => (TEXT_KEYS.has(k) ? cleanAll(x) : x));
}
