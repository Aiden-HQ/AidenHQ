// The real seams (seams.ts), each with this module's own token:
// - PRs and comments: github-mcp's internal read for this module (/internal/code-review/*, opened to the code-review module alone,
//   as the Maintainer's issue read is), as the owner's GitHub sign-in github-mcp holds.
// - Review runs: the kernel's credential-free check job `code-review` (POST /v1/checks; the recipe is lane E's), its Review read
//   from the finished check.
// - Posting: kernel write records (POST /v1/writes) of this module's kind code-review.post and .reply (Tier 0, the
//   instance-details check refuses leaked hosts and addresses), code-review.notice and .status (Tier 0, fixed words), which this service executes (executor@1) through github-mcp's
//   /internal/review routes.
// - The code host through the kernel (/v1/codehost/:op, this module's `codehost:` grant): snapshots (a tree's paths and the commit
//   it resolved; a pending deepsec setup branch's files) and the deepsec setup PR (`setup`: github files its own Tier 1 write).
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { lstatSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { KernelClient } from "./aidenhq-sdk/kernel-client.ts";
import { withoutInstanceDetails } from "./aidenhq-sdk/instance-details.ts";
import type { Executor } from "./aidenhq-sdk/executor.ts";
import type { CodeHost, Permission, Posted, Poster, PrComment, PrSource, PullRequest, Review, ReviewRunner, ReviewSpec, RunResult, Status, Thread } from "./seams.ts";

/** This module's write kinds (module.yaml writes), executed by this service through github-mcp's review routes. */
export const POST_KIND = "code-review.post";
export const ACK_KIND = "code-review.notice";
export const STATUS_KIND = "code-review.status";
export const REPLY_KIND = "code-review.reply";
/** The only files a deepsec setup PR may hold: what deepsec means to be committed (recipe/deepsec.ts setupPath; module.yaml
 * codehost.setup lists the same paths). */
export const SETUP_PATH = /^\.deepsec\/(\.gitignore|deepsec\.config\.ts|generated-matchers\.ts|package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|data\/[A-Za-z0-9_.-]+\/INFO\.md)$/;
/** The role whose agent (the Reviewer Manager) holds each PR's task, where its posts' approvals land. */
export const ROLE = "reviewer-manager";
/** A dedupe key as a wake's `id`: the kernel takes `[\w.-]{1,80}` and keys the row by it, so a resend is the same wake. */
const wakeId = (key: string) => createHash("sha256").update(key).digest("hex").slice(0, 40);

export function githubSource(base: string, token: () => string, fetcher: typeof fetch = fetch): PrSource {
  const get = async (path: string, q: Record<string, string | number>) => {
    const qs = new URLSearchParams(Object.entries(q).map(([k, v]) => [k, String(v)]));
    const r = await fetcher(`${base.replace(/\/+$/, "")}/internal/code-review/${path}?${qs}`, { headers: { authorization: `Bearer ${token()}` }, signal: AbortSignal.timeout(30_000) });
    // The status rides on the error: a 4xx (bar 408 and 429) is an answer, never retried; anything else is transient.
    if (!r.ok) throw Object.assign(new Error(`github-mcp ${path}: ${r.status} ${(await r.text()).slice(0, 200)}`), { status: r.status });
    return r.json();
  };
  return {
    open: async (repo) => ((await get("prs", { repo })) as { prs: PullRequest[] }).prs,
    get: async (repo, number) => ((await get("pr", { repo, number })) as { pr: PullRequest }).pr,
    snapshot: async (repo, number) => (await get("snapshot", { repo, number })) as Awaited<ReturnType<PrSource["snapshot"]>>,
    comments: async (repo, since) => (await get("comments", { repo, since })) as { comments: PrComment[]; cursor: string },
    permission: async (repo, login) => ((await get("permission", { repo, login })) as { permission: Permission }).permission,
    compare: async (repo, base, head) => (await get("compare", { repo, base, head })) as { merge_base: string; status: "ahead" },
    patchId: async (repo, base, head) => (await get("patch-id", { repo, base, head })) as { id: string | null },
    mergeBase: async (repo, number, head) => (await get("merge-base", { repo, number, head })) as { merge_base: string },
    postable: async (repo) => (await get("postable", { repo })) as { identity: "owner" | null; org: string },
    repos: async (q) => ((await get("repos", { q })) as { repos: { repo: string; private: boolean; url?: string }[] }).repos,
    threads: async (repo, number) => {
      const r = await fetcher(`${base.replace(/\/+$/, "")}/internal/review/threads`, { method: "POST", headers: { authorization: `Bearer ${token()}`, "content-type": "application/json" }, body: JSON.stringify({ repo, number }), signal: AbortSignal.timeout(30_000) });
      if (!r.ok) throw Object.assign(new Error(`github-mcp threads: ${r.status} ${(await r.text()).slice(0, 200)}`), { status: r.status });
      return ((await r.json()) as { threads: Thread[] }).threads;
    },
  };
}

/** The previous findings ride in PREVIOUS_FIELDS json spec fields (the kernel holds 16 KB each): `previous`, `previous_b`, … The
 * budget leaves room for an entry that doesn't fit the end of a field. */
export const PREVIOUS_FIELDS = 6, PREVIOUS_BUDGET = PREVIOUS_FIELDS * 13_500;
const FIELD_MAX = 15_000;
function shards(findings: unknown[]): Record<string, string> {
  let cut = 0;
  const out: unknown[][] = Array.from({ length: PREVIOUS_FIELDS }, () => []);
  let at = 0, size = 0;
  for (const f of findings) {
    const n = JSON.stringify(f).length + 1;
    // A finding that fits no field stays open (never marked fixed unseen); the first field says how many were left out.
    if (size + n > FIELD_MAX && out[at]!.length) { if (at === PREVIOUS_FIELDS - 1) { cut++; continue; } at++; size = 0; }
    out[at]!.push(f);
    size += n;
  }
  return Object.fromEntries(out.map((l, i) => [i ? `previous_${"bcdef"[i - 1]}` : "previous", JSON.stringify(i ? { findings: l } : { findings: l, cut })]));
}

/**
 * The check job's spec, by profile (module.yaml check_jobs; every declared field always sent, each a string of its kind).
 * `code-review` (a combo, or one model option: combo.engine `skill:<id>` with the catalog's harness and skill, or an engine):
 * base is the merge base, and a full review's incremental_from is that base too; the repo's ignore globs and max_nits ride in the
 * combo; the previous findings are those the recipe rechecks (and the finders take as already reported), full reviews included.
 * A tree review has no merge base: base and incremental_from are its head (the recipe diffs against the empty tree), and pr is
 * empty. option and lens are the catalog option's (empty for a combo); setup_files a pending deepsec setup branch's files.
 * `code-review-tools` (the selected tool options, token-free): the base (a tree's: the commit itself) and the options (toolSpec).
 * `code-review-ui` (the ui.scan option): the commit, the run, the option and its model. `code-review-plan` (a repo review's area plan): the commit, the planner's model and the catalog's stack tags with their globs.
 * A repo review's area run carries its area ({ id, name, files }) and a map option the plan's areas; both {} otherwise.
 */
export function checkSpec(s: ReviewSpec): Record<string, string> {
  const tree = s.target === "tree";
  const base = tree ? s.head : s.merge_base;
  // `run` keeps two reviews of one commit with one spec apart (the kernel reuses a check for an identical spec): empty for a PR run.
  if (s.profile === "code-review-tools") return { base, options: JSON.stringify(s.tools ?? {}), run: s.run ?? "" };
  if (s.profile === "code-review-ui") return { base, run: s.run ?? "", option: s.option ?? "", model: s.combo.model };
  if (s.profile === "code-review-plan") return { base, run: s.run ?? "", model: s.combo.model, stacks: JSON.stringify(s.stacks ?? {}) };
  return {
    base, run: s.run ?? "", incremental_from: tree ? base : s.incremental_from ?? base, pr: tree ? "" : String(s.number), target: tree ? "tree" : "pr",
    option: s.option ?? "", lens: s.lens ?? "", setup_files: JSON.stringify(s.setup_files ?? {}), deepsec_data: s.deepsec_data ?? "",
    area: JSON.stringify(s.area ?? {}), area_map: JSON.stringify(s.area_map ?? {}), unseen: JSON.stringify(s.unseen ?? {}),
    combo: JSON.stringify({ ...s.combo, ignore: s.ignore, max_nits: s.max_nits, mandatory: s.mandatory }), focus: s.focus ?? "",
    // The kernel's text kind: no control characters but newline and tab, at most 2000 (a PR body is often CRLF).
    intent: s.intent.replace(/\r\n?/g, "\n").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "").slice(0, 2000),
    threads: s.threads.replace(/\r\n?/g, "\n").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "").slice(0, 2000),
    ...shards(s.previous),
  };
}

