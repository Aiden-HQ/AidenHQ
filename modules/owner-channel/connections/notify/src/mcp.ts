import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { waitingDigest } from "./attention.js";
import { KINDS, fence, notify, type Caller, type Deps } from "./notify.js";

const json = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v) }] });

export function buildServer(d: Deps, caller?: Caller): McpServer {
  const server = new McpServer({ name: "owner-channel", version: "0.1.0" }, { instructions: "The one way to message the owner: on their chat on the board and on their phone (Slack or Telegram)." });
  server.registerTool(
    "notify",
    {
      description:
        "Message the owner. It reaches them once: with `task`, as your visible reply in that chat on the board, and on their phone (the channel they last wrote from in that chat, else their Slack DM or Telegram). **bold**, `code`, - bullets and task IDs render. kind: decision (a question for them; any message with questions is one; never held back by the limit: it reaches the owner directly only on a task they are talking to you on, otherwise the chief of staff settles it and its answer comes as a comment on your task), done (a finished result), fyi (news they needn't act on; they may mute these), alert (something is wrong now and needs them: one per dedupe_key an hour, so give each incident its own key and a new key when it gets worse), digest (a routine's one summary). The same message (or the same dedupe_key, from any agent) within 10 minutes goes once. With `task` (your current chat), send one reply per turn, last; keep run notes for the log. At most 5 messages about one task between the owner's own messages there (and per UTC day): past that it returns reason \"limit\" and sends nothing, so batch updates.",
      // Strict: a misspelled field (e.g. "questions:") is an error the agent sees and fixes, not silently dropped.
      inputSchema: z.strictObject({
        kind: z.enum(KINDS as [string, ...string[]]),
        text: z.string().min(1).max(3000),
        task: z.string().regex(/^[A-Z][A-Z0-9]*-\d+$/).optional().describe("the chat (task identifier, e.g. WOR-123) this message is about: your name heads it and the owner's reply lands on that task. Pass your current task."),
        dedupe_key: z.string().min(1).max(200).optional().describe("one message per key: e.g. the Slack thread an alert is about (slack:<channel>:<thread_ts>). Another sender's message with the same key in the window is dropped."),
        questions: z
          .array(z.object({ question: z.string().min(1).max(300), options: z.array(z.string().min(1).max(80)).min(2).max(5), multi: z.boolean().optional() }))
          .min(1)
          .max(4)
          .optional()
          .describe("multiple-choice questions for the owner, asked with this message (put the context in `text`, the questions here, not both): the recommended option first; they can always answer in their own words instead, so don't add an \"Other\" option. multi: they may pick several. On the board each becomes a form; their phone gets them spelled out."),
        actions: z.array(z.string().min(1).max(40)).max(4).optional().describe("up to 4 one-tap answers. A press sends the label as the owner's own message (e.g. \"Apply WOR-184\"), so write each label as the exact words they'd type."),
      }),
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async (args) => {
      return json(await notify(d, args as Parameters<typeof notify>[1], caller));
    },
  );
  server.registerTool(
    "notify_recent",
    {
      description: "What the owner was already told, newest first: who sent it, the task, its kind, whether it was delivered or still waits in their next digest (queued), when, and the text. Glance at it before telling them something, so you tell only what is new to them. To read further back, pass the last row's `cursor` as `before`; `state` keeps only delivered or only queued rows.",
      inputSchema: z.strictObject({
        days: z.number().int().min(1).max(14).optional().describe("how far back (default 3)"),
        limit: z.number().int().min(1).max(50).optional().describe("how many (default 20)"),
        before: z.string().regex(/^\d{4}-\d\d-\d\dT[\d:.]+Z(#\d+)?$/).optional().describe("only rows after this one in the list: the last row's `cursor` from the page before"),
        state: z.enum(["delivered", "queued"]).optional().describe("only delivered rows, or only those waiting in the next digest"),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    // Delivered rows from the ledger plus the digest lines still waiting (read live from the queue). Texts are agents' and
    // people's words: fenced as data.
    // Newest first, ties by the ledger's id (a digest writes many rows in one instant): a row's `cursor` is where the next page starts.
    async ({ days, limit, before, state }) => {
      const since = Date.now() - (days ?? 3) * 86_400_000;
      const [t, id] = before ? [Date.parse(before.split("#")[0]!), Number(before.split("#")[1] ?? Infinity)] : [Infinity, Infinity];
      const rows = [...d.store.recentTold(days ?? 3, 5000).map((r) => ({ ...r, n: Number(r.id), state: "delivered" })), ...waitingDigest(d.store).filter((r) => r.at >= since).map((r) => ({ ...r, n: 0, state: "queued" }))]
        .filter((r) => (r.at < t || (r.at === t && r.n < id)) && (!state || r.state === state))
        .sort((x, y) => y.at - x.at || y.n - x.n).slice(0, limit ?? 20);
      return json(rows.map((r) => ({ source: r.source, task: r.task, kind: r.kind, state: r.state, at: new Date(r.at).toISOString(), cursor: `${new Date(r.at).toISOString()}#${r.n}`, text: fence(r.text) })));
    },
  );
  return server;
}
