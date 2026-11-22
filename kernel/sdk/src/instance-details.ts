// What a GitHub thread, which is outside the instance, must not carry: a tailnet host, a home path or an address. One scan, used by
// the reviewer's code check (reviewer.ts), the kernel's write.filed check on code review's posts and the code-review service that
// removes these from its own text before filing (copied to each by scripts/sync-shared.ts).

/** The instance details in plain text (see instanceDetails): the hosts, home paths and addresses it holds, each once. */
export function instanceDetailsIn(text: string, versions = new Set<string>()): string[] {
  const found = [
    // An IPv6 address (a tailnet's fd7a:...): at least four groups, with a `::` or a hex letter so a clock time is not one; loopback is not.
    ...[...text.matchAll(/(?<![\w:])[0-9a-f]{1,4}(?::[0-9a-f]{0,4}){3,7}(?![\w:])/gi)].filter((m) => /::|[a-f]/i.test(m[0]) && !/^(?:0{0,4}:){2,7}0{0,3}1$/.test(m[0])),
    ...text.matchAll(/\b[\w-]+(?:\.[\w-]+)*\.ts\.net\b/gi),
    ...text.matchAll(/(?<![\w.~])\/(?:home|Users)\/[\w.-]+\/\S*/g),
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