export function kernelRunner(kernel: KernelClient): ReviewRunner {
  return {
    async start(s) {
      const v = await kernel.call("POST", "/v1/checks", { repo: s.repo, head: s.head, run: s.profile, spec: checkSpec(s) });
      return { check: String(v.id) };
    },
    async result(check): Promise<RunResult> {
      // billed_usd: the kernel's own billing of the check job's model token (so far, while it runs); the box's Review says what it spent too, never trusted.
      const v = (await kernel.call("GET", `/v1/checks/${check}`)) as { state: string; receipt: { verdict: string; summary: string } | null; error: string | null; result?: Review; expired?: boolean; billed_usd?: number; waiting?: boolean; box_at?: string | null };
      const billed = { ...(typeof v.billed_usd === "number" ? { billed_usd: v.billed_usd } : {}), ...(v.box_at ? { box_at: v.box_at } : {}) };
      if (v.state === "running") return { state: "running", ...billed, ...(v.waiting ? { waiting: true } : {}) };
      if (v.state === "done" && v.receipt?.verdict === "pass" && v.result?.version === 1) return { state: "done", review: v.result, ...billed };
      // A check that failed before it got a box (its snapshot couldn't be read, a restart) ran nothing, so spent nothing.
      return { state: "failed", why: (v.error ?? (v.expired ? "the check's result expired (the kernel keeps results 14 days)" : v.receipt?.summary) ?? `the check ended ${v.state}`).slice(0, 300), ...billed, ...(!v.box_at && billed.billed_usd === undefined ? { billed_usd: 0 } : {}) };
    },
    async input(data) { return String((await kernel.upload("/v1/checks/inputs", data)).sha256); },
    async kept(check) {
      try { return await kernel.bytes(`/v1/checks/${check}/kept`); } catch (e) { if ((e as { status?: number }).status === 404) return undefined; throw e; }
    },
  };
}

