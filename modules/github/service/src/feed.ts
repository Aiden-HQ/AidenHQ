// The change feed (docs/superpowers/specs/2026-11-24-github-change-feed-design.md §1, §2): the one timer-driven reader of GitHub.
// Each watched repo (the managed repos, and every routine's and module's subscribed resources) is read with conditional requests
// (a 304 is free), diffed against its saved snapshot, and what changed becomes typed events: saved to an outbox in the same atomic
// write as the new snapshots (cache/feed.json), then sent to the kernel's event router (POST /v1/events) oldest first. A send the
// kernel didn't answer stays in the outbox for the next pass; one it refused for good (4xx) is dropped and recorded.
//
// The same events reach this process's own consumers in-process (`hooks`: Flow's facts, the design reviews' sweep, the release
// train), after they are saved.
//
// One scheduler runs every job, oldest due first: each repo's pass (15 s after a change, doubling while quiet, at most 60 s), the
// watched set (every minute), the health runs (every 5 minutes, src_meta.ingest_run `github_feed`, `repo:<r>`), and the
// background jobs (the src_github sync and Flow's churn and backfill, every 15 minutes), which never hold up a repo's pass. A
// secondary rate limit pauses the whole scheduler until GitHub's time.
//
// A repo's first read (newly watched, or its state lost) is a baseline: snapshots recorded, nothing emitted but `github.resync`.
// A lost state file (missing where the feed ran before, its feed.started marker, or unreadable) is also recorded as a loss.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { namedChecks } from "./aidenhq-sdk/checks.ts";
import type { Kind } from "./flow.ts";

type Json = any;
/** GitHub as the owner (the process's one client, background reads). */
export type FeedGh = (method: string, path: string, body?: unknown, o?: { background?: boolean; etag?: string; caller?: string; deadline?: number }) => Promise<{ status: number; body: any; headers?: Headers }>;
/** JSON drops an undefined value: what the kernel validates is the rest. */
export type FeedData = Record<string, string | number | boolean | null | undefined | (string | number)[]>;
/** An event as the kernel takes it (kernel/src/events.ts SourceEvent), connection "github". */
export type FeedEvent = { resource: string; id: string; kind: string; author?: string; text?: string; truncated?: boolean; labels?: string[]; bot?: boolean; url?: string; data?: FeedData };
/** What the hooks get beside an event: the closed PR as GitHub returned it (`pull_request.closed`). */
export type FeedContext = { pr?: Json };
export type Hook = (e: FeedEvent, ctx: FeedContext) => void | Promise<void>;

type Pr = { n: number; head: string; base: string; base_ref: string; head_ref: string; draft: boolean; fork: boolean; title: string; body: string; author: string; association: string; labels: string[]; created_at: string; url: string; author_kind?: Kind };
type Run = { id: number; name: string; suite: number; status: string; conclusion: string | null; started: string | null; completed: string | null };
type Status = { id: number; context: string; state: string; at: string };
type Review = { id: number; n: number; state: string; commit: string; author: string; url: string };
type Page = { etag: string; items: Json[]; full: boolean };
type Head = { first: number; read: number; settled: boolean; runs: Record<string, Run>; statuses: Record<string, Status>; reviews: Record<string, Review>; pages: Record<string, Page> };
type RepoState = {
  base: number; every: number; due: number;
  pages: Record<string, Page>; prs: Record<string, Pr>; closed: number[];
  cursors: { issues: string; comments: string; review_comments: string }; cursorTags: Record<string, string>;
  sent: Record<string, number>; top: string; branch?: string; tip?: string; heads: Record<string, Head>;
  /** The last pass that completed; when the repo's metadata was last read. */
  okAt?: number; metaAt?: number;
};
type State = { gen: string; k: Record<string, number>; outbox: (FeedEvent & { at: number })[]; repos: Record<string, RepoState> };
type Window = { passes: number; ok: number; sent: number; loss?: string; err?: string };

export const QUICK_MS = 15_000, QUIET_MAX_MS = 60_000, SETTLED_MS = 5 * 60_000, YOUNG_MS = 10 * 60_000, PAGES_MAX = 10;
const KEEP_SENT_MS = 2 * 86_400_000, HEALTH_MS = 5 * 60_000, STALL_MS = 10 * 60_000, BACKGROUND_MS = 15 * 60_000, WATCH_MS = 60_000;
const TEXT_MAX = 2000;
const clip = (t: string) => (t.length > TEXT_MAX ? { text: t.slice(0, TEXT_MAX), truncated: true } : { text: t });
const short = (v: unknown) => String(v ?? "").slice(0, 200);
const bot = (login: string) => /\[bot\]$/i.test(login);

