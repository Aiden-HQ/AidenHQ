// @slack/socket-mode is CommonJS: default import, then destructure.
import socketMode from "@slack/socket-mode";
import type { Logger } from "pino";
import { toSourceEvent, type Route, type SourceEvent } from "./map.js";
import { carriesCode } from "./pair.js";
import type { Store } from "./store.js";

const { SocketModeClient } = socketMode;

interface Deps {
  appToken: string;
  store: Store;
  /** The owner's own messages in their command channel (the paired DM): chat with Aiden, posted as the owner by the kernel. */
  chat?: { owner: () => { user: string; channel: string } | undefined; deliver: (text: string) => Promise<void> };
  /** A pairing DM (pair.ts): true when it was one, and then it goes no further. `ack` lets it acknowledge as soon as the
   * decision is durable, so posting the reply never holds the ack past Slack's 3 s deadline. */
  pair?: (body: unknown, ack: () => Promise<void>) => Promise<boolean>;
  /** Channel binding (bind.ts): `/aiden …` answered to the person who typed it. A bound channel's @mentions are classified in map.ts. */
  bind?: { command: (body: any) => Promise<string> };
  /** Where a message is addressed (map.ts), read per event: the instance bot's route. */
  route?: () => Route;
  /** Looks up who an owner's own DM is with (it throws when it can't, so the event is redelivered, never classified without it). */
  learnDm?: (channel: string) => Promise<void>;
  tee?: (body: unknown) => void; // src_slack (sources.ts): every event that is not a pairing DM; never throws or blocks
  /** The kernel's event router (POST /v1/events): throws only when the kernel didn't take it (transport, 429, 5xx). */
  forward?: (e: SourceEvent) => Promise<void>;
  /** The socket's real connection state, for /healthz: connected, or disconnected (and not yet reconnected). */
  onState?: (s: "connected" | "disconnected") => void;
  log: Logger;
}

/** What an inbound event is, for the ingress line: its shape only, never the text, the users, a code or a token. */
export function ingressLine(msgType: string, body: unknown): Record<string, string> | undefined {
  if (msgType !== "events_api") return undefined;
  const b = body as { event?: Record<string, string>; event_id?: string } | null;
  const ev = b?.event;
  if (!ev) return undefined;
  const line: Record<string, string> = {};
  if (ev.type) line.type = ev.type;
  if (ev.channel_type) line.channel_type = ev.channel_type;
  if (ev.subtype) line.subtype = ev.subtype;
  if (b?.event_id) line.event_id = b.event_id;
  return line;
}

/** A running Socket Mode consumer for one app token: `stop` closes it (and ends a start that is still retrying) and resolves once it is down. */
export interface Listener {
  stop: () => Promise<void>;
}

/**
 * One Socket Mode connection: `onEvent` gets every envelope and decides about the ack. The connect and disconnect states are
 * reported (a routine refresh closes the socket and reconnects without a "disconnected", so "close" drops the state too).
 */
export function listen({ appToken, onEvent, onState, log }: { appToken: string; onEvent: (msg: { type: string; body: unknown; ack: () => Promise<void> }) => Promise<void>; onState?: Deps["onState"]; log: Logger }): Listener {
  const client = new SocketModeClient({ appToken });
  let stopped = false;
  client.on("slack_event", (msg: { type: string; body: unknown; ack: () => Promise<void> }) => (stopped ? Promise.resolve() : onEvent(msg)));
  client.on("connected", () => { onState?.("connected"); log.info("socket mode connected"); });
  const down = (why: string) => { onState?.("disconnected"); log.warn(why); };
  client.on("disconnected", () => down("socket mode disconnected"));
  client.on("close", () => down(stopped ? "socket mode stopped" : "socket mode closed; reconnecting"));
  // Initial start only: 30 s doubling to 5 min. After that the client reconnects itself.
  const running = (async () => {
    for (let backoff = 30_000; !stopped; backoff = Math.min(backoff * 2, 300_000)) {
      try {
        await client.start();
        return;
      } catch (err) {
        if (stopped) return;
        log.error({ err: String(err), retryMs: backoff }, "socket mode start failed");
        await new Promise((r) => setTimeout(r, backoff));
      }
    }
  })();
  return {
    async stop() {
      stopped = true;
      await running.catch(() => undefined);
      await (client as unknown as { disconnect?: () => Promise<unknown> }).disconnect?.().catch(() => undefined);
      onState?.("disconnected");
    },
  };
}

