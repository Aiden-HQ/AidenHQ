// The fast chat lane (slack-live-mcp's /lane): an agent with a `chat:` block answers its board chats there, in seconds.
// Its conversation lives in the lane, not in a Paperclip task. The lane may be absent (older instance, no lane agents):
// reads fail soft to empty, a send fails loudly.

export interface LaneOptions {
  url: string;
  /** The board's internal token, which the lane accepts as its Bearer. */
  token: string;
}

export interface LaneAgent {
  key: string;
  id: string;
  name: string;
}

async function laneCall(lane: LaneOptions, method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(`${lane.url.replace(/\/+$/, "")}/lane${path}`, {
    method,
    headers: { authorization: `Bearer ${lane.token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(5_000),
  });
  if (!res.ok) throw new Error(`lane ${res.status}`);
  return res.json();
}

export async function laneAgents(lane?: LaneOptions): Promise<LaneAgent[]> {
  if (!lane) return [];
  try {
    const r = await laneCall(lane, "GET", "/agents");
    return Array.isArray(r?.agents) ? r.agents : [];
  } catch {
    return [];
  }
}

export async function laneMessages(lane: LaneOptions | undefined, key: string, after: string) {
  const empty = { messages: [], busy: false };
  if (!lane) return empty;
  try {
    return (await laneCall(lane, "GET", `/${encodeURIComponent(key)}/messages${after ? `?after=${encodeURIComponent(after)}` : ""}`)) ?? empty;
  } catch {
    return empty;
  }
}

/** `by`: the signed-in admin's name when that admin is not the owner. */
export async function laneSend(lane: LaneOptions | undefined, key: string, text: string, by?: string): Promise<void> {
  if (!lane) throw new Error("the fast chat lane isn't available");
  await laneCall(lane, "POST", `/${encodeURIComponent(key)}/messages`, { text, ...(by ? { by } : {}) });
}
