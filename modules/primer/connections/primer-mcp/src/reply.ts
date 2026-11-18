// primer.reply (module.yaml writes.reply), the executor side: a reply on a comment thread (primer_reply_to_thread) or marking
// it resolved (primer_resolve_thread). A reply is shown to everyone who can read the document, so it is a kernel record the AI
// reviewer decides (Tier 1) when the thread is on a document this agent published on this task (owners.ts), and the owner's
// (Tier 2) on any other. The thread's document is found by reading the comments of the documents this agent published, never
// from the request. A `body` is a reply; no `body` resolves the thread.
import type { Executor } from "./aidenhq-sdk/executor.js";
import { fileOwners, type Owners } from "./owners.js";

type Call = (tool: string, args: Record<string, unknown>) => Promise<{ text: string; isError?: boolean }>;
export type Reply = { thread_id: string; body?: string };

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);

export function normaliseReply(a: any): Reply {
  const thread_id = str(a?.thread_id ?? a?.threadId);
  if (!thread_id) throw new Error("a reply needs a thread_id");
  const body = str(a?.body);
  return { thread_id, ...(body ? { body } : {}) };
}

export function replier(call: Call, owners: Owners = fileOwners()): Executor {
  return {
    async plan(req) {
      const args = normaliseReply(req.args);
      const agent = req.requester?.agent;
      let document: string | undefined;
      if (agent && req.task) {
        for (const id of owners.documentsOf({ agent, task: req.task })) {
          const r = await call("primer_get_comments", { documentId: id }).catch(() => undefined);
          if (r && !r.isError && r.text.includes(args.thread_id)) { document = id; break; }
        }
      }
      return {
        args,
        targets: { thread: args.thread_id, ...(document ? { document } : {}) },
        facts: { body: args.body ?? "", doc: document ?? "" },
        ...(document ? {} : { raise: { tier: 2 as const, rule: "primer-reply-not-own", reason: "a reply on a thread of a document this agent didn't publish on this task" } }),
        card: {
          what: args.body ? "a reply on a Primer thread" : "resolving a Primer thread",
          changes: args.body ? `Posts this reply on thread ${args.thread_id}; everyone who can read the document sees it.` : `Marks thread ${args.thread_id} resolved.`,
        },
      };
    },
    async execute(rec) {
      const a = normaliseReply(rec.args);
      const r = await (a.body ? call("primer_reply_to_thread", { thread_id: a.thread_id, body: a.body }) : call("primer_resolve_thread", { thread_id: a.thread_id }))
        .catch((e: Error) => ({ text: `outcome unknown (${e.message}): read the thread on Primer before replying again`, isError: true }));
      return r.isError ? { ok: false, text: r.text.slice(0, 2000) } : { ok: true, text: a.body ? `Replied on thread ${a.thread_id}.` : `Resolved thread ${a.thread_id}.` };
    },
  };
}