/** A reason as the notice's fixed words name it (seams' `why` starts with its key): a skip's, or a refused post's. */
export function reasonOf(why: string | undefined): "post_refused" | "draft" | "fork" | "superseded" | "stopped" | "push_cap" | undefined {
  const w = String(why ?? "");
  // A post the kernel refused after its review ran (refused, stale, rejected): the run row keeps the reason, the PR's notice
  // says in fixed words that this head's review was not posted. Checked first: its words are never read as a skip's.
  if (/^not posted:/.test(w)) return "post_refused";
  if (/^push review cap reached:/.test(w)) return "push_cap";
  const key = w.split(":")[0]!;
  return ["draft", "fork", "superseded", "stopped"].includes(key) ? (key as "draft" | "fork" | "superseded" | "stopped") : undefined;
}

/**
 * Posting as kernel write records of this module's own kinds (module.yaml writes): `code-review.post` (Tier 0, filed on
 * the PR's task, one per PR for the Reviewer Manager) and `code-review.notice` (Tier 0, fixed words).
 * The target (repo, pr, head) is always the run's, never the review body's.
 */
/** The need a refused post's outcome named, when github-mcp carried one (needs_owner: restricted, expired, sso, scope). */
function needOf(text: string): Posted["need"] {
  const j = (() => { try { return JSON.parse(text); } catch { return undefined; } })() as { error?: unknown; need?: Record<string, unknown> } | undefined;
  if (!j || j.error !== "needs_owner" || !j.need || typeof j.need !== "object" || typeof j.need.cause !== "string") return undefined;
  const n = j.need;
  return { cause: n.cause as string, ...(typeof n.org === "string" ? { org: n.org } : {}), ...(typeof n.url === "string" ? { url: n.url } : {}), ...(typeof n.scope === "string" ? { scope: n.scope } : {}) };
}

