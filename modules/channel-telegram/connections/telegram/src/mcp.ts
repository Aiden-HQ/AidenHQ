import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Store } from "./store.js";
import { notifyOwner, type NotifyCaller, type NotifyConfig } from "./urgent.js";

const json = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v) }] });

export function buildServer(store: Store, cfg: NotifyConfig, caller?: NotifyCaller, trial = false): McpServer {
  const server = new McpServer(
    { name: "telegram", version: "0.1.0" },
    { instructions: "Messages to the owner on Telegram and on their chat on the board." },
  );
  server.registerTool(
    "notify_owner",
    {
      description:
        "Message the owner (and, with `task`, on their chat on the board). priority=normal goes to their Slack DM when Slack is set up, else Telegram; priority=urgent: STOP-style alert, at most one per 60 min per thread (pass channel_id + ts, and thread_ts if any) unless you pass `escalate` (a short reason the thread got worse since its last page: a new development, not a repeat), which pages again. priority=normal: a message; Telegram renders **bold**, `code`, - bullets and links task IDs; an identical message within 10 min is sent once. With `task` (your current chat), the message is also your visible reply in that chat on the board: send one per turn, and keep run notes and status comments for the log. When the owner is chatting with you, every reply to them goes through this (with `task`), never a plain task comment: comments are folded away as working notes. kind: decision (needs the owner's answer or approval; any message with questions is one), done (a finished result; the default) or fyi (news they needn't act on; the owner may mute these on Telegram). At most 5 messages about one task between the owner's own messages there (and per UTC day): past that it returns reason \"limit\" and sends nothing, so batch updates. A decision is never limited: use it only for what truly needs them.",
      // Strict: a misspelled field (e.g. "questions:") is an error the agent sees and fixes, not silently dropped.
      inputSchema: z.strictObject({
        text: z.string().min(1).max(3000),
        priority: z.enum(["urgent", "normal"]),
        permalink: z.string().optional(),
        channel_id: z.string().optional(),
        thread_ts: z.string().optional(),
        ts: z.string().optional(),
        received_at: z.number().optional(),
        channel: z.enum(["telegram", "slack", "both", "board"]).optional().describe("normal priority only: where to send. Default (\"both\" or \"slack\"): their Slack DM when Slack is set up, else Telegram (one message, never both), and the chat with `task`; \"telegram\": Telegram. \"board\": only on the chat (with `task`). A chat they last wrote in on the board always gets its replies there only"),
        escalate: z.string().min(1).max(200).optional().describe("urgent only: what changed since the thread was last paged (it got worse, spread, a second incident, customer impact). Pages through the 60-minute cooldown; leave it out for a repeat."),
        task: z.string().regex(/^[A-Z][A-Z0-9]*-\d+$/).optional().describe("the chat (task identifier, e.g. WOR-123) this message is about: your name heads the message and the owner's reply lands on that task. Pass your current task."),
        kind: z.enum(["decision", "done", "fyi"]).optional().describe("normal priority: decision (needs the owner; never held back by the limit), done (a finished result; the default) or fyi (news; the owner may mute these on Telegram). Messages with `questions` are decisions."),
        questions: z
          .array(z.object({ question: z.string().min(1).max(300), options: z.array(z.string().min(1).max(80)).min(2).max(5), multi: z.boolean().optional() }))
          .min(1)
          .max(4)
          .optional()
          .describe("multiple-choice questions for the owner, asked with this message (put the context in `text`, the questions here, not both): the recommended option first; they can always answer in their own words instead, so don't add an \"Other\" option. multi: they may pick several. On the board each becomes a form they answer in one go; Telegram and Slack get them spelled out."),
        actions: z.array(z.string().min(1).max(40)).max(4).optional().describe("normal priority, Telegram: up to 4 one-tap buttons. A press sends the label as the owner's own message (e.g. \"Apply WOR-184\"), so write each label as the exact words they'd type."),
      }),
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async (args) => {
      // An agent in trial reaches the owner and nothing else: `task` routes the message into that task's chat (and its
      // agent's), and the rest name a Slack message or thread elsewhere (an alert's source, a thread's cooldown, a link).
      // Every one of them is refused before anything is sent; a plain message to the owner is the only allowed path.
      if (trial) {
        const elsewhere = (["task", "channel_id", "thread_ts", "ts", "permalink"] as const).filter((k) => args[k] !== undefined);
        if (elsewhere.length)
          return json({ sent: false, reason: `in trial, notify_owner reaches only the owner: ${elsewhere.join(", ")} would route it into a task chat or a Slack message or thread elsewhere, so nothing was sent. Send the text to the owner without it.` });
      }
      return json(await notifyOwner(store, cfg, args, Date.now(), caller));
    },
  );
  return server;
}
