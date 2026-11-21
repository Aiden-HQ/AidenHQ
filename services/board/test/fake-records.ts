// The kernel's records as the board reads them (records.ts), held in memory: a card is `card({...})`, filed with `file`.
import type { Approval, Records } from "../src/records.js";

export const card = (o: Partial<Approval> & { id: string }): Approval => ({
  issueId: "t1", identifier: "WOR-1", action: "apply", target: "x", digest: "d".repeat(40), args: {}, sentence: "s", reads: "", changes: "c", cost: "", details: "", requestedBy: "r", requesterId: null,
  tier: 2, reason: "", reasonCode: null, review: null, reviewCode: null, state: "pending", decidedBy: null, decidedAt: null, usedAt: null, outcome: null, outcomeText: null, wait: null,
  createdAt: "2026-11-10T10:00:00.000Z", replaced: false, panel: false, reviewFirst: null, ...o,
});

export function fakeRecords(cards: Approval[] = []): Records & { cards: Approval[]; settings: { task: string; changes: unknown[]; credential?: unknown }[] } {
  const settings: { task: string; changes: unknown[]; credential?: unknown }[] = [];
  const list: Records["list"] = async (state, { task, limit = 100 } = {}) =>
    cards
      .filter((a) => (!task || a.issueId === task || a.identifier === task) && (state === "owner" ? a.state === "pending" && a.tier === 2 : state === "pending" ? a.state === "pending" : state === "finished" ? a.outcome : true))
      .slice(0, limit);
  return { cards, settings, list, advisories: async () => [], explain: async () => { throw new Error("no such record"); }, connectionHealth: async () => ({}), connectionOk: async () => {}, validate: async () => ({ ok: true }), settingsChange: async (task, changes, credential) => (settings.push({ task, changes, ...(credential ? { credential } : {}) }), { record: "k-0000000000000001", tier: 1, state: "review" }) };
}
