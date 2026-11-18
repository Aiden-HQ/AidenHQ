import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { KINDS, notify, type Caller, type Deps } from "./notify.js";

const json = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v) }] });

export function buildServer(d: Deps, caller?: Caller, trial = false): McpServer {
  const server = new McpServer({ name: "owner-channel", version: "0.1.0" }, { instructions: "The one way to message the owner: on their chat on the board and on their phone (Slack or Telegram)." });
  server.registerTool(
    "notify",
    {
      description:
        "Message the owner. It reaches them once: with `task`, as your visible reply in that chat on the board, and on their phone (the channel they last wrote from in that chat, else their Slack DM or Telegram). **bold**, `code`, - bullets and task IDs render. kind: decision (needs their answer or approval; any message with questions is one; never held back by the limit), done (a finished result), fyi (news they needn't act on; they may mute these), alert (something is wrong now and needs them: one per dedupe_key an hour, so give each incident its own key and a new key when it gets worse), digest (a routine's one summary). The same message (or the same dedupe_key, from any agent) within 10 minutes goes once. With `task` (your current chat), send one reply per turn, last; keep run notes for the log. At most 5 messages about one task between the owner's own messages there (and per UTC day): past that it returns reason \"limit\" and sends nothing, so batch updates.",
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
      // An agent in trial reaches the owner and nothing else: `task` would route the message into that task's chat.
      if (trial && args.task !== undefined) return json({ sent: false, reason: "in trial, notify reaches only the owner: `task` would route it into a task chat, so nothing was sent. Send the text to the owner without it." });
      return json(await notify(d, args as Parameters<typeof notify>[1], caller));
    },
  );
  return server;
}
