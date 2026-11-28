// Agent markdown -> Slack mrkdwn. The input is HTML-escaped first (& < >), so agent
// text can never form raw Slack links, mentions or broadcasts; only the small markdown subset below becomes formatting.
export const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/** A board's https address as a bare origin: anything else (unset, malformed) gives "" and links stay literal. */
const boardOrigin = (url?: string): string => { if (!url) return ""; try { return new URL(url).origin; } catch { return ""; } };
// An in-app route: a plain label, and a path (no host, scheme or markup) after "#/".
const ROUTE_LINK = /\[([^[\]\n<>`&*_]+)\]\(#\/([A-Za-z0-9][A-Za-z0-9\-._/]*)\)/g;

const TABLE_ROW = /^[ \t]*\|.*\|[ \t]*$/;
const TABLE_RULE = /^[ \t]*\|[\s:|-]+\|[ \t]*$/;

/** The one markdown subset agents write (**bold**, _italic_, `code`, [text](url), "- " bullets, "> " quotes, paragraphs) as Slack
 * mrkdwn; headers become bold lines and tables plain lines. `labelled` makes `[text](url)` Slack's `<url|text>` (a message an
 * agent posts into a chat); otherwise the real address stays visible (a message to the owner: no label that could hide it). */
export function toSlackMrkdwn(text: string, o: { boardUrl?: string; labelled?: boolean; keepTokens?: boolean } = {}): string {
  if (o.keepTokens) {
    // The bot's own channel posts: Slack's `<@U1>` / `<#C1>` / `<url|label>` tokens the agent wrote stay as written (the caller has stripped `<!…>`).
    const kept: string[] = [];
    const marked = text.replace(/<[@#]?[^<>\s|]+(?:\|[^<>\n]*)?>/g, (t) => `\u0000${kept.push(t) - 1}\u0000`);
    return toSlackMrkdwn(marked, { ...o, keepTokens: false }).replace(/\u0000(\d+)\u0000/g, (_, n: string) => kept[Number(n)]!);
  }
  const board = boardOrigin(o.boardUrl);
  // Code (fenced and inline) is kept as written; everything between is converted.
  return escape(text)
    .split(/(```[\s\S]*?```|`[^`\n]+`)/)
    .map((part, i) =>
      i % 2 === 1
        ? part
        : part
            .split("\n")
            .flatMap((line) => (TABLE_RULE.test(line) ? [] : TABLE_ROW.test(line) ? [line.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim()).filter(Boolean).join(" · ")] : [line]))
            .join("\n")
            .replace(/^[ \t]*#{1,6}[ \t]+(.+?)[ \t]*$/gm, "*$1*")
            .replace(/^([ \t]*)[-*][ \t]+/gm, "$1• ")
            .replace(/^[ \t]*&gt;[ \t]?/gm, "> ") // a quote: Slack's own syntax is a literal ">" (escaping made it "&gt;")
            .replace(/\[([^\]\n|]+)\]\((https?:\/\/[^\s)"<>|]+)\)/g, (_, label: string, url: string) => (o.labelled ? `<${url}|${label}>` : `${label} (<${url}>)`))
            // An in-app route: the same visible address, resolved against the board's own configured origin.
            .replace(ROUTE_LINK, (_, label: string, route: string) => (board ? `${label} (<${board}/#/${route}>)` : `[${label}](#/${route})`))
            .replace(/\*\*([^*\n]+)\*\*/g, "*$1*")
            .replace(/__([^_\n]+)__/g, "_$1_"),
    )
    .join("");
}
