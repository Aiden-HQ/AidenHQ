// primer.reply (module.yaml writes.reply), the executor side: a reply on a comment thread (primer_reply_to_thread) or marking
// it resolved (primer_resolve_thread). A reply is shown to everyone who can read the document, so it is a kernel record the AI
// reviewer decides (Tier 1) when the thread is on a document this agent published on this task (owners.ts), and the owner's
// (Tier 2) on any other. The request names the document; Tier 1 needs the owners map to say this agent published it on this
// task AND the document's comments (primer_get_comments' `comments` array) (parsed as data) to hold a comment whose `thread_id` field is exactly that thread; an
// unparseable answer or no exact match is Tier 2. The document_id is for this check only: the upstream tools take just the thread. A `body` is a reply; no `body` resolves the thread.
import type { Executor } from "./aidenhq-sdk/executor.js";
import { fileOwners, type Owners } from "./owners.js";

/** A Primer write; `document` names the document a thread reply is on (the comment loop's batches), which Primer's tool doesn't take. */
type Call = (tool: string, args: Record<string, unknown>, document?: string) => Promise<{ text: string; isError?: boolean }>;
export type Reply = { document_id: string; thread_id: string; body?: string };

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);

export function normaliseReply(a: any): Reply {
  const thread_id = str(a?.thread_id ?? a?.threadId);
  const document_id = str(a?.document_id ?? a?.documentId);
  if (!thread_id || !document_id) throw new Error("a reply needs a document_id and a thread_id");
  const body = str(a?.body);
  return { document_id, thread_id, ...(body ? { body } : {}) };
}

/** True when the parsed answer's `comments` array holds a comment whose `thread_id` field is exactly the id (text in a comment body never counts). */
const hasThread = (answer: any, id: string) => Array.isArray(answer?.comments) && answer.comments.some((c: any) => c?.thread_id === id);

export function replier(call: Call, owners: Owners = fileOwners()): Executor {
  return {
    async plan(req) {
      const args = normaliseReply(req.args);
      const agent = req.requester?.agent;
      let document: string | undefined;
      const owner = owners.get(args.document_id);
      if (owner && agent && owner.agent === agent && owner.task === req.task) {
        const r = await call("primer_get_comments", { documentId: args.document_id }).catch(() => undefined);
        try {
          if (r && !r.isError && hasThread(JSON.parse(r.text), args.thread_id)) document = args.document_id;
        } catch {}
      }
      return {
        args,
        targets: { thread: args.thread_id, document: args.document_id },
        facts: { body: args.body ?? "", doc: document ?? "" },
        ...(document ? {} : { raise: { tier: 2 as const, rule: "primer-reply-not-own", reason: "a reply on a thread the owners map and the document's comments don't show on a document this agent published on this task" } }),
        card: {
          what: args.body ? "a reply on a Primer thread" : "resolving a Primer thread",
          changes: args.body ? `Posts this reply on the comment thread; everyone who can read the document sees it: “${args.body.length > 300 ? `${args.body.slice(0, 300)}…` : args.body}”` : "Marks the comment thread resolved."`,
        },
      };
    },
    async execute(rec) {
      const a = normaliseReply(rec.args);
      const r = await (a.body ? call("primer_reply_to_thread", { thread_id: a.thread_id, body: a.body }, a.document_id) : call("primer_resolve_thread", { thread_id: a.thread_id }, a.document_id))
        .catch((e: Error) => ({ text: `outcome unknown (${e.message}): read the thread on Primer before replying again`, isError: true }));
      return r.isError ? { ok: false, text: r.text.slice(0, 2000) } : { ok: true, text: a.body ? `Replied on thread ${a.thread_id}.` : `Resolved thread ${a.thread_id}.` };
    },
  };
}
