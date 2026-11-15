// Live board updates (server-sent events): what the board itself changes (approval records, grading state, comments and
// tasks it posts, Fleet Ops ticks) is announced to every open board as a named event, so the views refetch at once instead
// of on their next poll. Events carry names and ids only, never content; the reader refetches through the usual routes.
// One hub per Store: the local, LAN and internal listeners share it, so a Telegram decision (internal) reaches the board.
// Other code emits through `store.events.emit`: what agents change in Paperclip arrives through the live watch (watch.ts).
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * The names a board view listens for. approvals: a card was filed, decided, claimed or finished (also the needs-you badge);
 * chat: a chat changed (a message, its state, its run, or the work handed out from it; `issue` is the chat's id); tasks: a
 * task changed or its run started or ended (`issue` is its id); progress: a run on that task (or one handed out from that
 * chat) said more, for its live words; grades: a grade changed state; fleet: a Fleet Ops tick.
 */
export type EventName = "approvals" | "chat" | "progress" | "grades" | "fleet" | "tasks";

const HEARTBEAT_MS = 25_000;

export class Events {
  private streams = new Set<ServerResponse>();

  emit(name: EventName, issue?: string): void {
    if (!this.streams.size) return;
    const frame = `event: ${name}\ndata: ${JSON.stringify(issue ? { issue } : {})}\n\n`;
    for (const res of this.streams) res.write(frame);
  }

  /** Shutdown: end every open stream, so the listeners can close (the browsers reconnect to the next board). */
  close(): void {
    for (const res of this.streams) res.end();
    this.streams.clear();
  }

  /** How many boards are listening (tests, logs). */
  get open(): number {
    return this.streams.size;
  }

  /**
   * GET /api/events, behind the board's session gate: an event stream until the browser goes. A named `ping` at once and
   * every 25s lets the client tell a live stream from one a proxy buffers (it then keeps polling).
   */
  stream(req: IncomingMessage, res: ServerResponse, headers: Record<string, string>): void {
    res.writeHead(200, { ...headers, "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" });
    res.flushHeaders();
    res.write("retry: 5000\nevent: ping\ndata: {}\n\n");
    this.streams.add(res);
    // The setting switched off: open streams end at the next beat, and the browser's reconnect is refused.
    const beat = setInterval(() => (liveUpdatesOn() ? res.write("event: ping\ndata: {}\n\n") : res.end()), HEARTBEAT_MS);
    beat.unref();
    const done = () => {
      clearInterval(beat);
      this.streams.delete(res);
    };
    req.on("close", done);
    res.on("close", done);
    res.on("error", done);
  }
}

/** The instance's `live_updates` setting (grants table, read per stream): off is the kill switch; the boards poll as before. */
export function liveUpdatesOn(grantsFile = process.env.AIDENHQ_GRANTS_FILE): boolean {
  try {
    return JSON.parse(readFileSync(grantsFile ?? "", "utf8"))?.live_updates !== "off";
  } catch {
    return true;
  }
}
