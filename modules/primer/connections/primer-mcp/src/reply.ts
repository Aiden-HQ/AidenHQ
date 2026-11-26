// primer.reply (module.yaml writes.reply), the executor side: a reply on a comment thread (primer_reply_to_thread) or marking
// it resolved (primer_resolve_thread). A reply is shown to everyone who can read the document, so it is a kernel record the AI
// reviewer decides (Tier 1) when the thread is on a document this agent published on this task (owners.ts), and the owner's
// (Tier 2) on any other. The request names the document; Tier 1 needs the owners map to say this agent published it on this
// task AND the document's comments (primer_get_comments' `comments`, or `live.comments` for a live document's own threads) (parsed as data) to hold a comment whose `thread_id` field is exactly that thread; an
// unparseable answer or no exact match is Tier 2. The document_id is for this check only: the upstream tools take just the thread. A `body` is a reply; no `body` resolves the thread.
// The card says which thread without ids: the document's title and the thread's first comment (lookup.ts, bounded), so two
// resolve cards on different documents, or two replies sending the same words, are told apart.
import type { Executor } from "./aidenhq-sdk/executor.js";
import { fileOwners, type Owners } from "./owners.js";
import { few, threadOf, type Call as Lookup } from "./lookup.js";

/** A Primer call that may name the document a thread is on (the comment loop's batches); Primer's tool doesn't take it. */
type Call = (tool: string, args: Record<string, unknown>, document?: string) => Promise<{ text: string; isError?: boolean }>;
/** A Primer write. */
export type Reply = { document_id: string; thread_id: string; body?: string };

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);

export function normaliseReply(a: any): Reply {
  const thread_id = str(a?.thread_id ?? a?.threadId);
  const document_id = str(a?.document_id ?? a?.documentId);
  if (!thread_id || !document_id) throw new Error("a reply needs a document_id and a thread_id");
  const body = str(a?.body);
  return { document_id, thread_id, ...(body ? { body } : {}) };
}

export function replier(call: Call, owners: Owners = fileOwners()): Executor {
  return {
    async plan(req) {
      const args = normaliseReply(req.args);
      const agent = req.requester?.agent;
      const owner = owners.get(args.document_id);
      // The comment check is this plan's Tier answer and its card's target: one bounded read (comments on the latest version,
      // and a live document's own threads), reused when the kernel plans the record again.
      const thread = await threadOf(call as Lookup, args.document_id, args.thread_id, req.revalidate === true);
      // Revalidation is the kernel re-planning an approved record to compare it (writes.ts runOnce); the tier was decided at
      // filing and is not decided again, so this plan keeps the filed decision rather than raising on a read it didn't make.
      const deciding = req.revalidate !== true;
      const document = owner && agent && owner.agent === agent && owner.task === req.task && thread.has ? args.document_id : undefined;
      const raise = deciding && !document ? { raise: { tier: 2 as const, rule: "primer-reply-not-own", reason: "a reply on a thread the owners map and the document's comments don't show on a document this agent published on this task" } } : {};
      const where = thread.title ? `"${thread.title}"` : "the document";
      const quoted = thread.excerpt ? ` “${thread.excerpt}”` : "";
      return {
        args,
        targets: { thread: args.thread_id, document: args.document_id },
        facts: { body: args.body ?? "", doc: document ?? "" },
        ...raise,
        card: {
          what: args.body ? `a reply on a thread in ${where}` : `resolving a thread in ${where}`,
          changes: args.body ? `Posts this reply on the comment thread${quoted}: everyone who can read ${where} sees it: “${few(args.body, 300)}”` : `Marks the comment thread${quoted} resolved.`,
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
