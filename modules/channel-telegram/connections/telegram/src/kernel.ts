// The kernel's channel routes (spec §2.5), with this module's own token (its connection's service key). This channel holds no
// Paperclip key: owner messages, decisions and reads all go through the kernel, which stamps them as this channel's.
import { kernelClient as baseClient } from "./aidenhq-sdk/kernel-client.js";
export type Fetch = typeof fetch;

export interface Card {
  id: string;
  identifier: string;
  kind: string;
  tier: number;
  digest: string;
  sentence: string;
  changes: string;
  reads: string;
  cost: string;
  requestedBy: string;
  replaced: boolean;
  reason?: string;
  review?: string | null;
  tokens?: { approve: string; reject: string };
}
export type Finished = { id: string; identifier: string; state: string; outcome: "applied" | "failed" | null; outcomeText: string | null; sentence: string };
/** An owner card that ended without running: rejected (anywhere), replaced or expired. */
export type Ended = { id: string; identifier: string; state: string };
export type Decided = { ok: true; id: string; identifier: string; sentence: string; state: string } | { ok: false; reason: string };
export interface OwnerMessage {
  sender: string;
  text: string;
  voice?: true;
  forward?: { from: string; date: string };
  task?: string;
  agent?: string;
  /** A new @agent chat that went to Aiden instead: why (shown under the message). */
  note?: string;
}

export function kernelClient(url: string, token: string, f: Fetch = fetch) {
  const { call, raw, read } = baseClient(url, token, { fetcher: f });
  const ok = (method: string, path: string, body?: unknown) => call(method, path, body);
  return {
    /** Pending cards (tokens on the ones new to this channel; resync: fresh tokens for every card) and recent outcomes. */
    cards: async (resync = false): Promise<{ cards: Card[]; finished: Finished[]; ended: Ended[] }> => {
      const j = await ok("GET", `/v1/channel/cards${resync ? "?resync=1" : ""}`);
      return { cards: Array.isArray(j.cards) ? j.cards : [], finished: Array.isArray(j.finished) ? j.finished : [], ended: Array.isArray(j.ended) ? j.ended : [] };
    },
    decide: async (body: { token: string; sender: string; reply?: true; stale?: true }): Promise<Decided> => {
      const r = await raw("POST", "/v1/channel/decide", body);
      if (r.status !== 200) return { ok: false, reason: String(r.json?.error?.message ?? `the kernel said ${r.status}`) };
      return { ok: true, id: String(r.json.id ?? ""), identifier: String(r.json.identifier ?? ""), sentence: String(r.json.sentence ?? ""), state: String(r.json.state ?? "") };
    },
    /** The once-per-wait claim on the owner's answer to `task`'s open question (kernel answers.ts): "stale" when that wait is no longer the open one, "taken" when it was answered. */
    claimAnswer: async (task: string, since: string): Promise<"ok" | "stale" | "taken"> => {
      const r = await raw("POST", "/v1/answers/claim", { task, wait_since: since });
      if (r.status === 200) return "ok";
      if (r.status === 409) return r.json?.error === "taken" ? "taken" : "stale";
      throw new Error(`POST /v1/answers/claim -> ${r.status}`);
    },
    /** Gives the claim back after a failed delivery. */
    releaseAnswer: async (task: string, since: string): Promise<void> => { await call("POST", "/v1/answers/release", { task, wait_since: since }); },
    ownerMessage: async (m: OwnerMessage): Promise<{ task: { id: string; identifier: string } }> => ok("POST", "/v1/channel/owner-message", m),
    stop: async (task: string): Promise<{ stopped: number }> => ok("POST", "/v1/channel/stop", { task }),
    /** Every open task's one state with the fleet's counts (role kernel.flow-read). */
    openTasks: async (): Promise<any> => ok("GET", "/v1/tasks/state?open=1"),
    read,
  };
}
export type Kernel = ReturnType<typeof kernelClient>;
