// @slack/socket-mode is CommonJS: default import, then destructure.
import socketMode from "@slack/socket-mode";
import type { Logger } from "pino";
import type { ChatMessage } from "./chat.js";
import { makeDedupe, toEvent } from "./map.js";
import type { Store } from "./store.js";

const { SocketModeClient } = socketMode;

interface Deps {
  appToken: string;
  store: Store;
  ignored: Set<string>;
  onKept: () => void;
  chat?: { ownerId: string; channel: string; deliver: (m: ChatMessage) => Promise<void> };
  tee?: (body: unknown) => void; // src_slack (sources.ts): every event, before any filter below; never throws or blocks
  log: Logger;
}

// Persist BEFORE ack: if the insert throws we do not ack, so Slack redelivers; a duplicate
// event_id is a no-op. Events during a disconnect are lost (accepted; the scout scan covers it).
export async function startSocket({ appToken, store, ignored, onKept, chat, tee, log }: Deps): Promise<void> {
  const client = new SocketModeClient({ appToken });
  const isDuplicateText = makeDedupe();
  client.on("slack_event", async (msg: { type: string; body: unknown; ack: () => Promise<void> }) => {
    if (msg.type === "events_api") tee?.(msg.body);
    try {
      // Owner's messages in the command channel are chat with the CoS, not triage events.
      const ev = (msg.body as { event?: Record<string, string> } | null)?.event;
      if (chat && msg.type === "events_api" && ev?.type === "message" && !ev.subtype && !ev.bot_id && ev.user === chat.ownerId && ev.channel === chat.channel && ev.text?.trim()) {
        if (!store.getKv(`slack_chat:${ev.ts}`)) {
          await chat.deliver({ source: "slack", text: ev.text.trim() });
          store.setKv(`slack_chat:${ev.ts}`, "1");
        }
        await msg.ack().catch(() => undefined);
        return;
      }
      const e = msg.type === "events_api" ? toEvent(msg.body, ignored) : null;
      if (e && !isDuplicateText(e) && store.insertEvent(e)) onKept();
    } catch (err) {
      log.error({ err: String(err) }, "event insert failed; not acking so Slack redelivers");
      return;
    }
    await msg.ack().catch((err: unknown) => log.warn({ err: String(err) }, "socket ack failed"));
  });
  client.on("connected", () => log.info("socket mode connected"));
  client.on("disconnected", () => log.warn("socket mode disconnected"));
  // Initial start only: 30 s doubling to 5 min. After that the client reconnects itself.
  for (let backoff = 30_000; ; backoff = Math.min(backoff * 2, 300_000)) {
    try {
      await client.start();
      return;
    } catch (err) {
      log.error({ err: String(err), retryMs: backoff }, "socket mode start failed");
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
}
