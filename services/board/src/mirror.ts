// A card is a kernel record; Paperclip counts only its own approvals as a durable wait, so an agent-owned in_progress
// task whose remaining work is an open card is repaired as a wait with no target (#396). This mirrors each open record
// as one linked pending approval on its task, and retires the mirror when the record leaves its open states. The board
// tick that already reads records reconciles both directions, so a missed call or a restart heals on the next pass.
//
// The mirror is bookkeeping only, and it never decides anything: record state still moves only through records.review,
// records.decide and records.claim, which this module cannot reach. Retiring a mirror unlinks it from its task and then
// rejects the mirror's own approval, never the card; nothing in the board's card path reads Paperclip approvals, so no
// card is decided, approved or rejected by it, and the unlink keeps the retire from waking the task's agent (paperclip.ts).
//
// The board keeps no store of its own: Paperclip holds the mirrors. A mirror is ours when `requestedByUserId` is the
// board's own user (the key the API sets on an approval it files), its payload names a kernel record, and it is pending.
import type { Paperclip, PaperclipApproval } from "./paperclip.js";
import { PaperclipError } from "./paperclip.js";
import type { Records } from "./records.js";

/** The record a mirror stands for, in its payload. */
export const MIRROR = "aidenhq_kernel_record";
/** The board's reading of the kernel's open states: review/owner/approved. */
const OPEN = new Set(["pending", "approved"]);

export interface MirrorDeps {
  pc: Pick<Paperclip, "approvals" | "createApproval" | "retireApproval" | "me">;
  records: Pick<Records, "list">;
  log: { info(o: object, m: string): void; warn(o: object, m: string): void };
}

const recordOf = (a: PaperclipApproval) => {
  const v = a.payload?.[MIRROR];
  return typeof v === "string" && v ? v : undefined;
};
/** The task a mirror was filed on: its payload names it, and the payload is all the board keeps (there is no store). */
const taskOf = (a: PaperclipApproval) => {
  const v = a.payload?.task;
  return typeof v === "string" && v ? v : undefined;
};
/** An approval already gone (someone withdrew its task, or an earlier tick retired it). */
const gone = (err: unknown) => err instanceof PaperclipError && err.status === 404;

export async function mirrorTick({ pc, records, log }: MirrorDeps): Promise<{ created: number; retired: number }> {
  const [cards, pending, boardUser] = await Promise.all([records.list("recent", { limit: 1000 }), pc.approvals("pending"), pc.me().catch(() => undefined)]);
  if (!boardUser) return { created: 0, retired: 0 }; // no identity to tell its own approvals from anyone else's
  const open = new Map(cards.filter((a) => OPEN.has(a.state) && a.issueId).map((a) => [a.id, a]));
  const mine = new Map<string, PaperclipApproval[]>();
  for (const a of pending) {
    const record = recordOf(a);
    if (!record || a.requestedByUserId !== boardUser) continue;
    mine.set(record, [...(mine.get(record) ?? []), a]);
  }
  let created = 0;
  let retired = 0;

  for (const [record, mirrors] of mine) {
    // One open record keeps exactly one mirror; the rest (a racing create, an older tick) are duplicates, and a record
    // that is no longer open keeps none.
    const keep = open.has(record) ? [mirrors[0]!] : [];
    const drop = mirrors.filter((m) => !keep.includes(m));
    for (const m of drop) {
      const task = taskOf(m);
      if (!task) {
        // Nothing to unlink by, so retires cannot be kept from waking the task: leave it and say so, rather than retire it.
        log.warn({ approval: m.id, record }, "card mirror has no task in its payload; not retired");
        continue;
      }
      try {
        await pc.retireApproval(m.id, task, `the card ${record} it stands for is ${open.has(record) ? "already mirrored" : "no longer open"}`);
        retired++;
      } catch (err) {
        if (!gone(err)) log.warn({ approval: m.id, record, err: String(err) }, "card mirror not retired; retried next tick");
      }
    }
  }

  for (const [record, card] of open) {
    if (mine.has(record)) continue;
    try {
      await pc.createApproval({
        type: "request_board_approval",
        issueIds: [card.issueId],
        // The card's own requester is the agent it stands for: the create route wants one, and this is the truthful one.
        ...(card.requesterId ? { requestedByAgentId: card.requesterId } : {}),
        payload: { [MIRROR]: record, task: card.issueId, title: `Waiting on card ${record}`, summary: `The board's card ${record} is this task's remaining work: ${card.sentence}`.slice(0, 1000) },
      });
      created++;
    } catch (err) {
      log.warn({ record, task: card.identifier, err: String(err) }, "card mirror not created; retried next tick");
    }
  }

  if (created || retired) log.info({ created, retired }, "card mirrors reconciled");
  return { created, retired };
}
