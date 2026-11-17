/**
 * The Maintainer's issue wake-up. An instance has no public ingress GitHub can reach, so a GitHub App webhook cannot
 * arrive: on a timer the board asks github-mcp for the product issues labelled since its last look and fires the
 * Maintainer routine's webhook once per trusted issue. github-mcp decides `trusted` (a label counts only from the
 * product repo's own maintainers); an untrusted one is logged once and costs no model call and no run.
 *
 * The cursor, the issues already fired and the ones already noted as untrusted live in the board's store (meta
 * `maintainer_issues`), so a restart with the stored cursor neither repeats a delivery nor skips a new issue. A failed
 * read leaves the cursor where it was and fires nothing; the next tick asks again.
 */
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Store } from "./store.js";

const MIN = 60_000;
const STATE_KEY = "maintainer_issues";
/** How many issue numbers the state keeps: github-mcp resends nothing the cursor has moved past. */
const KEEP = 500;

export interface MaintainerIssue {
  number: number;
  title?: string;
  trusted: boolean;
  labeled_at?: string;
  actor?: string;
}
export interface MaintainerBatch {
  issues: MaintainerIssue[];
  skipped?: { number: number; reason: string }[];
  cursor?: string;
}
type Kv = Pick<Store, "meta" | "setMeta">;
type Log = { info(o: object, m: string): void; warn(o: object, m: string): void };

interface State {
  cursor?: string;
  fired?: number[];
  noted?: number[];
  /** The last github-mcp error logged, so a run of the same one is said once. */
  error?: string;
}

function readState(store: Kv): State {
  try {
    return JSON.parse(store.meta(STATE_KEY) ?? "{}") as State;
  } catch {
    return {};
  }
}

const keep = (xs: Iterable<number>) => [...new Set(xs)].slice(-KEEP);

/**
 * One look: fire each new trusted issue once, name each new untrusted one once, and move the cursor only when the whole
 * batch was delivered. Returns how many webhooks were fired.
 */
export async function maintainerTick(d: { issues: (since: string) => Promise<MaintainerBatch>; fire: (issue: MaintainerIssue) => Promise<boolean>; store: Kv; log: Log }): Promise<number> {
  const state = readState(d.store);
  const save = (next: State) => d.store.setMeta(STATE_KEY, JSON.stringify(next));
  const fired = new Set(state.fired ?? []);
  const noted = new Set(state.noted ?? []);
  let batch: MaintainerBatch;
  try {
    batch = await d.issues(state.cursor ?? "");
  } catch (err) {
    const message = String(err instanceof Error ? err.message : err).slice(0, 300);
    if (message !== state.error) d.log.warn({ err: message }, "maintainer issues not read; the next tick asks again");
    // The cursor stays where it was: nothing was delivered, so nothing was seen.
    save({ cursor: state.cursor, fired: keep(fired), noted: keep(noted), error: message });
    return 0;
  }
  let count = 0;
  for (const issue of batch.issues ?? []) {
    if (!issue.trusted) {
      if (!noted.has(issue.number)) {
        d.log.info({ issue: issue.number, actor: issue.actor ?? "" }, "untrusted maintainer label: no run");
        noted.add(issue.number);
      }
      continue;
    }
    if (fired.has(issue.number)) continue;
    const ok = await d.fire(issue).catch(() => false);
    if (!ok) {
      d.log.warn({ issue: issue.number }, "maintainer webhook refused; the next tick retries it");
      // No cursor move: the next tick asks for the same window and retries only what was not delivered.
      save({ cursor: state.cursor, fired: keep(fired), noted: keep(noted) });
      return count;
    }
    fired.add(issue.number);
    count++;
  }
  save({ cursor: batch.cursor ?? state.cursor, fired: keep(fired), noted: keep(noted) });
  return count;
}

/** github-mcp's internal read on the compose network, with the token the two share and nothing else holds. */
export function maintainerIssues(env: NodeJS.ProcessEnv = process.env): (since: string) => Promise<MaintainerBatch> {
  const url = (env.MAINTAINER_ISSUES_URL ?? "http://github-mcp:8086/internal/maintainer/issues").replace(/\/+$/, "");
  const tokenFile = env.MAINTAINER_ISSUES_TOKEN_FILE ?? "/run/secrets/maintainer_issues_token";
  return async (since) => {
    const token = readFileSync(tokenFile, "utf8").trim();
    const res = await fetch(`${url}?since=${encodeURIComponent(since)}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`github-mcp: ${res.status} ${(await res.text()).slice(0, 200)}`);
    return (await res.json()) as MaintainerBatch;
  };
}

/**
 * The Maintainer routine's webhook, signed like the other routine webhooks. Undefined until setup has written both files:
 * the watcher is then off, rather than failing every tick.
 */
export function maintainerWake(env: NodeJS.ProcessEnv = process.env): ((issue: MaintainerIssue) => Promise<boolean>) | undefined {
  const read = (f: string | undefined) => {
    try {
      return f ? readFileSync(f, "utf8").trim() : "";
    } catch {
      return "";
    }
  };
  const [url, secret] = [read(env.MAINTAINER_WEBHOOK_URL_FILE), read(env.MAINTAINER_WEBHOOK_SECRET_FILE)];
  if (!url || !secret) return undefined;
  return async (issue) => {
    const ts = String(Math.floor(Date.now() / 1000));
    const body = JSON.stringify({ number: String(issue.number), title: issue.title ?? "" });
    const sig = createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-paperclip-timestamp": ts, "x-paperclip-signature": `sha256=${sig}` }, body, signal: AbortSignal.timeout(15_000) });
    // 409: a run is already going (coalesced) and reads the issue itself.
    return [200, 202, 409].includes(res.status);
  };
}

/** Starts the watcher (main.ts). A tick that finds the previous one still in flight is skipped. */
export function startMaintainer(d: { issues: (since: string) => Promise<MaintainerBatch>; fire: (issue: MaintainerIssue) => Promise<boolean>; store: Kv; log: Log; minutes?: number }): void {
  const minutes = Number(d.minutes ?? process.env.MAINTAINER_POLL_MINUTES ?? 5);
  if (!(minutes > 0)) return;
  let busy = false;
  const run = async () => {
    if (busy) return;
    busy = true;
    try {
      await maintainerTick(d);
    } catch (err) {
      d.log.warn({ err: String(err) }, "maintainer tick failed");
    } finally {
      busy = false;
    }
  };
  setInterval(run, Math.max(1, minutes) * MIN).unref();
  setTimeout(run, MIN).unref();
  d.log.info({ minutes }, "maintainer issue watcher on");
}
