// slack as a transport of the owner's router (owner-channel): POST /transport/send is one message as a DM to the owner
// from the instance's bot (the owner is the paired Slack user). Agent text is rendered through a small mrkdwn subset with
// everything else escaped, so it can't form links, mentions or broadcasts.
import { escape, toSlackMrkdwn } from "./mrkdwn.js";

export interface SlackConfig {
  botToken: string;
  ownerId: string;
  boardUrl?: string; // the board's https address (BOARD_LAN_URL): in-app `#/route` links resolve against it
}
/** What owner-channel sends (its Message): the text as the agent wrote it, and the chat it belongs to. */
export type Message = { kind: string; text: string; head?: { agent: string; task: string; issue: string };
  /** The push test's buttons (the kernel's /v1/notify/test): shown, and a press is acknowledged and nothing else (socket.ts). */
  inert?: string[] };

// & < > start link/mention syntax; *_~` are neutralised with a zero-width space so senders can't restyle the DM.
export function escapeMrkdwn(s: string): string {
  return escape(s).replace(/([*_~`])/g, "$1​");
}

/** An alert: a STOP header; a leading "[C123] " becomes a channel mention. */
export function alertBlocks(text: string): Record<string, unknown>[] {
  const prefix = text.match(/^\[([CGD][A-Z0-9]+)\]\s*/);
  const summary = prefix ? `<#${prefix[1]}> · ${escapeMrkdwn(text.slice(prefix[0].length))}` : escapeMrkdwn(text);
  return [
    { type: "header", text: { type: "plain_text", text: "🚨 STOP — needs you NOW" } },
    { type: "section", text: { type: "mrkdwn", text: summary.slice(0, 2900) } },
  ];
}

export async function postMessage(cfg: SlackConfig, payload: Record<string, unknown>): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: { authorization: `Bearer ${cfg.botToken}`, "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ channel: cfg.ownerId, unfurl_links: false, unfurl_media: false, ...payload }),
    });
    if (res.status === 429 && attempt === 0) {
      await new Promise((r) => setTimeout(r, Math.min(Number(res.headers.get("retry-after") ?? 1), 30) * 1000));
      continue;
    }
    return res.ok && ((await res.json()) as { ok?: boolean }).ok === true;
  }
  return false;
}

/** One owner message as a Slack DM: off when no bot or no paired owner (owner-channel tries its next channel). */
export async function transportSend(cfg: SlackConfig, m: Message): Promise<{ sent: boolean; off?: true }> {
  if (!cfg.botToken || !cfg.ownerId) return { sent: false, off: true };
  const head = m.head ? `*${escapeMrkdwn(m.head.agent)}* · ${m.head.task}\n` : "";
  const text = head + toSlackMrkdwn(m.text, cfg.boardUrl);
  const payload = m.kind === "alert" ? { text: escapeMrkdwn(m.text), blocks: alertBlocks(m.text) }
    : m.inert?.length ? { text, blocks: [{ type: "section", text: { type: "mrkdwn", text } }, { type: "actions", elements: m.inert.slice(0, 3).map((t, i) => ({ type: "button", action_id: `inert:${i}`, text: { type: "plain_text", text: String(t).slice(0, 40) } })) }] }
    : { text };
  return { sent: await postMessage(cfg, payload).catch(() => false) };
}
