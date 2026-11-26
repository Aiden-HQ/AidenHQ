// GitHub's asynchronous merge REST API: the one way a PR merges or enters its merge queue (a PR in a native stack is refused
// by every other path). PUT asks (`merge_action`: `merge_queue` or `direct_merge`), 202 is an acceptance whose `details.uuid` is
// read at its own GET until it is terminal (`merged`, `enqueued` or `failed`).
import { readFileSync, renameSync, writeFileSync } from "node:fs";
type Gh = (method: string, path: string, body?: unknown) => Promise<{ status: number; body: any }>;

/** How long an async merge request is polled for its result (two minutes), and how often: one write's execution is bounded, so
 * the wait is short and a still-pending answer is reported as pending (ship's next round asks again, and GitHub answers the
 * repeat with the same request), never as a merge. */
export const ASYNC_POLLS = 24, ASYNC_POLL_MS = 5_000;
/** A direct merge is read this many times inside the queue's serial pass (30 s): a request still pending then is the next pass's to read from the PR. */
export const DIRECT_POLLS = 6;

export const asyncPath = (repo: string, number: number) => `/repos/${repo}/pulls/${number}/merge-async`;

/** A request's result at its own GET: its `status` word and details, or the HTTP answer that wasn't one (`got` is its status). */
export async function readAsync(gh: Gh, repo: string, number: number, uuid: string): Promise<{ got: number; status: string; details: any; message: string }> {
  const r = await gh("GET", `${asyncPath(repo, number)}/${uuid}`).catch((e: Error) => ({ status: 0, body: { message: String(e.message).slice(0, 200) } }));
  return { got: r.status, status: String(r.body?.status ?? ""), details: r.body?.details ?? {}, message: String(r.body?.message ?? "") };
}

/**
 * The request GitHub holds for a PR at a head, across rounds: its id is the only way back to a result whose PUT answer is spent,
 * and GitHub names it on a repeat (409) only while it is pending. Kept in a file beside the caller's other state, keyed by the head
 * it was bound to, so a request that outlives one execution is read to its end instead of a fresh one being made.
 */
export function requestStore(file: string, log: (msg: string, f?: Record<string, unknown>) => void = () => {}) {
  const held = (): { [k: string]: string } => { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return {}; } };
  return {
    get: (key: string) => String(held()[key] ?? ""),
    /** Keeps `uuid` for `key`; no uuid drops it. */
    set(key: string, uuid?: string) {
      const all = held();
      if (uuid) all[key] = uuid; else delete all[key];
      const kept = Object.fromEntries(Object.entries(all).slice(-500));
      try { writeFileSync(`${file}.tmp`, JSON.stringify(kept)); renameSync(`${file}.tmp`, file); } catch (e) { log("async request id not kept", { key, err: String((e as Error).message).slice(0, 120) }); }
    },
  };
}
export const requestKey = (repo: string, number: number, head: string) => `${repo}#${number}@${head.toLowerCase()}`;

/**
 * A direct merge: the merge commit's sha once GitHub reports `merged`. The accepted request's id is kept until it is terminal, and
 * a request kept from an earlier pass is read to its end before any new PUT is made. A request still pending after `polls` reads,
 * a 200 (GitHub's answer for a PR already merged or queued: never proof of this call's merge), a 409 and a failed read throw with
 * no status, so the caller reads the PR itself and credits only a commit this call made. `failed` throws a 409: GitHub's refusal.
 */
export async function mergeDirect(gh: Gh, repo: string, number: number, body: { sha: string; merge_method: string; commit_message?: string }, polls: number, pollMs: number, store: ReturnType<typeof requestStore>): Promise<string> {
  const unanswered = (why: string) => new Error(`GitHub didn't settle the async merge: ${why}`);
  const key = requestKey(repo, number, body.sha);
  /** The request read to its terminal result within the budget; undefined when GitHub no longer holds it. */
  const settle = async (uuid: string, status = "pending", details: any = {}): Promise<string | undefined> => {
    for (let i = 0; status === "pending" && i < polls; i++) {
      if (i) await new Promise((done) => setTimeout(done, pollMs));
      const got = await readAsync(gh, repo, number, uuid);
      if (got.got === 404) { store.set(key); return undefined; }
      if (got.status) ({ status, details } = got);
    }
    if (status === "merged" && details.sha) { store.set(key); return String(details.sha); }
    if (status === "failed") { store.set(key); throw Object.assign(new Error(`HTTP 409: ${String(details.message ?? "the asynchronous merge failed").replace(/[\r\n]+/g, " ").slice(0, 300)}`), { status: 409 }); }
    throw unanswered(status || "no status");
  };
  const known = store.get(key);
  if (known) { const sha = await settle(known); if (sha) return sha; }
  const r = await gh("PUT", asyncPath(repo, number), { ...body, merge_action: "direct_merge" });
  if (r.status >= 400 && r.status !== 409) throw Object.assign(new Error(`HTTP ${r.status}: ${String(r.body?.message ?? "").slice(0, 300)}`), { status: r.status });
  if (r.status !== 202) throw unanswered(`HTTP ${r.status}`);
  const details = r.body?.details ?? {};
  if (r.body?.status === "pending" && details.uuid) store.set(key, String(details.uuid));
  const sha = await settle(String(details.uuid ?? ""), String(r.body?.status ?? ""), details);
  if (sha) return sha;
  throw unanswered("the request is gone");
}
