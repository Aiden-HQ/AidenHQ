import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { GitHubNeed } from "./client.js";
import { claimOrgOk } from "./org-observations.js";

// Whether a bearer is the named module's own token, asked of the kernel (GET /v1/whoami): the issue read for the Maintainer's
// watcher is opened to that module alone, so no secret is shared with it. undefined: the kernel couldn't answer now (a restart,
// a timeout, a 5xx), which a caller answers as 503 (try again), never as the 401 of a token the kernel refused.
export async function isModule(kernelUrl: string, authorization: string, module: string, fetcher: typeof fetch = fetch): Promise<boolean | undefined> {
  const bearer = authorization.replace(/^Bearer\s+/i, "").trim();
  if (!bearer) return false;
  try {
    const r = await fetcher(new URL("/v1/whoami", kernelUrl), { headers: { authorization: `Bearer ${bearer}` }, signal: AbortSignal.timeout(5_000) });
    if (!r.ok) return r.status === 401 || r.status === 403 ? false : undefined;
    const who = (await r.json()) as { kind?: string; module?: string };
    return who.kind === "module" && who.module === module;
  } catch {
    return undefined;
  }
}

/** A need's body as the kernel's route takes it; what is stored while a report is unacknowledged. */
type NeedBody = { connection: "github"; need: { cause: string; detail: string; scope?: string; org?: string; url?: string } };
/** `taken`: the kernel has it. `retry`: it could not take it now (network, timeout, 5xx), so keep it. `refused`: the request itself
 * is wrong (a 4xx), which a retry can never fix. */
export type NeedReport = "taken" | "retry" | "refused";
type WarnLog = { warn: (o: object, m: string) => void };

/** A GitHubNeed's body for POST /v1/connections/need. */
function bodyOf(err: GitHubNeed): NeedBody {
  const n = err.need as { cause: string; detail?: string; scope?: string; org?: string; url?: string };
  return { connection: "github", need: { cause: n.cause, detail: err.message, ...(n.cause === "scope" ? { scope: n.scope } : {}), ...(n.cause === "sso" || n.cause === "restricted" ? { org: n.org, url: n.url } : {}) } };
}

/** One POST of a need, classified: a 4xx is the request's own fault and is never retried; a 5xx, a timeout or a network error is. */
async function postNeed(kernelUrl: string, key: string, body: NeedBody, log: WarnLog, fetcher: typeof fetch, timeoutMs: number): Promise<NeedReport> {
  try {
    const r = await fetcher(new URL("/v1/connections/need", kernelUrl), { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
    if (r.ok) return "taken";
    if (r.status >= 400 && r.status < 500) { log.warn({ status: r.status, cause: body.need.cause }, "the kernel refused a connection need report"); return "refused"; }
    log.warn({ status: r.status, cause: body.need.cause }, "the kernel could not take a connection need report; it is retried");
    return "retry";
  } catch (e) {
    log.warn({ err: (e as Error).message, cause: body.need.cause }, "a connection need report failed; it is retried");
    return "retry";
  }
}

/**
 * A GitHub need only the owner can fix, met outside a tool call (code review's post reaches this process directly), told to the
 * kernel as the connection's need (POST /v1/connections/need) so it is routed like any tool call's. Never throws: "taken" when the
 * kernel has it (or there was nothing to report), "retry" when it has to be sent again, "refused" when the request itself is wrong.
 */
export async function reportNeed(kernelUrl: string, key: string, err: unknown, log: WarnLog = { warn: () => {} }, fetcher: typeof fetch = fetch, timeoutMs = 5_000): Promise<NeedReport> {
  if (!(err instanceof GitHubNeed) || !err.ownerFixable) return "taken";
  return postNeed(kernelUrl, key, bodyOf(err), log, fetcher, timeoutMs);
}

/**
 * A call by the owner to `org` succeeded, so the org's sso/restricted need is the owner's fix already made: told to the kernel as
 * POST /v1/connections/ok. Fire-and-forget, one POST: a lost report is harmless (the next successful GraphQL org query reports
 * again, and the src_github pass runs one for every configured org every 15 minutes), and a retry would be a success landing after
 * a newer refusal. A success a refusal for the org has already overtaken is not sent at all. Never throws into the GitHub call.
 */
export function reportOrgOk(kernelUrl: string, key: string, connection: "github", org: string, log: WarnLog = { warn: () => {} }, fetcher: typeof fetch = fetch, timeoutMs = 5_000): void {
  // A refusal of the org since the last success is the newer answer: the org is still blocked, so this is not reported.
  if (!claimOrgOk(org)) { log.warn({ org }, "a connection success report was dropped: a need for the org was met after it"); return; }
  void fetcher(new URL("/v1/connections/ok", kernelUrl), { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ connection, org }), signal: AbortSignal.timeout(timeoutMs) })
    .then((r) => { if (!r.ok) log.warn({ status: r.status, org }, "the kernel refused a connection success report"); })
    .catch((e: Error) => log.warn({ err: e.message, org }, "a connection success report failed; the org's next query reports it again"));
}

