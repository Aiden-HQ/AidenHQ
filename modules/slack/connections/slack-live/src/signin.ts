// The owner's Slack sign-in, which slack-mcp keeps (src/relay.ts there): whose it is, and the gap sync's reads made as the owner.
// The token never comes here; this service presents its own key (slack_relay_key).

/** Whose sign-in it is; null while Slack isn't connected (slack-mcp answers 409). Throws when slack-mcp can't be asked. */
export function ownerReader(base: string, key: string, fetchFn: typeof fetch = fetch) {
  return async (): Promise<{ user_id: string | null } | null> => {
    const res = await fetchFn(`${base}/internal/owner`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000) });
    if (res.status === 409) return null;
    if (!res.ok) throw new Error(`slack-mcp owner: ${res.status}`);
    const r = (await res.json()) as { user_id?: unknown };
    return { user_id: typeof r.user_id === "string" ? r.user_id : null };
  };
}
export type OwnerReader = ReturnType<typeof ownerReader>;