export type FeedOptions = {
  gh: FeedGh; cacheDir: string;
  /** The kernel with this module's token: GET /v1/events/sources, POST /v1/events. */
  kernel: { call(method: string, path: string, body?: unknown): Promise<any>; raw(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> };
  /** The repos the code host manages (always watched); empty while GitHub isn't connected. */
  managed: () => Promise<string[]>;
  /** Who an author is (flow.ts kindOf). */
  kindOf: (who: string, association: string, repo: string, seen?: { number?: number; body?: string }) => Promise<Kind>;
  hooks?: Hook[];
  /** One src_meta.ingest_run (SourceStore.run): `fn` answers the rows or throws the run's failure. */
  record?: (scope: string, fn: () => Promise<number>) => Promise<unknown>;
  /** Background jobs on the same scheduler, each every 15 minutes after `first` ms: never awaited by a repo's pass. */
  background?: { name: string; first: number; run: () => Promise<void> }[];
  now?: () => number; log?: (msg: string, f?: Record<string, unknown>) => void;
};

export function createFeed(o: FeedOptions) {
  const now = o.now ?? Date.now, log = o.log ?? (() => {});
  const file = join(o.cacheDir, "feed.json"), marker = join(o.cacheDir, "feed.started");
  let lost = false;
  const load = (): State => {
    try { if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8")); } catch (e) { lost = true; log("feed: state unreadable, every repo starts afresh", { err: String((e as Error).message).slice(0, 200) }); }
    // A cache dir the feed already ran in (its marker) whose state file is missing: lost, not new.
    if (existsSync(marker)) lost = true;
    return { gen: randomUUID().slice(0, 8), k: {}, outbox: [], repos: {} };
  };
  const state = load();
  if (!existsSync(marker)) writeFileSync(marker, new Date(now()).toISOString());
  const save = () => { writeFileSync(`${file}.tmp`, JSON.stringify(state)); renameSync(`${file}.tmp`, file); };
  const windows = new Map<string, Window>();
  const win = (repo: string) => { let w = windows.get(repo); if (!w) windows.set(repo, (w = { passes: 0, ok: 0, sent: 0 })); return w; };
  const loss = (repo: string, why: string) => { win(repo).loss ??= why; log("feed: loss", { repo, why }); };
  let watched: string[] = [];
  /** Writes this process made, per repo (true: they unsettle its heads), kept until a pass's new state carries them. */
  const touched = new Map<string, boolean[]>();
  const applyTouch = (rs: RepoState, heads: boolean) => {
    rs.every = QUICK_MS;
    rs.due = Math.min(rs.due, now() + QUICK_MS);
    if (heads) for (const h of Object.values(rs.heads)) h.settled = false;
  };
  let pausedUntil = 0;

  /** The next id of an inferred transition of `key` (`<repo>#<n>:head`…): unique per state file and occurrence. */
  const nextId = (key: string) => `${key}:${state.gen}.${(state.k[key] = (state.k[key] ?? 0) + 1)}`;

  /** One conditional GET: a 304 answers undefined. Never sleeps on a limit: a rate-limited refusal throws (the scheduler pauses). */
  async function get(path: string, etag?: string): Promise<{ body: any; etag: string } | undefined> {
    // The feed's reads skip the reserve down to a small floor (client.ts): any rate-limited refusal pauses the whole scheduler.
    const r = await o.gh("GET", path, undefined, { background: true, caller: "feed", deadline: now(), ...(etag ? { etag } : {}) });
    if (r.status === 304) return undefined;
    // A feature the repo has turned off (Issues: 410 Gone) is an empty list, not a failed pass.
    if (r.status === 410) return { body: [], etag: "" };
    if (r.status >= 300) throw new Error(`GitHub GET ${path.split("?")[0]}: ${r.status} ${String(r.body?.message ?? "").slice(0, 120)}`.trim());
    return { body: r.body, etag: r.headers?.get("etag") ?? "" };
  }
  /** A snapshot list, every page conditional on its own ETag; pages kept in `pages` (each page's items as `map` keeps them). */
  async function snapshot<T>(pages: Record<string, Page>, path: string, map: (x: Json) => T, pick: (b: Json) => Json[] = (b) => b, used?: Set<string>): Promise<T[]> {
    const out: T[] = [];
    for (let page = 1; ; page++) {
      const url = `${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`;
      used?.add(url);
      const saved = pages[url];
      const r = await get(url, saved?.etag);
      if (r) { const raw = pick(r.body) ?? []; pages[url] = { etag: r.etag, items: raw.map(map), full: raw.length >= 100 }; }
      const p = pages[url]!;
      out.push(...(p.items as T[]));
      if (!p.full) return out;
    }
  }
  /**
   * A cursor list (sort=updated, oldest first) from `since`: at most PAGES_MAX pages; page one conditional (its URL changes only
   * when the cursor moves). A quiet list's cursor is moved up to a minute before the read once it is a day old, so only a reader
   * that was down shows a cursor over 2 days old: a loss, since creations older than the window are not announced.
   */
  async function cursor(repo: string, rs: RepoState, key: keyof RepoState["cursors"], path: string, each: (x: Json) => Promise<void>) {
    const since = rs.cursors[key], started = now();
    if (started - Date.parse(since) > KEEP_SENT_MS) loss(repo, `the ${key} cursor is over 2 days old: creations older than that were not announced`);
    let newest = since;
    for (let page = 1; page <= PAGES_MAX; page++) {
      const r = await get(`${path}&since=${since}&per_page=100&page=${page}`, page === 1 ? rs.cursorTags[key] : undefined);
      const items: Json[] = !r ? [] : Array.isArray(r.body) ? r.body : [];
      if (r && page === 1) rs.cursorTags[key] = r.etag;
      for (const x of items) { await each(x); if (String(x.updated_at) > newest) newest = String(x.updated_at); }
      if (items.length < 100) {
        const floor = new Date(started - 60_000).toISOString().replace(/\.\d{3}Z$/, "Z");
        if (started - Date.parse(newest) > 86_400_000 && floor > newest) newest = floor;
        break;
      }
    }
    if (newest !== since) { rs.cursors[key] = newest; delete rs.cursorTags[key]; }
  }
  /** Created after the repo's baseline, inside the 2-day window, and never sent: a creation to announce (its key remembered). */
  const fresh = (rs: RepoState, key: string, created: string) => {
    const at = Date.parse(created);
    if (!(at > rs.base && now() - at < KEEP_SENT_MS) || rs.sent[key]) return false;
    rs.sent[key] = now();
    return true;
  };

  const prOf = (repo: string) => (p: Json): Pr => ({
    n: Number(p.number), head: String(p.head?.sha ?? ""), base: String(p.base?.sha ?? ""), base_ref: short(p.base?.ref), head_ref: short(p.head?.ref), draft: Boolean(p.draft),
    fork: String(p.head?.repo?.full_name ?? "").toLowerCase() !== repo, title: String(p.title ?? ""), body: String(p.body ?? "").slice(0, TEXT_MAX + 1),
    author: String(p.user?.login ?? "ghost"), association: String(p.author_association ?? ""), labels: (p.labels ?? []).map((l: Json) => short(l.name)).slice(0, 10), created_at: String(p.created_at ?? ""), url: String(p.html_url ?? ""),
  });
  const record = (p: Pr): FeedData => ({ number: p.n, head: p.head, base: p.base, base_ref: p.base_ref, head_ref: p.head_ref, draft: p.draft, fork: p.fork, author_kind: p.author_kind ?? "outside" });

  /** One repo's pass: read, diff, save (snapshots and outbox together), then the hooks see what's new. */
  async function pass(repo: string): Promise<FeedEvent[]> {
    const first = !state.repos[repo];
    // Touches made before now are in the state this pass starts from.
    touched.delete(repo);
    const t = now(), iso = new Date(t).toISOString().replace(/\.\d{3}Z$/, "Z");
    // A working copy: nothing is kept unless the whole pass succeeds.
    const rs: RepoState = first
      ? { base: t, every: QUICK_MS, due: t, pages: {}, prs: {}, closed: [], cursors: { issues: iso, comments: iso, review_comments: iso }, cursorTags: {}, sent: {}, top: "", heads: {} }
      : structuredClone(state.repos[repo]!);
    const out: { ev: FeedEvent; ctx: FeedContext }[] = [];
    const emit = (ev: Omit<FeedEvent, "resource">, ctx: FeedContext = {}) => { if (!first) out.push({ ev: { ...ev, resource: repo }, ctx }); };
    const used = new Set<string>();

    // 1. Open PRs: new, moved, flipped, retitled, closed, reopened.
    const open = await snapshot(rs.pages, `/repos/${repo}/pulls?state=open`, prOf(repo), undefined, used);
    const was = rs.prs, now_: Record<string, Pr> = {};
    for (const p of open) {
      const before = was[p.n];
      p.author_kind = before?.author_kind ?? (await o.kindOf(p.author, p.association, repo, { number: p.n, body: p.body }));
      now_[p.n] = p;
      const base = { author: p.author, bot: bot(p.author), url: p.url, ...clip(p.title) };
      if (!before) {
        const reopened = rs.closed.includes(p.n);
        if (reopened) emit({ ...base, id: nextId(`${repo}#${p.n}:reopened`), kind: "pull_request.reopened", data: record(p) });
        else emit({ ...base, ...clip(`${p.title}\n\n${p.body}`), id: `${repo}#${p.n}:opened`, kind: "pull_request.opened", data: record(p), ...(p.labels.length ? { labels: p.labels } : {}) });
        rs.closed = rs.closed.filter((n) => n !== p.n);
        continue;
      }
      if (before.head !== p.head) emit({ ...base, id: nextId(`${repo}#${p.n}:head`), kind: "pull_request.synchronize", data: { ...record(p), before: before.head } });
      if (before.draft !== p.draft) emit({ ...base, id: nextId(`${repo}#${p.n}:draft`), kind: p.draft ? "pull_request.converted_to_draft" : "pull_request.ready_for_review", data: record(p) });
      if (before.title !== p.title) emit({ ...base, id: nextId(`${repo}#${p.n}:title`), kind: "pull_request.edited", data: record(p) });
    }
    for (const [n, p] of Object.entries(was)) {
      if (now_[n]) continue;
      const g = await get(`/repos/${repo}/pulls/${n}`);
      // Missing from the open list but still open (the list shifted between pages): kept, never a false close.
      if (g?.body?.state !== "closed") { now_[n] = p; continue; }
      const closedAt = String(g?.body?.closed_at ?? iso);
      emit({ author: p.author, bot: bot(p.author), url: p.url, ...clip(p.title), id: `${repo}#${n}:closed:${closedAt}`, kind: "pull_request.closed", data: { ...record({ ...p, head: String(g?.body?.head?.sha ?? p.head) }), merged: Boolean(g?.body?.merged_at), merge_sha: g?.body?.merge_commit_sha ? String(g.body.merge_commit_sha) : null } }, { pr: g?.body });
      rs.closed = [...rs.closed, Number(n)].slice(-200);
    }
    rs.prs = now_;

    // 2. Issues opened (the cursor list of issues and PRs updated; PRs come from the snapshot above).
    await cursor(repo, rs, "issues", `/repos/${repo}/issues?state=all&sort=updated&direction=asc`, async (i) => {
      if (i.pull_request || !fresh(rs, `issue:${i.id}`, i.created_at)) return;
      const author = String(i.user?.login ?? "ghost"), labels = (i.labels ?? []).map((l: Json) => short(l.name)).slice(0, 10);
      const author_kind = await o.kindOf(author, String(i.author_association ?? ""), repo, { number: i.number, body: i.body });
      emit({ id: `${repo}#${i.number}:opened`, kind: "issues.opened", author, bot: bot(author), url: String(i.html_url ?? ""), ...clip(`${i.title ?? ""}\n\n${i.body ?? ""}`), ...(labels.length ? { labels } : {}), data: { number: i.number, author_kind, created_at: String(i.created_at), labels } });
    });

    // 3. Issue events (newest first, no `since`): back to the newest one read before.
    {
      const read: Json[] = [];
      // A baseline reads page one only, for where the list stands; nothing in it is announced.
      let reached = false, top = rs.top;
      for (let page = 1; page <= (first ? 1 : PAGES_MAX) && !reached; page++) {
        const r = await get(`/repos/${repo}/issues/events?per_page=100&page=${page}`, page === 1 ? rs.pages[`events:${repo}`]?.etag : undefined);
        if (!r) { reached = true; break; }
        if (page === 1) rs.pages[`events:${repo}`] = { etag: r.etag, items: [], full: false };
        const items: Json[] = Array.isArray(r.body) ? r.body : [];
        if (page === 1 && items[0]) top = String(items[0].id);
        for (const e of items) { if (rs.top && BigInt(e.id) <= BigInt(rs.top)) { reached = true; break; } read.push(e); }
        if (items.length < 100) reached = true;
      }
      used.add(`events:${repo}`);
      if (!reached && !first && rs.top) loss(repo, `over ${PAGES_MAX} pages of issue events in one pass: older ones were not sent`);
      if (!first) {
        for (const e of read.reverse()) {
          const pr = Boolean(e.issue?.pull_request), n = Number(e.issue?.number), actor = String(e.actor?.login ?? "ghost");
          const base = { id: `ev:${e.id}`, author: actor, bot: bot(actor), url: String(e.issue?.html_url ?? "") };
          if (e.event === "labeled" || e.event === "unlabeled") emit({ ...base, kind: `${pr ? "pull_request" : "issues"}.${e.event}`, data: { number: n, label: short(e.label?.name), actor } }, { pr: e });
          else if ((e.event === "closed" || e.event === "reopened") && !pr) emit({ ...base, kind: `issues.${e.event}`, data: { number: n, actor, state_reason: e.state_reason ? short(e.state_reason) : null } });
        }
      }
      rs.top = top;
    }

    // 4, 5. Comments: conversation and inline review comments created since the baseline (an edit emits nothing).
    await cursor(repo, rs, "comments", `/repos/${repo}/issues/comments?sort=updated&direction=asc`, async (c) => {
      if (!fresh(rs, `comment:${c.id}`, c.created_at)) return;
      const author = String(c.user?.login ?? "ghost"), url = String(c.html_url ?? "");
      emit({ id: `comment:${c.id}`, kind: "issue_comment.created", author, bot: bot(author), url, ...clip(String(c.body ?? "")), data: { number: Number(String(c.issue_url ?? "").split("/").pop()), pr: url.includes("/pull/"), author_kind: await o.kindOf(author, String(c.author_association ?? ""), repo, { body: c.body }), created_at: String(c.created_at) } });
    });
    await cursor(repo, rs, "review_comments", `/repos/${repo}/pulls/comments?sort=updated&direction=asc`, async (c) => {
      if (!fresh(rs, `review_comment:${c.id}`, c.created_at)) return;
      const author = String(c.user?.login ?? "ghost");
      emit({ id: `review_comment:${c.id}`, kind: "pull_request_review_comment.created", author, bot: bot(author), url: String(c.html_url ?? ""), ...clip(String(c.body ?? "")), data: { number: Number(String(c.pull_request_url ?? "").split("/").pop()), in_reply_to: c.in_reply_to_id ?? null, author_kind: await o.kindOf(author, String(c.author_association ?? ""), repo, { body: c.body }) } });
    });

    // 6. The default branch.
    // The repo itself (its default branch), conditional, every 5 minutes: a renamed or switched default is followed.
    used.add(`repo:${repo}`);
    if (!rs.branch || t - (rs.metaAt ?? 0) >= SETTLED_MS) {
      const m = await get(`/repos/${repo}`, rs.pages[`repo:${repo}`]?.etag);
      if (m) { rs.pages[`repo:${repo}`] = { etag: m.etag, items: [], full: false }; const b = String(m.body?.default_branch ?? ""); if (b !== rs.branch) { rs.branch = b; delete rs.pages[`branch:${repo}`]; } }
      rs.metaAt = t;
    }
    if (rs.branch) {
      const key = `branch:${repo}`;
      used.add(key);
      const r = await get(`/repos/${repo}/branches/${encodeURIComponent(rs.branch)}`, rs.pages[key]?.etag);
      const sha = r ? String(r.body?.commit?.sha ?? "") : rs.tip;
      if (r) rs.pages[key] = { etag: r.etag, items: [], full: false };
      if (sha && rs.tip && sha !== rs.tip) emit({ id: nextId(`${repo}:push`), kind: "push", data: { ref: `refs/heads/${rs.branch}`.slice(0, 200), before: rs.tip, after: sha } });
      if (sha) rs.tip = sha;
    }

    // 7-9. Heads: each open PR's and the default branch's, every pass while unsettled, every 5 minutes once settled.
    const shas = new Set([...Object.values(rs.prs).map((p) => p.head), ...(rs.tip ? [rs.tip] : [])].filter(Boolean));
    for (const sha of Object.keys(rs.heads)) if (!shas.has(sha)) delete rs.heads[sha];
    for (const sha of shas) {
      const known = rs.heads[sha];
      const h: Head = known ?? { first: t, read: 0, settled: false, runs: {}, statuses: {}, reviews: {}, pages: {} };
      rs.heads[sha] = h;
      if (known && h.settled && t - h.read < SETTLED_MS) continue;
      const prs = Object.values(rs.prs).filter((p) => p.head === sha).map((p) => p.n);
      const branch = sha === rs.tip && rs.branch ? { branch: short(rs.branch) } : {};
      const runs = await snapshot(h.pages, `/repos/${repo}/commits/${sha}/check-runs?filter=all`, (r): Run => ({ id: r.id, name: short(r.name), suite: Number(r.check_suite?.id ?? 0), status: String(r.status), conclusion: r.conclusion ?? null, started: r.started_at ?? null, completed: r.completed_at ?? null }), (b) => b?.check_runs);
      for (const r of runs) {
        if (r.status === "completed" && h.runs[r.id]?.status !== "completed") emit({ id: `check:${r.id}`, kind: "check_run.completed", data: { head: sha, name: r.name, conclusion: r.conclusion, prs, ...branch } });
        h.runs[r.id] = r;
      }
      const statuses = await snapshot(h.pages, `/repos/${repo}/commits/${sha}/statuses`, (s): Status => ({ id: s.id, context: short(s.context), state: String(s.state), at: String(s.created_at ?? "") }));
      for (const s of statuses) {
        if (!h.statuses[s.id]) emit({ id: `status:${s.id}`, kind: "status", data: { head: sha, context: s.context, state: s.state, prs, ...branch } });
        h.statuses[s.id] = s;
      }
      for (const n of prs) {
        const reviews = await snapshot(h.pages, `/repos/${repo}/pulls/${n}/reviews`, (v): Review => ({ id: v.id, n, state: String(v.state), commit: String(v.commit_id ?? ""), author: String(v.user?.login ?? "ghost"), url: String(v.html_url ?? "") }));
        for (const v of reviews) {
          if ((!h.reviews[v.id] || h.reviews[v.id]!.state === "PENDING") && v.state !== "PENDING") emit({ id: `review:${v.id}`, kind: "pull_request_review.submitted", author: v.author, bot: bot(v.author), url: v.url, data: { number: n, state: v.state, head: v.commit } });
          h.reviews[v.id] = v;
        }
      }
      h.read = t;
      const latest = latestStatuses(h);
      h.settled = Object.values(h.runs).every((r) => r.status === "completed") && latest.every((s) => s.state !== "pending") && t - h.first >= YOUNG_MS;
    }
    for (const k of Object.keys(rs.pages)) if (!used.has(k)) delete rs.pages[k];
    for (const [k, at] of Object.entries(rs.sent)) if (t - at > KEEP_SENT_MS) delete rs.sent[k];

    if (first) emitAlways(out, { resource: repo, id: `${repo}:resync:${iso}`, kind: "github.resync" });
    rs.every = out.length ? QUICK_MS : Math.min((rs.every || QUICK_MS) * 2, QUIET_MAX_MS);
    rs.due = now() + rs.every;
    // The in-process consumers first, on the new snapshot (each is idempotent: Flow's fact ids, the sweep, a re-read), so a crash
    // before the save repeats this diff and its hooks, never loses them.
    rs.okAt = now();
    state.repos[repo] = rs;
    // Writes made while this pass ran touched the old state: applied again to the new one.
    for (const heads of touched.get(repo) ?? []) applyTouch(rs, heads);
    touched.delete(repo);
    for (const { ev, ctx } of out) for (const h of o.hooks ?? []) {
      try { await h(ev, ctx); } catch (e) { log("feed: a hook failed", { kind: ev.kind, id: ev.id, err: String((e as Error).message).slice(0, 200) }); }
    }
    state.outbox.push(...out.map(({ ev }) => ({ ...ev, at: t })));
    save();
    return out.map((x) => x.ev);
  }
  const emitAlways = (out: { ev: FeedEvent; ctx: FeedContext }[], ev: FeedEvent) => void out.push({ ev, ctx: {} });

  /** The outbox to the kernel, oldest first: accepted (or a repeated id) leaves it; no answer, 5xx or 429 stops until the next send. */
  async function send() {
    let moved = 0;
    while (state.outbox.length) {
      const { at: _at, ...ev } = state.outbox[0]!;
      const r = await o.kernel.raw("POST", "/v1/events", { connection: "github", ...ev }).catch(() => ({ status: 0, json: {} }));
      // No answer, a 5xx, a 429, or a 401/404 the kernel gives while it restarts mid-apply: tried again later.
      if (r.status === 0 || r.status === 429 || r.status === 401 || r.status === 404 || r.status >= 500) break;
      if (r.status >= 300) { loss(ev.resource, `the kernel refused ${ev.kind} ${ev.id} (${r.status})`); log("feed: the kernel refused an event, dropped", { id: ev.id, kind: ev.kind, status: r.status, why: String(r.json?.error?.message ?? "").slice(0, 200) }); }
      else win(ev.resource).sent++;
      state.outbox.shift();
      moved++;
    }
    if (moved) save();
  }

  /** The watched set: the managed repos and every subscribed resource ("*": the managed ones), lower case. */
  async function watch() {
    // Only a set read whole replaces the last one: a failed read keeps watching (and keeps the state of) what was watched.
    let managed: string[], wanted: string[];
    try {
      managed = (await o.managed()).map((r) => r.toLowerCase());
      wanted = (await o.kernel.call("GET", "/v1/events/sources?connection=github")).resources ?? [];
    } catch (e) { log("feed: the watched set couldn't be read; kept", { err: String((e as Error).message).slice(0, 200) }); return; }
    watched = [...new Set([...managed, ...wanted.filter((r) => r !== "*" && /^[\w.-]+\/[\w.-]+$/.test(r)).map((r) => r.toLowerCase())])];
    for (const r of Object.keys(state.repos)) if (!watched.includes(r)) delete state.repos[r];
  }

  /** Each repo's window as one ingest_run: a loss fails it, else ok when any pass completed, else GitHub's last error. */
  async function health() {
    const stalled = state.outbox[0] && now() - state.outbox[0].at > STALL_MS;
    for (const repo of watched) {
      const w = win(repo);
      windows.delete(repo);
      await o.record?.(`repo:${repo}`, async () => {
        if (stalled) throw new Error("outbox stalled: kernel not accepting");
        if (w.loss) throw new Error(w.loss);
        if (!w.ok) throw new Error(w.err ?? "no pass completed in this window");
        return w.sent;
      }).catch(() => undefined);
    }
  }

  async function runRepo(repo: string) {
    const w = win(repo);
    w.passes++;
    if (lost && !state.repos[repo]) loss(repo, "baseline: the feed's state was lost");
    try {
      await pass(repo);
      w.ok++;
    } catch (e) {
      const need = (e as { need?: { cause?: string; until?: string } }).need;
      const until = need?.cause === "rate_limited" && need.until ? Date.parse(need.until) : 0;
      if (until) { pausedUntil = Math.max(pausedUntil, until); log("feed: paused for GitHub's rate limit", { until: need!.until }); }
      w.err = String((e as Error).message).slice(0, 300);
      const rs = state.repos[repo];
      if (rs) rs.due = Math.max(now() + QUIET_MAX_MS, until);
      log("feed: pass failed", { repo, err: w.err });
      if (!rs) failedFirst.set(repo, Math.max(now() + QUIET_MAX_MS, until));
    }
    await send();
  }
  const failedFirst = new Map<string, number>();

  let stopped = false;
  const timers = { watch: 0, send: 0, health: now() + HEALTH_MS, bg: new Map((o.background ?? []).map((b) => [b.name, now() + b.first])) };
  const running = new Set<string>();
  /** One step of the scheduler: the job due first, if any is due. Answers how long until the next one. */
  async function step(): Promise<number> {
    const t = now();
    // The outbox has its own retry, whether or not a repo is due or GitHub has paused the reads.
    if (state.outbox.length && timers.send <= t) { timers.send = t + QUICK_MS; await send(); }
    if (pausedUntil > t) return Math.min(pausedUntil - t, QUICK_MS);
    for (const b of o.background ?? []) {
      if ((timers.bg.get(b.name) ?? 0) <= t && !running.has(b.name)) {
        running.add(b.name);
        timers.bg.set(b.name, t + BACKGROUND_MS);
        void b.run().catch((e) => log(`feed: ${b.name} failed`, { err: String((e as Error).message ?? e).slice(0, 300) })).finally(() => running.delete(b.name));
      }
    }
    // The watched set lists the fleet org through the reserve: it never holds up a repo's pass.
    if (timers.watch <= t && !running.has("watch")) { timers.watch = t + WATCH_MS; running.add("watch"); void watch().finally(() => running.delete("watch")); }
    if (timers.health <= t) { timers.health = t + HEALTH_MS; await health(); }
    const due = watched.map((r) => [r, state.repos[r]?.due ?? failedFirst.get(r) ?? 0] as const).sort((a, b) => a[1] - b[1]);
    if (due[0] && due[0][1] <= t) { await runRepo(due[0][0]); return 0; }
    return Math.min(1000, ...due.map(([, d]) => d - t));
  }

  return {
    pass, send, watch, health, step,
    /** Runs the scheduler until stopped. */
    start() {
      void (async () => {
        if (state.outbox.length) await send();
        while (!stopped) {
          const wait = await step().catch((e) => { log("feed: scheduler step failed", { err: String((e as Error).message).slice(0, 300) }); return 5000; });
          if (wait > 0) await new Promise((r) => setTimeout(r, Math.max(50, wait)).unref?.());
        }
      })();
      return () => { stopped = true; };
    },
    /** A write this process made to `repo` (and, for a status, a re-run or an update-branch, its heads): read again within 15 s. */
    touch(repo: string, heads = false) {
      const key = repo.toLowerCase(), rs = state.repos[key];
      if (!rs) return;
      applyTouch(rs, heads);
      touched.set(key, [...(touched.get(key) ?? []), heads]);
    },
    /** The default branch's head and whether every check on it passed (undefined until the repo is read). */
    tip(repo: string): { tip?: string; green: boolean } | undefined {
      const rs = state.repos[repo.toLowerCase()];
      // Only a recent read is evidence (the settled head itself is read every 5 minutes).
      const h = rs?.tip ? rs.heads[rs.tip] : undefined;
      if (!rs?.tip || !h || now() - (rs.okAt ?? 0) > SETTLED_MS || now() - h.read > SETTLED_MS + QUIET_MAX_MS) return undefined;
      const checks = h ? namedChecks(rollup(h)) : [];
      return { tip: rs.tip, green: checks.length > 0 && checks.every((c) => c.ok && !c.pending) };
    },
    /** An open PR as the merge gate's GraphQL shape reads it (state, head, its head's rollup), from the snapshot; undefined if not open. */
    pr(repo: string, n: number): Json | undefined {
      const rs = state.repos[repo.toLowerCase()], p = rs?.prs[n];
      if (!p) return undefined;
      const h = rs.heads[p.head];
      return { state: "OPEN", headRefOid: p.head, commits: { nodes: [{ commit: { statusCheckRollup: h ? rollup(h) : { contexts: { nodes: [] } } } }] } };
    },
    /** A head's check runs, newest per (suite, name): for Flow's checks facts. */
    runs(repo: string, sha: string): Run[] {
      const h = state.repos[repo.toLowerCase()]?.heads[sha];
      return h ? latestRuns(h) : [];
    },
  };
}
export type Feed = ReturnType<typeof createFeed>;

/** Re-runs share their suite and name: the newest (highest id) is the one that counts. */
function latestRuns(h: Head): Run[] {
  const by = new Map<string, Run>();
  for (const r of Object.values(h.runs)) { const k = `${r.suite} ${r.name}`; if (!by.has(k) || by.get(k)!.id < r.id) by.set(k, r); }
  return [...by.values()];
}
function latestStatuses(h: Head): Status[] {
  const by = new Map<string, Status>();
  for (const s of Object.values(h.statuses)) if (!by.has(s.context) || by.get(s.context)!.id < s.id) by.set(s.context, s);
  return [...by.values()];
}
/** A head as GraphQL's statusCheckRollup (checks.ts reads it): newest runs and statuses. */
function rollup(h: Head) {
  return { contexts: { nodes: [
    ...latestRuns(h).map((r) => ({ __typename: "CheckRun", name: r.name, status: r.status.toUpperCase(), conclusion: r.conclusion ? r.conclusion.toUpperCase() : null })),
    ...latestStatuses(h).map((s) => ({ __typename: "StatusContext", context: s.context, state: s.state.toUpperCase() })),
  ] } };
}