/** A write record's state as a post's: done with an ok outcome is posted; failed, rejected, stale or cancelled is refused. */
function settled(r: { id: string; state: string; outcome?: { ok: boolean; text: string } | null }): Posted {
  if (r.state === "done") {
    if (r.outcome && !r.outcome.ok) {
      const need = needOf(r.outcome.text);
      return { state: "refused", why: `write ${r.id}: ${r.outcome.text.slice(0, 200)}`, retry: true, ...(need ? { need } : {}) };
    }
    // The executor's outcome (github-mcp review-post.ts): the review's link, the threads it resolved, the identity it posted as.
    let o: { review?: unknown; resolved?: unknown; identity?: unknown; comments?: unknown; ack_id?: unknown } = {};
    try { o = JSON.parse(r.outcome?.text ?? "{}"); } catch {}
    return { state: "posted", ...(typeof o.review === "string" && /^https:\/\/github\.com\//.test(o.review) ? { url: o.review } : {}), ...(typeof o.resolved === "number" ? { resolved: o.resolved } : {}), ...(o.identity === "owner" || o.identity === "app" ? { identity: o.identity } : {}), ...(Number.isInteger(o.ack_id) && (o.ack_id as number) > 0 ? { ack: o.ack_id as number } : {}), ...(Array.isArray(o.comments) ? { comments: o.comments.filter((c): c is number => Number.isInteger(c) && (c as number) > 0).slice(0, 200) } : {}) };
  }
  // Failed or stale (what it acted on changed, e.g. a restart between its approval and its run) may post when filed again; a
  // rejection is the AI reviewer's or the owner's answer, and a cancel is someone's decision.
  if (["failed", "rejected", "stale", "cancelled", "unknown"].includes(r.state)) {
    const need = r.outcome?.text ? needOf(r.outcome.text) : undefined;
    return { state: "refused", why: `write ${r.id} ${r.state}${r.outcome?.text ? `: ${r.outcome.text.slice(0, 200)}` : ""}`, ...(["failed", "stale", "unknown"].includes(r.state) ? { retry: true } : {}), ...(need ? { need } : {}) };
  }
  return { state: "pending" };
}

/** The review's fields `code-review.post` accepts (schemas/post.json `review`). */
const REVIEW_FIELDS = ["version", "repo", "pr", "base", "head", "engine", "model", "effort", "incremental_from", "full", "coverage", "findings", "withheld", "cost_usd", "stale_guidance"] as const satisfies readonly (keyof Review)[];

export function kernelPoster(kernel: KernelClient, log: (m: string, f?: Record<string, unknown>) => void = () => {}): Poster {
  const tasks = new Map<string, string>();
  // One task per PR on a watched repo (closed with the PR); a one-off elsewhere gets its own (`run`), closed once its post settles.
  const taskOf = async (repo: string, n: number, run?: string) => {
    const key = `${repo}#${n}${run ? `:${run}` : ""}`;
    if (!tasks.has(key)) {
      // Fixed text naming only the repo and number: the PR's own title and body are a stranger's words.
      // Quiet: it only holds the posts' approval records, so it wakes nobody; closed with the PR (close below).
      const t = await kernel.call("POST", "/v1/tasks", { title: `Code review: ${key}`, description: `${key}\n\nCode review's posts on this pull request are approved here; its reviews and findings are on the board's Reviews page.`, role: ROLE, source: `code-review:${key}`, quiet: true });
      tasks.set(key, String(t.id));
    }
    return tasks.get(key)!;
  };
  // A GitHub thread is outside the instance, and a review quotes the PR's own text (a fixture's address, a CI path): the instance's
  // hosts, home paths and addresses are removed from the comment text it files (not the repo or a finding's path, which anchors the comment), so a quoted one never blocks the post. The kernel's
  // instance-details check refuses whatever this missed.
  // The instance-details check's denial is deterministic: asking again files the same text, so it is final (no `retry`). Any other
  // failure to file is retried as before.
  const filed = async (file: () => Promise<{ id: string; state: string }>): Promise<Posted> => {
    try { const r = await file(); return { ...settled(r), write: r.id }; } catch (e) {
      if ((e as { status?: number }).status === 422 && /check \(instance-details\)/.test(String((e as Error).message))) return { state: "refused", why: String((e as Error).message).slice(0, 300) };
      throw e;
    }
  };
  return {
    async post(p) {
      const t = p.target;
      // Threads to resolve: earlier findings the recipe's recheck found fixed (github-mcp resolves only Aiden's own, still unreported).
      // The review is the post kind's fields only (schemas/post.json is strict): the recipe's result also carries its own notes
      // (`addressed`, `guidance`) that no post renders, so what is sent is picked, never what is left after stripping.
      const { fixed } = p.review;
      const review = { ...Object.fromEntries(REVIEW_FIELDS.filter((k) => k in p.review).map((k) => [k, p.review[k]])), repo: t.repo, pr: t.number, head: t.head };
      const args = { repo: t.repo, pr: t.number, head: t.head, run: p.run, review, resolve: (fixed ?? []).filter((id) => typeof id === "string").slice(0, 200), gated: !!p.gated, own: (p.own ?? []).slice(0, 1000), first: !!p.first,
        ...(p.tier ? { tier: p.tier.tier, ...(p.tier.why ? { tier_why: p.tier.why.replace(/[`\r\n]/g, " ").slice(0, 500) } : {}) } : {}) };
      return filed(async () => (await kernel.call("POST", "/v1/writes", { kind: POST_KIND, args: withoutInstanceDetails(args), task: await taskOf(t.repo, t.number, t.once ? p.run : undefined) })) as { id: string; state: string });
    },
    async status(s: Status) {
      const r = (await kernel.call("POST", "/v1/writes", { kind: STATUS_KIND, args: { repo: s.repo, pr: s.number, head: s.head, reason: s.reason, important: s.important, running: s.running.slice(0, 8), ...(s.partial ? { partial: true } : {}) } })) as { id: string; state: string; outcome?: { ok: boolean; text: string } | null };
      return { ...settled(r), write: r.id };
    },
    async reply(p) {
      return filed(async () => (await kernel.call("POST", "/v1/writes", { kind: REPLY_KIND, args: withoutInstanceDetails({ repo: p.repo, pr: p.number, head: p.head, comment: p.comment, body: p.body }), task: await taskOf(p.repo, p.number) })) as { id: string; state: string });
    },
    async outcome(write) {
      return settled((await kernel.call("GET", `/v1/writes/${write}`)) as { id: string; state: string; outcome?: { ok: boolean; text: string } | null });
    },
    async ack(a) {
      // The notice speaks only in its fixed words: a phase (with a reason), or a command's answer (help, always, focus).
      const why = reasonOf(a.why);
      // A reason goes only where its phase can carry it: a skip's on a skip, the refusal's on a failed post. A run that failed on
      // budget keeps the generic failed notice rather than being turned into a skip reason its phase refuses (and so lost).
      const reason = a.state === "skipped" ? (why && why !== "post_refused" ? why : undefined) : a.state === "failed" ? (why === "post_refused" ? why : undefined) : undefined;
      if (a.state === "skipped" && !reason) return undefined;
      const r = (await kernel.call("POST", "/v1/writes", { kind: ACK_KIND, args: { ...(a.ack ? { ack: a.ack } : {}), repo: a.repo, pr: a.number, head: a.head, phase: a.state, ...(a.tier ? { tier: a.tier.tier, ...(a.tier.why ? { tier_why: a.tier.why.replace(/[`\r\n]/g, " ").slice(0, 500) } : {}) } : {}), ...(a.state === "answered" ? { answer: a.answer ?? "help" } : {}), ...(reason ? { reason } : {}), ...(a.combo ? { engine: a.combo.engine, model: a.combo.model, effort: a.combo.effort } : {}), ...(a.run ? { run: a.run } : {}), ...(a.review ? { review: a.review } : {}), ...(a.counts ?? {}) } })) as { id: string; state: string; outcome?: { ok: boolean; text: string } | null };
      // A notice is Tier 0 and runs inline, but the filing answers with the record as it was filed (`claimed`): the record read
      // back is what says whether the kernel took it. A refused notice throws, so a refused post's delivery retries it rather
      // than marking the pull request told; one still running comes back pending, with its id, for a later tick.
      const rec = await kernel.call("GET", `/v1/writes/${r.id}`).catch(() => r) as typeof r;
      const o = settled(rec);
      // A refusal that asking again cannot change (a schema or plan refusal is deterministic) carries a 4xx status: the delivery
      // ends after a few tries instead of polling for it while the PR stays open. One that can (a stale or failed notice record,
      // which the kernel files again) carries none, so it is retried as long as the pull request stands.
      if (o.state === "refused") throw Object.assign(new Error(`notice ${r.id} not posted: ${o.why ?? "refused"}`), o.retry ? {} : { status: 422 });
      return { ...o, write: r.id };
    },
    async notify(n) {
      // A notice on the requester's own task wakes its agent (role kernel.wake); with no task, the one notify reaches the owner.
      // Both carry the key: the owner alert dedupes by it, and the wake passes it as the wake notice's `id`, which the kernel reads
      // back from the task's thread — so a summary sent again after a crash between the send and its `sent` stamp wakes the agent
      // once, never twice.
      if (n.task) {
        // A task that is gone, done or cancelled hears nothing (a comment would reopen it): the summary goes to the owner instead.
        try {
          const r = (await kernel.call("POST", "/v1/wakes", { task: n.task, text: n.text, id: wakeId(n.dedupe_key) })) as { posted?: boolean; closed?: boolean };
          return r.closed ? "closed" : "sent";
        } catch (e) {
          if ((e as { status?: number }).status === 404) return "closed";
          throw e;
        }
      }
      await kernel.call("POST", "/v1/notify", { kind: "alert", text: n.text, dedupe_key: n.dedupe_key });
      return "sent";
    },
    async close(repo, n, why, run) {
      // The engine closes only a PR that had a post, so its task exists: filing the same source again finds it after a restart.
      const id = await taskOf(repo, n, run);
      await kernel.call("POST", `/v1/tasks/${id}/close`, { status: "done", body: why });
      tasks.delete(`${repo}#${n}${run ? `:${run}` : ""}`);
    },
  };
}

