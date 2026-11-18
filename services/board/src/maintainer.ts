/**
 * The Maintainer's issue wake-up. An instance has no public ingress GitHub can reach, so a GitHub App webhook cannot
 * arrive: on a timer the board asks github-mcp for the issues labelled since its last look on every maintained repo (the
 * github module's setting maintainer_repos, which github-mcp holds) and fires the Maintainer routine's webhook once per
 * trusted issue. github-mcp decides `trusted` (a label counts only from the App or a collaborator with one of the repo's
 * trusted roles); an untrusted one is logged once and costs no model call and no run.
 *
 * Each repo's cursor, the issues already fired and the ones already noted as untrusted live in the board's store (meta
 * `maintainer_issues`, per repo), so a restart with the stored cursors neither repeats a delivery nor skips a new issue. A
 * failed read leaves that repo's cursor where it was and fires nothing there; the next tick asks again.
 */
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Store } from "./store.js";

const MIN = 60_000;
const STATE_KEY = "maintainer_issues";
/** How many issue numbers each repo's state keeps: github-mcp resends nothing the cursor has moved past. */
const KEEP = 500;

export interface MaintainerIssue {
  number: number;
  title?: string;
  trusted: boolean;
  labeled_at?: string;
  actor?: string;
}
/** One repo's answer: its issues since its cursor and the new cursor, or why it couldn't be read. */
export interface MaintainerRepoBatch {
  repo: string;
  issues?: MaintainerIssue[];
  skipped?: { number: number; reason: string }[];
  cursor?: string | null;
  error?: string;
}
export interface MaintainerBatch {
  repos: MaintainerRepoBatch[];
}
type Kv = Pick<Store, "meta" | "setMeta">;
type Log = { info(o: object, m: string): void; warn(o: object, m: string): void };

