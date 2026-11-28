// The messages this service posted for an agent as the owner (slack_send_message, the summon reply). Slack sends each one back
// through the owner's user stream as an owner-authored message, so slack-live asks here before it attests a message as the
// owner's own (`from_owner`): an agent's text must never summon an agent. Kept 7 days, in the sign-in's state dir.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

const KEEP_MS = 7 * 86_400_000;
/** A message's words reduced to what survives Slack's markup (links, escapes, mentions): letters and digits, lower-cased, the first 200. */
export const textKey = (channel: string, text: string): string => `t:${channel}:${createHash("sha256").update(text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "").slice(0, 200)).digest("hex").slice(0, 24)}`;
export type Posted = {
  record: (channel: string, ts: string) => void;
  /** Before the post: its words, so the message is known the moment Slack delivers it (even before the answer returns) and a scheduled one when it arrives. */
  recordText: (channel: string, text: string) => void;
  has: (channel: string, ts: string, text?: string) => boolean;
};

export function postedStore(file: string, now = () => Date.now()): Posted {
  let seen: Record<string, number> = {};
  try { if (existsSync(file)) seen = JSON.parse(readFileSync(file, "utf8")) as Record<string, number>; } catch { seen = {}; }
  const prune = () => { for (const [k, at] of Object.entries(seen)) if (now() - at > KEEP_MS) delete seen[k]; };
  const put = (k: string) => {
    prune();
    seen[k] = now();
    try { writeFileSync(file, JSON.stringify(seen)); } catch { /* in memory still holds it */ }
  };
  const fresh = (k: string) => now() - (seen[k] ?? -Infinity) <= KEEP_MS;
  return {
    record: (channel, ts) => put(`${channel}:${ts}`),
    recordText: (channel, text) => put(textKey(channel, text)),
    has: (channel, ts, text) => fresh(`${channel}:${ts}`) || (text !== undefined && text.length > 0 && fresh(textKey(channel, text))),
  };
}

/** The tools that post a message as the owner, now or (scheduled) later. */
export const POSTING_TOOLS = new Set(["slack_send_message", "slack_schedule_message"]);

/** The channel and ts of the message a posting tool's answer names: JSON fields, or the permalink. Undefined when it names none. */
export function postedMessage(result: CallToolResult): { channel: string; ts: string } | undefined {
  const text = (result.content ?? []).map((c) => (c.type === "text" ? c.text : "")).join("\n");
  // The vendor's own fields first; a permalink only when there are none (echoed message text is untrusted data).
  const ts = text.match(/"(?:message_ts|ts|message_timestamp)"\s*:\s*"(\d+\.\d+)"/)?.[1];
  const channel = text.match(/"(?:channel|channel_id)"\s*:\s*"([A-Z0-9]+)"/)?.[1];
  if (ts && channel) return { channel, ts };
  const link = text.match(/\/archives\/([A-Z0-9]+)\/p(\d{10})(\d{6})/);
  return link ? { channel: link[1]!, ts: `${link[2]}.${link[3]}` } : undefined;
}
