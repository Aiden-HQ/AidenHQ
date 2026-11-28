// The messages this service posted for an agent as the owner (slack_send_message, the summon reply). Slack sends each one back
// through the owner's user stream as an owner-authored message, so slack-live asks here before it attests a message as the
// owner's own (`from_owner`): an agent's text must never summon an agent. Kept 7 days, in the sign-in's state dir.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

const KEEP_MS = 7 * 86_400_000;
/** How long a send is "in flight": Slack may deliver the message before the answer that names its ts returns. */
const SENDING_MS = 40_000; // longer than the relay's 30 s Slack call
/** A scheduled post is delivered about its post_at: a message in that channel this close to it is the scheduled one. */
const SCHEDULE_SLACK_SEC = 120;
/** A message's words reduced to what survives Slack's markup (links, escapes, mentions): letters and digits, lower-cased, the first 200. */
export const textKey = (channel: string, text: string): string => `${channel}:${createHash("sha256").update(text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "").slice(0, 200)).digest("hex").slice(0, 24)}`;
export type Posted = {
  /** The message Slack confirmed (channel and ts): known for 7 days. */
  record: (channel: string, ts: string) => void;
  /** A send that has started, by its words: matched only for the few seconds until its ts is recorded. */
  sending: (channel: string, text: string) => void;
  /** A scheduled post, by channel and delivery time (unix seconds): known until a day after it is due, so until it is delivered. */
  scheduled: (channel: string, postAt: number) => void;
  has: (channel: string, ts: string, text?: string) => boolean;
};

export function postedStore(file: string, now = () => Date.now()): Posted {
  // Persisted: key -> when it stops counting (ms). In memory only: sends in flight.
  let seen: Record<string, number> = {};
  try { if (existsSync(file)) seen = JSON.parse(readFileSync(file, "utf8")) as Record<string, number>; } catch { seen = {}; }
  const inflight = new Map<string, number>();
  const put = (k: string, until: number) => {
    for (const [key, u] of Object.entries(seen)) if (u < now()) delete seen[key];
    seen[k] = until;
    try { writeFileSync(file, JSON.stringify(seen)); } catch { /* in memory still holds it */ }
  };
  return {
    record: (channel, ts) => put(`m:${channel}:${ts}`, now() + KEEP_MS),
    sending: (channel, text) => void (inflight.forEach((u, k) => u < now() && inflight.delete(k)), inflight.set(textKey(channel, text), now() + SENDING_MS)),
    scheduled: (channel, postAt) => put(`s:${channel}:${Math.floor(postAt)}`, postAt * 1000 + 86_400_000),
    has: (channel, ts, text) => {
      if ((seen[`m:${channel}:${ts}`] ?? 0) >= now()) return true;
      if (text && (inflight.get(textKey(channel, text)) ?? 0) >= now()) return true;
      return Object.entries(seen).some(([k, until]) => {
        const [kind, ch, at] = k.split(":");
        return kind === "s" && ch === channel && until >= now() && Math.abs(Number(ts) - Number(at)) <= SCHEDULE_SLACK_SEC;
      });
    },
  };
}

/** A scheduled post's delivery time in unix seconds, from the tool's `post_at` (a number, digits, or a date). */
export function postAt(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" && /^\d+(\.\d+)?$/.test(v) ? Number(v) : typeof v === "string" && /(Z|[+-]\d\d:?\d\d)$/.test(v) ? Date.parse(v) / 1000 : NaN;
  return Number.isFinite(n) && n > 0 ? n : undefined;
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
