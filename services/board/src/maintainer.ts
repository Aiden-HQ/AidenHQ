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
 *
 * With the triage webhook set (the maintainer module's external_triage), the same read also brings each repo's issues
 * opened since its triage cursor with no fix label that our App didn't file, and each fires the triage routine once, with
 * its repo and number only (the title is a stranger's text). Labelling stays the Maintainer's judgment in that run; its
 * label then comes back through the trusted path above. The first look only sets the cursor: the issues already open are
 * the daily triage's. A stranger's issue starts a model run that reads untrusted text before the App's trusted label, so
 * the runs are capped a day per issue author and per repo (`limits`, the maintainer module's settings): past either, the
 * issue is left to the daily triage run.
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
/** One repo's answer: its issues since its cursor and the new cursor, or why it couldn't be read; and, when asked, its new
 * unlabelled issues (oldest first) and their cursor, or why those couldn't be read. */
export interface MaintainerRepoBatch {
  repo: string;
  issues?: MaintainerIssue[];
  skipped?: { number: number; reason: string }[];
  cursor?: string | null;
  error?: string;
  untriaged?: { number: number; created_at: string; author?: string }[];
  triage_cursor?: string;
  triage_error?: string;
}
export interface MaintainerBatch {
  repos: MaintainerRepoBatch[];
}
type Kv = Pick<Store, "meta" | "setMeta">;
type Issues = (cursors: Record<string, string>, triage?: Record<string, string>) => Promise<MaintainerBatch>;
type Fire = (repo: string, issue: MaintainerIssue) => Promise<boolean>;
type Triage = (repo: string, number: number) => Promise<boolean>;
type Log = { info(o: object, m: string): void; warn(o: object, m: string): void };

interface RepoState {
  cursor?: string;
  fired?: number[];
  noted?: number[];
  /** The last error logged for this repo, so a run of the same one is said once. */
  error?: string;
  triage_cursor?: string;
  triaged?: number[];
  /** The triage runs fired in the last day, with their issue's author: what the daily limits count. */
  recent?: { at: number; author: string }[];
  triage_error?: string;
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
export interface TriageLimits {
  perAuthor: number;
  perRepo: number;
}
const DAY = 24 * 60 * MIN;

export async function maintainerTick(d: { issues: Issues; fire: Fire; triage?: Triage; limits?: TriageLimits; store: Kv; log: Log }): Promise<number> {
  const state = readState(d.store);
  const repos: Record<string, RepoState> = { ...(state.repos ?? {}) };
  let legacy: RepoState | undefined = state.repos ? undefined : { cursor: state.cursor, fired: state.fired, noted: state.noted };
  // The legacy state is kept as it was until a repo takes it over.
  const save = (error?: string) => d.store.setMeta(STATE_KEY, JSON.stringify({ ...(legacy ?? { repos }), ...(error ? { error } : {}) }));
  const cursors = Object.fromEntries(Object.entries(repos).flatMap(([r, s]) => (s.cursor ? [[r, s.cursor]] : [])));
  const triageCursors = Object.fromEntries(Object.entries(repos).flatMap(([r, s]) => (s.triage_cursor ? [[r, s.triage_cursor]] : [])));
  let batch: MaintainerBatch;
  try {
    batch = d.triage ? await d.issues(cursors, triageCursors) : await d.issues(cursors);
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
    const { count: triaged = 0, ...triage } = d.triage ? await triageRepo(b, before, d.triage, d.limits ?? triageLimits({}), d.log) : {};
    count += triaged;
    if (b.error) {
      if (b.error !== before.error) d.log.warn({ repo: b.repo, err: b.error }, "maintainer issues not read for this repo; the next tick asks again");
      repos[b.repo] = { ...before, ...triage, error: b.error };
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
    repos[b.repo] = { cursor: (delivered ? b.cursor : undefined) ?? before.cursor, fired: keep(fired), noted: keep(noted), ...triage };
  }
  save();
  return count;
}

/**
 * One repo's new unlabelled issues: each fires the triage routine once. The triage cursor moves past what was delivered:
 * a refused webhook stops there, and the next tick reads it again (the fired set keeps a repeat out). A github-mcp that
 * sends no `untriaged` (older than this board) leaves the state as it was.
 */
async function triageRepo(b: MaintainerRepoBatch, before: RepoState, fire: Triage, limits: TriageLimits, log: Log): Promise<Partial<RepoState> & { count?: number }> {
  const recent = (before.recent ?? []).filter((r) => Date.now() - r.at < DAY);
  const kept = { triage_cursor: before.triage_cursor, triaged: before.triaged, recent };
  if (b.triage_error) {
    if (b.triage_error !== before.triage_error) log.warn({ repo: b.repo, err: b.triage_error }, "new issues not read for triage on this repo; the next tick asks again");
    return { ...kept, triage_error: b.triage_error };
  }
  if (!b.untriaged || !b.triage_cursor) return kept;
  const triaged = new Set(before.triaged ?? []);
  // The issues come oldest first: the cursor follows the last one delivered, and reaches the read's own once all are.
  let cursor = before.triage_cursor;
  let count = 0;
  for (const i of b.untriaged) {
    const author = String(i.author ?? "").toLowerCase();
    if (!triaged.has(i.number)) {
      const byAuthor = recent.filter((r) => r.author === author).length;
      if (recent.length >= limits.perRepo || byAuthor >= limits.perAuthor) {
        log.info({ repo: b.repo, issue: i.number, author, today: { repo: recent.length, author: byAuthor } }, "triage limit reached: left to the daily triage run");
      } else if (!(await fire(b.repo, i.number).catch(() => false))) {
        log.warn({ repo: b.repo, issue: i.number }, "maintainer triage webhook refused; the next tick retries it");
        return { triage_cursor: cursor, triaged: keep(triaged), recent, count };
      } else {
        recent.push({ at: Date.now(), author });
        count++;
      }
      triaged.add(i.number);
    }
    cursor = i.created_at;
  }
  return { triage_cursor: b.triage_cursor, triaged: keep(triaged), recent, count };
}

/**
 * github-mcp's internal read on the compose network, with the token it shares with this board only. Undefined until the
 * module that runs it mounts that token: the watcher is off, rather than failing every tick.
 */
export function maintainerIssues(env: NodeJS.ProcessEnv = process.env): Issues | undefined {
  const url = (env.MAINTAINER_ISSUES_URL ?? "http://github-mcp:8086/internal/maintainer/issues").replace(/\/+$/, "");
  const tokenFile = env.MAINTAINER_ISSUES_TOKEN_FILE;
  if (!tokenFile) return undefined;
  try {
    readFileSync(tokenFile);
  } catch {
    return undefined;
  }
  return async (cursors, triage) => {
    const token = readFileSync(tokenFile, "utf8").trim();
    const query = `cursors=${encodeURIComponent(JSON.stringify(cursors))}${triage ? `&triage_cursors=${encodeURIComponent(JSON.stringify(triage))}` : ""}`;
    const res = await fetch(`${url}?${query}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`github-mcp: ${res.status} ${(await res.text()).slice(0, 200)}`);
    return (await res.json()) as MaintainerBatch;
  };
}

/** A routine's signed webhook from its two files, or undefined until setup has written both. */
function signedWebhook(urlFile: string | undefined, secretFile: string | undefined): ((payload: object) => Promise<boolean>) | undefined {
  const read = (f: string | undefined) => {
    try {
      return f ? readFileSync(f, "utf8").trim() : "";
    } catch {
      return "";
    }
  };
  const [url, secret] = [read(urlFile), read(secretFile)];
  if (!url || !secret) return undefined;
  return async (payload) => {
    const ts = String(Math.floor(Date.now() / 1000));
    const body = JSON.stringify(payload);
    const sig = createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-paperclip-timestamp": ts, "x-paperclip-signature": `sha256=${sig}` }, body, signal: AbortSignal.timeout(15_000) });
    // 409: a run is already going (coalesced) and reads the issue itself.
    return [200, 202, 409].includes(res.status);
  };
}

/**
 * The Maintainer routine's webhook, signed like the other routine webhooks. Undefined until setup has written both files:
 * the watcher is then off, rather than failing every tick.
 */
export function maintainerWake(env: NodeJS.ProcessEnv = process.env): Fire | undefined {
  const send = signedWebhook(env.MAINTAINER_WEBHOOK_URL_FILE, env.MAINTAINER_WEBHOOK_SECRET_FILE);
  return send && ((repo, issue) => send({ repo, number: String(issue.number), title: issue.title ?? "" }));
}

/**
 * The per-issue triage routine's webhook: the repo and number only. Undefined with external triage off, or until setup has
 * written its files: the watcher then reads no new issues.
 */
export function maintainerTriageWake(env: NodeJS.ProcessEnv = process.env): Triage | undefined {
  if (String(env.MAINTAINER_EXTERNAL_TRIAGE ?? "").trim() === "false") return undefined;
  const send = signedWebhook(env.MAINTAINER_TRIAGE_WEBHOOK_URL_FILE, env.MAINTAINER_TRIAGE_WEBHOOK_SECRET_FILE);
  return send && ((repo, number) => send({ repo, number: String(number) }));
}

/** The daily triage limits from the maintainer module's settings (MAINTAINER_TRIAGE_PER_AUTHOR_DAY / _PER_REPO_DAY). */
export function triageLimits(env: NodeJS.ProcessEnv = process.env): TriageLimits {
  const n = (v: string | undefined, d: number) => (Number.isInteger(Number(v)) && Number(v) >= 0 && String(v ?? "").trim() !== "" ? Number(v) : d);
  return { perAuthor: n(env.MAINTAINER_TRIAGE_PER_AUTHOR_DAY, 3), perRepo: n(env.MAINTAINER_TRIAGE_PER_REPO_DAY, 30) };
}

type Wiring = { issues: Issues; fire: Fire; triage?: Triage; limits?: TriageLimits };

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
