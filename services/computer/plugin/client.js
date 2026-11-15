// The plugin's calls to the host launcher, apart from worker.js so they can be tested without the SDK.
// c = { launcherUrl, token }.
import { randomUUID } from "node:crypto";

/** An exec allowed to run longer than this (an agent's turn) runs detached in its box and survives a launcher restart. */
export const LONG_EXEC_MS = 60_000;
/** How long a call waits out a launcher that is restarting (a deploy takes seconds; a crash restarts after 15 s). */
const RESTART_WINDOW_MS = 180_000;

const failure = (message, extra = {}) => Object.assign(new Error(message), extra);

/**
 * One call. Its error says why: `refused` (nothing reached the launcher: safe to send again), `lost` (the launcher went away
 * before it answered in full), or the launcher's own refusal (`computer launcher <route>: <status> <error>`).
 */
export async function call(c, route, body, { fetch: f = fetch } = {}) {
  let r, text;
  try {
    r = await f(`${c.launcherUrl}/${route}`, { method: "POST", headers: { Authorization: `Bearer ${c.token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  } catch (e) {
    const code = e.cause?.code ?? e.code;
    throw failure(`computer launcher ${route}: unreachable (${code ?? e.message})`, code === "ECONNREFUSED" ? { refused: true } : { lost: true });
  }
  try {
    text = await r.text();
  } catch (e) {
    throw failure(`computer launcher ${route}: the answer was cut off (${e.cause?.code ?? e.message}); the launcher restarted?`, { lost: true });
  }
  let j;
  try { j = JSON.parse(text || "{}"); } catch { j = null; }
  // /exec answers 200 at once and keeps the line open (the launcher's answerSlowly): an unreadable 200 is a cut-off answer.
  if (r.ok && !j) throw failure(`computer launcher ${route}: the answer was cut off; the launcher restarted?`, { lost: true });
  if (!r.ok || j.error) throw failure(`computer launcher ${route}: ${j?.status ?? r.status} ${j?.error ?? text.slice(0, 200)}`.trim());
  return j;
}

async function riding(fn, retry, { sleep, now }, windowMs = RESTART_WINDOW_MS) {
  const until = now() + windowMs;
  for (;;) {
    try {
      return await fn();
    } catch (e) {
      if (!retry(e) || now() >= until) throw e;
      await sleep(2000);
    }
  }
}

const defaults = (o) => ({ fetch: o.fetch ?? fetch, sleep: o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))), now: o.now ?? Date.now });

/** A call that waits out a launcher restart when nothing reached it yet. */
export function request(c, route, body, o = {}) {
  const d = defaults(o);
  return riding(() => call(c, route, body, d), (e) => e.refused, d);
}

/**
 * An exec. A long one carries an execId: if the launcher goes away mid-turn (a deploy restarts it), the command runs on in the
 * box and its result is collected from the next launcher (/attach), so the turn is never lost. A box that is gone fails at once
 * (the launcher's 404), never retried.
 */
export async function execute(c, body, o = {}) {
  const d = defaults(o);
  const long = !(body.timeoutMs > 0) || body.timeoutMs > LONG_EXEC_MS;
  // A short one waits no longer than its own timeout: its caller has given up by then.
  if (!long) return riding(() => call(c, "exec", body, d), (e) => e.refused, d, body.timeoutMs);
  const execId = randomUUID();
  const t0 = d.now();
  try {
    return await request(c, "exec", { ...body, execId }, d);
  } catch (e) {
    if (!e.lost) throw e;
  }
  const timeoutMs = body.timeoutMs > 0 ? Math.max(1000, body.timeoutMs - (d.now() - t0)) : 0;
  return riding(() => call(c, "attach", { container: body.container, execId, timeoutMs }, d), (e) => e.refused || e.lost, d);
}