/**
 * executor@1 for this module's kinds: plan and execute go to github-mcp's internal review routes (as this module). Plan refuses a
 * record that isn't this service's own (requested by the code-review module, naming a run whose repo, PR and head it repeats), so
 * no other requester can post a review through these kinds.
 */
export function reviewExecutor(github: (op: "preview" | "execute", body: unknown) => Promise<any>, runOf: (id: string) => { repo: string; number: number; head: string } | undefined): Executor {
  const kindOf = (k: string) => (k === POST_KIND ? "post" : k === ACK_KIND ? "notice" : k === STATUS_KIND ? "status" : k === REPLY_KIND ? "reply" : undefined);
  return {
    async plan(req) {
      const kind = kindOf(req.kind);
      const a = (req.args ?? {}) as { repo?: string; pr?: number; head?: string; run?: string };
      if (!kind) throw new Error(`not a code-review kind: ${req.kind}`);
      if (req.requester?.kind !== "module" || req.requester.module !== "code-review") throw new Error("only the code-review service files these");
      const run = a.run ? runOf(a.run) : undefined;
      if (kind === "post" && (!run || run.repo !== String(a.repo).toLowerCase() || run.number !== a.pr || run.head !== a.head)) throw new Error(`the ${kind} doesn't match its run`);
      const v = (await github("preview", { kind, args: req.args })) as { facts?: Record<string, unknown>; targets?: Record<string, unknown> };
      return { args: req.args, ...(v.facts ? { facts: v.facts } : {}), ...(v.targets ? { targets: v.targets } : {}) };
    },
    async execute(rec) {
      const kind = kindOf(rec.kind);
      if (!kind) return { ok: false, text: `not a code-review kind: ${rec.kind}` };
      // Aiden's own threads are told apart by their marker and author (github-mcp review-post.ts), never by the kernel's records,
      // which keep only a code host's objects.
      let v: { ok?: boolean; text?: string };
      try {
        v = (await github("execute", { kind, args: rec.args })) as { ok?: boolean; text?: string };
      } catch (e) {
        // github-mcp's review route answers a need only the owner can fix as needs_owner (review-need.ts): its JSON goes to the
        // kernel's record as the failure's text, so the engine (and the requester's summary) knows the one action that unblocks it.
        const need = (e as { need?: unknown }).need;
        if (need && typeof need === "object") return { ok: false, text: JSON.stringify({ error: "needs_owner", need, detail: String((e as Error).message).slice(0, 300) }) };
        throw e;
      }
      return { ok: v.ok === true, text: String(v.text ?? "") };
    },
  };
}