interface RepoState {
  cursor?: string;
  fired?: number[];
  noted?: number[];
  /** The last error logged for this repo, so a run of the same one is said once. */
  error?: string;
}
interface State {
  repos?: Record<string, RepoState>;
  /** The last whole-read error logged. */
  error?: string;
  /** The single-repo state before maintainer_repos: the first repo github-mcp lists takes it over once. */
  cursor?: string;
  fired?: number[];
  noted?: number[];
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
 * One look over every maintained repo: fire each new trusted issue once, name each new untrusted one once, and move a
 * repo's cursor only when its whole batch was delivered. Returns how many webhooks were fired.
 */
export async function maintainerTick(d: { issues: (cursors: Record<string, string>) => Promise<MaintainerBatch>; fire: (repo: string, issue: MaintainerIssue) => Promise<boolean>; store: Kv; log: Log }): Promise<number> {
  const state = readState(d.store);
  const repos: Record<string, RepoState> = { ...(state.repos ?? {}) };
  let legacy: RepoState | undefined = state.repos ? undefined : { cursor: state.cursor, fired: state.fired, noted: state.noted };
  // The legacy state is kept as it was until a repo takes it over.
  const save = (error?: string) => d.store.setMeta(STATE_KEY, JSON.stringify({ ...(legacy ?? { repos }), ...(error ? { error } : {}) }));
  const cursors = Object.fromEntries(Object.entries(repos).flatMap(([r, s]) => (s.cursor ? [[r, s.cursor]] : [])));
  let batch: MaintainerBatch;
  try {
    batch = await d.issues(cursors);
  } catch (err) {
    const message = String(err instanceof Error ? err.message : err).slice(0, 300);
    if (message !== state.error) d.log.warn({ err: message }, "maintainer issues not read; the next tick asks again");
    // Every cursor stays where it was: nothing was delivered, so nothing was seen.
    save(message);
    return 0;
  }
  let count = 0;
  for (const b of batch.repos ?? []) {
    const before = repos[b.repo] ?? legacy ?? {};
    legacy = undefined;
    if (b.error) {
      if (b.error !== before.error) d.log.warn({ repo: b.repo, err: b.error }, "maintainer issues not read for this repo; the next tick asks again");
      repos[b.repo] = { ...before, error: b.error };
      continue;
    }
    const fired = new Set(before.fired ?? []);
    const noted = new Set(before.noted ?? []);
    let delivered = true;
    for (const issue of b.issues ?? []) {
      if (!issue.trusted) {
        if (!noted.has(issue.number)) {
          d.log.info({ repo: b.repo, issue: issue.number, actor: issue.actor ?? "" }, "untrusted maintainer label: no run");
          noted.add(issue.number);
        }
        continue;
      }
      if (fired.has(issue.number)) continue;
      const ok = await d.fire(b.repo, issue).catch(() => false);
      if (!ok) {
        d.log.warn({ repo: b.repo, issue: issue.number }, "maintainer webhook refused; the next tick retries it");
        // No cursor move: the next tick asks for the same window and retries only what was not delivered.
        delivered = false;
        break;
      }
      fired.add(issue.number);
      count++;
    }
    repos[b.repo] = { cursor: (delivered ? b.cursor : undefined) ?? before.cursor, fired: keep(fired), noted: keep(noted) };
  }
  save();
  return count;
}

/**
 * github-mcp's internal read on the compose network, with the token it shares with this board only. Undefined until the
 * module that runs it mounts that token: the watcher is off, rather than failing every tick.
 */
export function maintainerIssues(env: NodeJS.ProcessEnv = process.env): ((cursors: Record<string, string>) => Promise<MaintainerBatch>) | undefined {
  const url = (env.MAINTAINER_ISSUES_URL ?? "http://github-mcp:8086/internal/maintainer/issues").replace(/\/+$/, "");
  const tokenFile = env.MAINTAINER_ISSUES_TOKEN_FILE;
  if (!tokenFile) return undefined;
  try {
    readFileSync(tokenFile);
  } catch {
    return undefined;
  }
  return async (cursors) => {
    const token = readFileSync(tokenFile, "utf8").trim();
    const res = await fetch(`${url}?cursors=${encodeURIComponent(JSON.stringify(cursors))}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`github-mcp: ${res.status} ${(await res.text()).slice(0, 200)}`);
    return (await res.json()) as MaintainerBatch;
  };
}

/**
 * The Maintainer routine's webhook, signed like the other routine webhooks. Undefined until setup has written both files:
 * the watcher is then off, rather than failing every tick.
 */
export function maintainerWake(env: NodeJS.ProcessEnv = process.env): ((repo: string, issue: MaintainerIssue) => Promise<boolean>) | undefined {
  const read = (f: string | undefined) => {
    try {
      return f ? readFileSync(f, "utf8").trim() : "";
    } catch {
      return "";
    }
  };
  const [url, secret] = [read(env.MAINTAINER_WEBHOOK_URL_FILE), read(env.MAINTAINER_WEBHOOK_SECRET_FILE)];
  if (!url || !secret) return undefined;
  return async (repo, issue) => {
    const ts = String(Math.floor(Date.now() / 1000));
    const body = JSON.stringify({ repo, number: String(issue.number), title: issue.title ?? "" });
    const sig = createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-paperclip-timestamp": ts, "x-paperclip-signature": `sha256=${sig}` }, body, signal: AbortSignal.timeout(15_000) });
    // 409: a run is already going (coalesced) and reads the issue itself.
    return [200, 202, 409].includes(res.status);
  };
}

type Wiring = { issues: (cursors: Record<string, string>) => Promise<MaintainerBatch>; fire: (repo: string, issue: MaintainerIssue) => Promise<boolean> };

/**
 * Starts the watcher (main.ts). `wiring` is asked on every tick, so the webhook setup writes after this board started is
 * picked up without a restart; until it answers, the tick does nothing. A tick that finds the previous one still in flight
 * is skipped.
 */
export function startMaintainer(d: { wiring: () => Wiring | undefined; store: Kv; log: Log; minutes?: number }): void {
  const minutes = Number(d.minutes ?? process.env.MAINTAINER_POLL_MINUTES ?? 5);
  if (!(minutes > 0)) return;
  let busy = false;
  let on: boolean | undefined;
  const wired = () => {
    const w = d.wiring();
    if (!!w !== on) {
      on = !!w;
      if (on) d.log.info({ minutes }, "maintainer issue watcher on");
      else d.log.info({}, "maintainer issue watcher waiting: the routine webhook or github-mcp's token file is still empty");
    }
    return w;
  };
  const run = async () => {
    if (busy) return;
    const w = wired();
    if (!w) return;
    busy = true;
    try {
      await maintainerTick({ ...w, store: d.store, log: d.log });
    } catch (err) {
      d.log.warn({ err: String(err) }, "maintainer tick failed");
    } finally {
      busy = false;
    }
  };
  setInterval(run, Math.max(1, minutes) * MIN).unref();
  setTimeout(run, MIN).unref();
  wired();
}
