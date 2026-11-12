// Agent markdown -> Slack mrkdwn, and the leaked-"placeholder" guard. The input is HTML-escaped first (& < >), so agent
// text can never form raw Slack links, mentions or broadcasts; only the small markdown subset below becomes formatting.
// Telegram has its own renderer (telegram.ts).
import { escape } from "./telegram.js";

export function toSlackMrkdwn(text: string): string {
  // Code (fenced and inline) is kept as written; everything between is converted.
  return escape(text)
    .split(/(```[\s\S]*?```|`[^`\n]+`)/)
    .map((part, i) =>
      i % 2 === 1
        ? part
        : part
            .replace(/^[ \t]*#{1,6}[ \t]+(.+?)[ \t]*$/gm, "*$1*")
            .replace(/^([ \t]*)[-*][ \t]+/gm, "$1• ")
            .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)"<>|]+)\)/g, "$1 (<$2>)") // the real address stays visible: no labelled links that could hide it
            .replace(/\*\*([^*\n]+)\*\*/g, "*$1*")
            .replace(/__([^_\n]+)__/g, "_$1_"),
    )
    .join("");
}

// Some agents fill a required `text` with the word "placeholder" (the real message in `questions`, or after it): it must never reach the owner.
export function stripPlaceholder(text: string): string {
  return text.replace(/^\s*placeholder\b[\s:.\-–—]*/i, "").trim();
}
