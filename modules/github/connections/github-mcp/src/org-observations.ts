// One org's answers reach the kernel in the order this process observed them. An org's refusal raises an sso/restricted need
// (POST /v1/connections/need) and a GraphQL org answer that works clears it (POST /v1/connections/ok). Each is a single POST sent
// without waiting, so without an order the kernel can take the need after the clear and put back a row the owner already fixed.
// Chained per org, lowercased (GitHub logins are case-insensitive): a clear and a need for one org never overtake each other, and
// a success after a refusal clears that refusal, as a success before one leaves the newer need standing.

const chains = new Map<string, Promise<unknown>>();

/**
 * Run `send` after every report this process already queued for `org`, and answer its result. A failed earlier report never stops
 * this one; only `send`'s own failure reaches the caller.
 */
export function inOrgOrder<T>(org: string, send: () => Promise<T>): Promise<T> {
  const key = org.toLowerCase();
  const prev = chains.get(key) ?? Promise.resolve();
  const run = prev.then(send, send);
  const settled = run.then(() => undefined, () => undefined);
  chains.set(key, settled);
  void settled.then(() => { if (chains.get(key) === settled) chains.delete(key); });
  return run;
}