// Persist BEFORE ack: if the insert throws we do not ack, so Slack redelivers; a duplicate
// event_id is a no-op. Events during a disconnect are lost (accepted; the scout scan covers it).
export function startSocket({ appToken, store, chat, pair, bind, route, learnDm, tee, forward, onState, log }: Deps): Listener {
  return listen({ appToken, onState, log, onEvent: async (msg) => {
    // Before any filter: "a DM arrived" is observable, whatever the pairing, chat and routing rules then do with it.
    const ingress = ingressLine(msg.type, msg.body);
    if (ingress) log.info(ingress, "slack event in");
    if (msg.type === "slash_commands" && bind) {
      // Acked at once (Slack allows 3 s); the answer is private to the sender, through the command's response_url.
      await msg.ack().catch(() => undefined);
      const b = msg.body as { command?: string; response_url?: string };
      if (b.command !== "/aiden" || !b.response_url) return;
      const text = await bind.command(b).catch((err: unknown) => `Not done: ${String(err)}`);
      await fetch(b.response_url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ response_type: "ephemeral", text }) }).catch((err: unknown) => log.warn({ err: String(err) }, "slash response failed"));
      return;
    }
    // A button press (the push test's inert buttons, send.ts): acknowledged, nothing else.
    if (msg.type === "interactive") return void (await msg.ack().catch(() => undefined));
    try {
      // A pairing DM acks itself once its decision is durable (or leaves the event unacked to be retried).
      if (msg.type === "events_api" && pair && (await pair(msg.body, () => msg.ack()))) return;
      // Owner's messages in the command channel are chat with the CoS, not triage events.
      const ev = (msg.body as { event?: Record<string, string> } | null)?.event;
      // A pairing code that did not pair (a DM the bot can't see) is still a live credential: never stored or forwarded as
      // chat. An edit carries its new text under `message` (carriesCode checks both) and may arrive with no channel_type, so
      // unknown counts as possibly a DM; only a public or group channel keeps the same shape as ordinary text.
      if (msg.type === "events_api" && ev?.channel_type !== "channel" && ev?.channel_type !== "group" && carriesCode(ev)) {
        await msg.ack().catch(() => undefined);
        return;
      }
      if (msg.type === "events_api") tee?.(msg.body);
      const owner = chat?.owner();
      if (chat && owner?.channel && msg.type === "events_api" && ev?.type === "message" && !ev.subtype && !ev.bot_id && ev.user === owner.user && ev.channel === owner.channel && ev.text?.trim()) {
        if (!store.getKv(`slack_chat:${ev.ts}`)) {
          await chat.deliver(ev.text.trim());
          store.setKv(`slack_chat:${ev.ts}`, "1");
        }
        await msg.ack().catch(() => undefined);
        return;
      }
      // Routines' events (bot posts too, flagged), and the messages addressed to one of our bots (`to_agent`, classified once here:
      // owner command DM, bound channel, addressed bot, else plain): a kernel that didn't take it leaves the envelope unacked, so Slack redelivers.
      // The owner's own DM (a user-token event, no bot among its authorizations) may be with an agent's app: who it is with is known first.
      const auths = (msg.body as { authorizations?: { is_bot?: boolean }[] } | null)?.authorizations ?? [];
      if (learnDm && msg.type === "events_api" && ev?.type === "message" && ev.channel_type === "im" && ev.channel && ev.channel !== owner?.channel && !auths.some((a) => a?.is_bot === true)) await learnDm(ev.channel);
      const source = msg.type === "events_api" ? toSourceEvent(msg.body, owner?.user, { ...route?.(), ...(owner?.channel ? { ownerChannel: owner.channel } : {}) }) : null;
      if (source && forward) await forward(source);
    } catch (err) {
      log.error({ err: String(err) }, "event forward failed; not acking so Slack redelivers");
      return;
    }
    await msg.ack().catch((err: unknown) => log.warn({ err: String(err) }, "socket ack failed"));
  } });
}