/** How long a reply waits for the kernel to take a need: the route answers within its 1 s even when the kernel is slow. */
const NEED_WAIT_MS = 1_000;
const PENDING_MAX = 20;
type Pending = { need: NeedBody["need"]; /** The sign-in the need was met on; a sign-in cause from another one is stale. */ gen?: string };
/** Causes a reconnection fixes; a kept one from before it is dropped rather than marking the fresh sign-in down. */
const SIGN_IN_CAUSES = new Set(["not_connected", "expired"]);
const needKey = (n: NeedBody["need"] | { cause: string; scope?: string; org?: string; account?: string }) => [n.cause, n.scope ?? "", n.org ?? "", (n as { account?: string }).account ?? ""].join("\u0000");

/**
 * The needs this process has to report outside a tool call. `tell` waits NEED_WAIT_MS for the kernel and keeps one it could not
 * take; `flush` (the start of every request) retries the kept ones once each, so a dropped report is not lost. A permanent
 * refusal (a 4xx) is dropped with a log rather than retried forever. With `file`, the kept ones survive the container: an apply
 * recreating it in the window before a report lands loses nothing.
 */
export function needQueue(o: {
  kernelUrl: string;
  key: () => string;
  log: WarnLog;
  fetcher?: typeof fetch;
  waitMs?: number;
  file?: string;
  /** Names the installed sign-in: a kept sign-in need from another one is stale. */
  generation?: () => string;
  /** Whether the current sign-in already grants a scope: a kept scope need it covers is the owner's fix already made. */
  covers?: (scope: string) => boolean;
}) {
  const waitMs = o.waitMs ?? NEED_WAIT_MS;
  const pending = new Map<string, Pending>();
  const gen = () => o.generation?.() ?? "";
  /** A kept sign-in need the owner has since fixed by reconnecting: sending it would mark the fresh sign-in down. */
  const stale = (p: Pending) => Boolean(o.generation) && SIGN_IN_CAUSES.has(p.need.cause) && p.gen !== gen();
  /**
   * A kept scope need the current grant already covers: a reconnect that granted the scope is the owner's fix, and replaying the
   * notice would put the gap back on a connection that no longer has it. A scope list that can't be read (empty) never says so.
   */
  const fixed = (p: Pending) => p.need.cause === "scope" && typeof p.need.scope === "string" && Boolean(o.covers?.(p.need.scope));
  const save = () => {
    if (!o.file) return;
    try {
      mkdirSync(dirname(o.file), { recursive: true });
      const out = JSON.stringify([...pending].map(([key, p]) => ({ key, need: p.need, ...(p.gen !== undefined ? { gen: p.gen } : {}) })));
      writeFileSync(`${o.file}.tmp`, out);
      renameSync(`${o.file}.tmp`, o.file);
    } catch (e) {
      o.log.warn({ err: (e as Error).message }, "a connection need could not be kept on disk");
    }
  };
  // What a previous process kept: the file is this process's own, so a bad one is set aside, never fatal.
  let migrated = false;
  if (o.file) {
    try {
      const rows = JSON.parse(readFileSync(o.file, "utf8")) as { key?: unknown; need?: unknown; gen?: unknown }[];
      for (const r of Array.isArray(rows) ? rows : []) {
        const need = r?.need as NeedBody["need"] | undefined;
        if (!need || typeof need.cause !== "string" || typeof r.key !== "string") continue;
        // An entry from before needs carried a credential was not written against a reconnect this process can see: adopt the
        // installed one (a one-time migration, saved below) rather than reading `undefined` as a mismatch and dropping it.
        if (typeof r.gen === "string") pending.set(r.key, { need, gen: r.gen });
        else {
          pending.set(r.key, { need, gen: gen() });
          migrated = true;
        }
      }
    } catch (e) {
      if ((e as { code?: string }).code !== "ENOENT") o.log.warn({ err: (e as Error).message }, "the kept connection needs could not be read");
    }
  }
  /** The cap is applied only after a replay: a staged need the kernel takes is not an entry still waiting. True when it dropped one. */
  const cap = () => {
    let evicted = false;
    while (pending.size > PENDING_MAX) {
      const k = pending.keys().next().value!;
      pending.delete(k);
      evicted = true;
      o.log.warn({ key: k }, "a connection need was dropped from the pending set: more than the cap of 20 were waiting");
    }
    return evicted;
  };
  if (migrated) save();
  let flushing = false;
  const flush = async (): Promise<void> => {
    if (flushing || !pending.size) return;
    flushing = true;
    let changed = false;
    try {
      // One entry per kept key at the start: a failure re-keeps it without being visited again in this pass.
      for (const [k, p] of [...pending]) {
        // A success fixed it while this pass awaited an earlier report: no longer kept, so it is not sent.
        if (!pending.has(k)) continue;
        if (stale(p)) {
          pending.delete(k);
          changed = true;
          o.log.warn({ cause: p.need.cause }, "a connection need met before the owner reconnected was dropped");
          continue;
        }
        if (fixed(p)) {
          pending.delete(k);
          changed = true;
          o.log.warn({ cause: p.need.cause, scope: p.need.scope }, "a connection need the owner has since granted was dropped");
          continue;
        }
        const r = await postNeed(o.kernelUrl, o.key(), { connection: "github", need: p.need }, o.log, o.fetcher ?? fetch, 5_000);
        if (r === "retry") continue;
        pending.delete(k);
        changed = true;
      }
    } finally { flushing = false; if (cap() || changed) save(); }
  };
  return {
    /** Report now, bounded; the report is kept on disk before the first attempt, so a restart inside the wait still sends it. */
    tell: async (err: unknown): Promise<void> => {
      if (!(err instanceof GitHubNeed) || !err.ownerFixable) return;
      const body = bodyOf(err), k = needKey(body.need);
      // The owner granted it since (the reply is from an earlier attempt): staging it would report a gap that is already fixed.
      if (fixed({ need: body.need })) return;
      // Staged (and on disk) before the attempt; the cap is applied only if this one has to stay, so staging a report the kernel
      // takes never evicts a kept one.
      pending.set(k, { need: body.need, gen: gen() });
      save();
      const r = await reportNeed(o.kernelUrl, o.key(), err, o.log, o.fetcher, waitMs);
      if (r === "retry") { cap(); save(); return; }
      if (pending.delete(k)) save();
    },
    flush,
    /** A call to `org` succeeded: any kept sso/restricted need for it is the owner's fix already made, not a report to replay. */
    forget: (org: string): void => {
      let changed = false;
      const lower = org.toLowerCase();
      for (const [k, p] of pending) {
        if ((p.need.cause === "sso" || p.need.cause === "restricted") && p.need.org?.toLowerCase() === lower) {
          pending.delete(k);
          changed = true;
        }
      }
      if (changed) { save(); o.log.warn({ org }, "a kept connection need the org now answers was dropped"); }
    },
    pending: () => pending.size,
  };
}