const SETUP_BODY = "deepsec's own set-up files (`.deepsec/`), written by `deepsec init` during a code review of this repository: its config, the matchers it generated and its summary of the repo. Merging them lets later reviews scan with them instead of setting up again. Nothing outside `.deepsec/` changes.";

/**
 * The code host through the kernel (POST /v1/codehost/:op, this module's `codehost:` grant). A snapshot's tarball is read as it
 * streams (never held whole): `tree` lists its paths, `setupBranch` takes only deepsec's allowlisted files from the setup branch
 * (absent: no such branch, or none with an open PR). `setup` asks for the deepsec setup PR; github files its own Tier 1 write for it.
 */
export function kernelCodeHost(kernelUrl: string, token: () => string, kernel: KernelClient, fetcher: typeof fetch = fetch): CodeHost {
  const op = (name: string, body: unknown) => fetcher(`${kernelUrl.replace(/\/+$/, "")}/v1/codehost/${name}`, { method: "POST", headers: { authorization: `Bearer ${token()}`, "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(10 * 60_000) });
  /** The snapshot of repo@ref through `tar args`; undefined when the code host has no such ref (404). */
  const snapshot = async <T>(repo: string, ref: string, args: string[], read: (out: string) => T, onCommit?: (sha: string) => void): Promise<{ sha: string; value: T } | undefined> => {
    const r = await op("snapshot", { repo, ref });
    if (r.status === 404) return undefined;
    if (!r.ok || !r.body) throw Object.assign(new Error(`the snapshot of ${repo}@${ref.slice(0, 40)}: ${r.status} ${(await r.text().catch(() => "")).slice(0, 200)}`), { status: r.status });
    const sha = r.headers.get("x-aidenhq-commit") ?? "";
    if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`the snapshot of ${repo} named no commit`);
    onCommit?.(sha);
    const out = await new Promise<string>((resolve, reject) => {
      // Bytes, decoded once (a multi-byte character can straddle two chunks); more than the cap is an error, never a silent cut.
      const chunks: Buffer[] = [];
      let bytes = 0, err = "";
      const t = spawn("tar", args, { stdio: ["pipe", "pipe", "pipe"] });
      t.stdout.on("data", (b: Buffer) => { bytes += b.length; if (bytes <= 64_000_000) chunks.push(b); });
      t.stderr.on("data", (b: Buffer) => (err = (err + b.toString("utf8")).slice(0, 1000)));
      t.stdin.on("error", () => {}); // tar ended early: its close says why
      t.on("error", reject);
      // GNU tar exits 2 when a pattern matched nothing: no files, not a failure.
      t.on("close", (code) => {
        if (bytes > 64_000_000) return reject(new Error(`the snapshot of ${repo} has more than 64 MB of output`));
        if (code === 0 || /Not found in archive/.test(err)) resolve(Buffer.concat(chunks).toString("utf8"));
        else reject(new Error(`the snapshot of ${repo} didn't unpack: ${err.trim().slice(0, 200) || `tar ${code}`}`));
      });
      // A source that fails (the code host drops, a timeout) ends tar too, or it waits for the rest of the archive for good.
      Readable.fromWeb(r.body as never).on("error", (e) => { t.kill("SIGKILL"); reject(e); }).pipe(t.stdin);
    });
    return { sha, value: read(out) };
  };
  return {
    async tree(repo, ref, onCommit) {
      const s = await snapshot(repo, ref, ["-tzf", "-"], (out) => {
        const paths = out.split("\n").filter((l) => l && !l.endsWith("/")).map((l) => l.replace(/^\.\//, ""));
        if (paths.length > 200_000) throw new Error(`${repo} has more than 200,000 files: a review reads at most that many`);
        return paths;
      }, onCommit);
      if (!s) throw Object.assign(new Error(`${repo} has no ${ref.slice(0, 40)}`), { status: 404 });
      return { sha: s.sha, paths: s.value };
    },
    async setupBranch(repo, branch) {
      // The branch counts only while a PR is open on it: one closed unmerged leaves its branch behind, and is asked for again.
      const prs = await op("read", { repo, kind: "prs" });
      if (!prs.ok) throw new Error(`the open PRs of ${repo}: ${prs.status} ${(await prs.text().catch(() => "")).slice(0, 200)}`);
      if (!((await prs.json()) as { head_ref?: string | null; head_repo?: string | null }[]).some((p) => p.head_ref === branch && p.head_repo?.toLowerCase() === repo.toLowerCase())) return undefined;
      // A first pass lists the branch; only its regular, allowlisted files are then unpacked, by exact name, from the commit the
      // listing named. A link member is never unpacked, so nothing a link points at can be written through.
      const listed = await snapshot(repo, branch, ["-tvzf", "-"], (out) => out.split("\n").flatMap((l) => {
        const m = /^-\S+\s+\S+\s+(\d+)\s+\S+\s+\S+\s+(\.deepsec\/\S+)$/.exec(l);
        return m && SETUP_PATH.test(m[2]!) && Number(m[1]) <= 2_000_000 ? [m[2]!] : [];
      }));
      if (!listed) return undefined;
      const files: Record<string, string> = {};
      if (!listed.value.length) return { tip: listed.sha, files };
      const dir = mkdtempSync(join(tmpdir(), "deepsec-setup-"));
      try {
        if (!(await snapshot(repo, listed.sha, ["-xzf", "-", "-C", dir, "--no-same-owner", "--", ...listed.value], () => undefined))) return undefined;
        // A name the archive lists twice (a regular file, then a link of the same name) unpacks as the last: only what is a regular
        // file on disk is read, never what a link points at.
        for (const p of listed.value) if (lstatSync(join(dir, p)).isFile()) files[p] = readFileSync(join(dir, p), "utf8");
        return { tip: listed.sha, files };
      } finally { rmSync(dir, { recursive: true, force: true }); }
    },
    async setup(b) {
      // The setup's approval lands on a quiet task per repo (the kernel's setup op names one; the same source is the same task).
      const t = await kernel.call("POST", "/v1/tasks", { title: `Code review: deepsec setup for ${b.repo}`, description: `${b.repo}\n\nCode review's deepsec setup PR is approved here.`, role: ROLE, source: `code-review:setup:${b.repo}`, quiet: true });
      // The code host waits five minutes for the approval, then answers 202 { pending }: asking again finds the same open record.
      let r: Response, j: Record<string, unknown>;
      for (let i = 0; ; i++) {
        r = await op("setup", { ...b, title: "chore: set up deepsec", body: SETUP_BODY, task: String(t.id) });
        j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
        if (r.status !== 202 || j.pending !== true) break;
        if (i >= 5) throw new Error(`the deepsec setup PR is still waiting for its approval (write ${String(j.write)})`);
      }
      if (!r.ok) throw new Error(`the deepsec setup PR: ${r.status} ${JSON.stringify(j).slice(0, 300)}`);
      return j;
    },
  };
}

/** github-mcp's internal review routes, as this module. A needs_owner answer rides on the thrown error as `need`. */
export function githubReview(base: string, token: () => string, fetcher: typeof fetch = fetch) {
  return async (op: "preview" | "execute", body: unknown) => {
    // An execute answers when the post is done, however long github-mcp's write queue and GitHub's rate limits take: it sends a
    // blank every 30 s meanwhile, so a stall (no bytes for fetch's body timeout) fails it, never a duration. A failure after the
    // headers is the body's `error`. Only the preview, which makes no GitHub write, gets a short timeout.
    const r = await fetcher(`${base.replace(/\/+$/, "")}/internal/review/${op}`, { method: "POST", headers: { authorization: `Bearer ${token()}`, "content-type": "application/json" }, body: JSON.stringify(body), ...(op === "preview" ? { signal: AbortSignal.timeout(120_000) } : {}) });
    // A body that can't be read (the connection dropped after the headers) rejects here: the outcome is unknown, never an empty one.
    const text = await r.text();
    const j = (() => { try { return JSON.parse(text); } catch { if (r.ok) throw new Error(`github-mcp review ${op}: an unreadable answer (${text.slice(0, 100)})`); return {}; } })();
    const e = j as { error?: string; detail?: unknown; need?: { detail?: unknown } };
    if (!r.ok || e.error) {
      // A need only the owner can fix rides on the thrown error, so the engine records it on the run and its summary names the fix.
      const need = e.need && typeof e.need === "object" ? e.need : undefined;
      const detail = String(e.detail ?? need?.detail ?? "").slice(0, 300);
      throw Object.assign(new Error(`github-mcp review ${op}: ${r.status} ${detail}`.trim()), need ? { need } : {});
    }
    return j;
  };
}
