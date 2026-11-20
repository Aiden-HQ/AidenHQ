// Agent markdown -> Slack mrkdwn. The input is HTML-escaped first (& < >), so agent
// text can never form raw Slack links, mentions or broadcasts; only the small markdown subset below becomes formatting.
export const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/** A board's https address as a bare origin: anything else (unset, malformed) gives "" and links stay literal. */
const boardOrigin = (url?: string): string => { if (!url) return ""; try { return new URL(url).origin; } catch { return ""; } };
// An in-app route: a plain label, and a path (no host, scheme or markup) after "#/".
const ROUTE_LINK = /\[([^[\]\n<>`&*_]+)\]\(#\/([A-Za-z0-9][A-Za-z0-9\-._/]*)\)/g;

export function toSlackMrkdwn(text: string, boardUrl?: string): string {
  const board = boardOrigin(boardUrl);
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
            // An in-app route: the same visible address, resolved against the board's own configured origin.
            .replace(ROUTE_LINK, (_, label: string, route: string) => (board ? `${label} (<${board}/#/${route}>)` : `[${label}](#/${route})`))
            .replace(/\*\*([^*\n]+)\*\*/g, "*$1*")
            .replace(/__([^_\n]+)__/g, "_$1_"),
    )
    .join("");
}
