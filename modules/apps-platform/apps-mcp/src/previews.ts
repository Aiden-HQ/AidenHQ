// Preview deploys: every open pull request on an agents-org app's repo (into its deploy branch, from the same repo) runs
// at its own URL, from the PR head, with the parent app's access rules. Nothing waits on a preview: the merge and the
// production deploy are untouched, previews run in their own loop, and a failed one only says so on the PR.
//
// A preview is the parent app derived under the name <app>-pr-<n> (reserved in the registry), so its compose project,
// network, volumes, checkout, deploy rows and warehouse login are its own. PR heads are unmerged code, so a preview gets:
// - its own empty warehouse schema and login (database: warehouse), never the live schema's: the app's migrations run
//   there at startup, and the schema and login are dropped with the preview;
// - a random placeholder for every other declared secret, never the parent's value;
// - no connects but the warehouse, no caps, no agent API (app_api targets registry apps only);
// - the parent's resource limits, at most PER_APP previews per app (the newest PRs), host ports from PREVIEW_PORTS.
// It is removed (containers, volumes, built images, checkout, secrets, schema and login) when the PR closes or merges,
// falls out of the newest PER_APP, or its app leaves the registry. The PR gets one comment with the URL, edited as it
// changes. Tailnet apps' previews are served by the apps' tailnet node at <APPS_URL_BASE>:<port>. A shared app's is at
// https://pr-<n>.<share.host> through the gate, with the app's own access, once the instance sets settings.edge.previews
// (scripts/edge.ts); apps-mcp tells the gate which previews run (platform.ts).
import { randomBytes } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { put } from "./database.js";
import { PREVIEW_NAME, PREVIEW_PORTS, type App } from "./registry.js";
import type { Engine } from "./deploy.js";
import type { RepoToken } from "./github-app.js";
import type { PreviewRow, Store } from "./store.js";

export const PER_APP = 3;
export const previewName = (app: string, pr: number): string => `${app}-pr-${pr}`;
/** A shared app's preview host, under its own (modules/apps-platform/gate/gate.ts derives it back the same way). */
export const previewHost = (host: string, pr: number): string => `pr-${pr}.${host}`;

/** The parent app as its PR's preview runs it (see the top of this file). */
export function previewApp(app: App, pr: number, port: number): App {
  return {
    ...app,
    name: previewName(app.name, pr),
    port,
    stateful: false,
    auto_deploy: false,
    caps: [],
    connects: app.database ? [app.database] : [],
    api: undefined,
    // Still shared, at its own host: never served on the tailnet, where the gate's access rules don't apply.
    ...(app.share?.host ? { share: { ...app.share, host: previewHost(app.share.host, pr) } } : {}),
    preview: { of: app.name, pr, published: app.port! },
  };
}

export interface OpenPr { number: number; sha: string; base: string; head_repo: string }
export interface GitHub {
  openPrs: (repo: string) => Promise<OpenPr[]>;
  /** Posts a comment, or edits comment `id`; the comment's id. */
  comment: (repo: string, pr: number, body: string, id?: number | null) => Promise<number>;
}

/** GitHub's REST API with the App's repo-narrowed token (contents read, pull_requests write: list and comment). */
export function githubApi(token: RepoToken, fetchImpl: typeof fetch = fetch): GitHub {
  const call = async (repo: string, method: string, path: string, body?: object): Promise<any> => {
    const t = await token(repo, "read", { pull_requests: "write" });
    const r = await fetchImpl(`https://api.github.com/repos/${repo}${path}`, {
      method,
      headers: { authorization: `Bearer ${t}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(20_000),
    });
    if (!r.ok) throw new Error(`GitHub ${method} ${path.split("?")[0]} on ${repo}: ${r.status}`);
    return r.json();
  };
  const post = async (repo: string, pr: number, body: string) => Number((await call(repo, "POST", `/issues/${pr}/comments`, { body })).id);
  return {
    openPrs: async (repo) => {
      const list = await call(repo, "GET", "/pulls?state=open&per_page=100");
      if (!Array.isArray(list)) throw new Error(`GitHub listed no pulls for ${repo}`);
      return list.map((p: any) => ({ number: Number(p.number), sha: String(p.head?.sha ?? ""), base: String(p.base?.ref ?? ""), head_repo: String(p.head?.repo?.full_name ?? "") }));
    },
    // A comment someone deleted is posted again.
    comment: async (repo, pr, body, id) => (id ? call(repo, "PATCH", `/issues/comments/${id}`, { body }).then((c) => Number(c.id), () => post(repo, pr, body)) : post(repo, pr, body)),
  };
}

export interface PreviewDeps {
  apps: () => App[];
  store: Store;
  engine: Pick<Engine, "preview" | "remove" | "draining">;
  github: GitHub;
  /** Is this repo in the instance's agents org? */
  agentsRepo: (repo: string) => boolean;
  /** Where a preview answers (the apps' tailnet node, or the gate); undefined when it can't be served. */
  url: (app: App) => string | undefined;
  secretsDir: string; // the vault's apps/ dir
  gitDir: string;
  /** The apps' tailnet node and the gate's previews file: exactly the healthy previews (platform.ts syncEdge). */
  syncEdge: () => Promise<void>;
  /** database: warehouse: drops a preview's login and schema (database.ts dropPreviewDatabase). */
  dropDb: (name: string) => Promise<void>;
  now?: () => number;
  log: { warn: (o: object, m: string) => void; info: (o: object, m: string) => void };
}

/** Apps that get previews: agents-org repos, local, with a URL a preview can have (the tailnet node, or the gate's previews). */
const eligible = (d: PreviewDeps, a: App): boolean => d.agentsRepo(a.repo) && !a.module && a.host === "local" && !!a.port && !!d.url(a);

const short = (e: unknown) => String((e as Error)?.message ?? e).replace(/\s+/g, " ").slice(0, 200);
const body = (app: App, pr: OpenPr, url: string | undefined, why?: string) =>
  why
    ? `**Preview** of \`${pr.sha.slice(0, 12)}\` didn't come up: ${why}. The next push tries again. Nothing waits on it.`
    : `**Preview** of \`${pr.sha.slice(0, 12)}\`: ${url}\n\nSame access as \`${app.name}\`. It has its own empty database (never the live data), placeholder secrets and no connections to other apps. It follows every push and is removed when this PR closes. Nothing waits on it.`;

/** A free host port for a new preview: not a registry app's, not another preview's. */
function freePort(d: PreviewDeps, rows: PreviewRow[]): number | undefined {
  const used = new Set([...rows.map((r) => r.port), ...d.apps().map((a) => a.port)]);
  for (let p = PREVIEW_PORTS.min; p <= PREVIEW_PORTS.max; p++) if (!used.has(p)) return p;
  return undefined;
}

/** Every declared secret but the database URLs (the preview's own login writes those) gets a random placeholder. */
function placeholders(d: PreviewDeps, app: App): void {
  for (const k of app.secrets.filter((k) => !k.endsWith("DATABASE_URL")))
    if (!existsSync(`${d.secretsDir}/${app.name}/${k}`)) put(`${d.secretsDir}/${app.name}`, k, randomBytes(24).toString("hex"));
}

/**
 * The PR's one comment on its preview, posted or edited. One never posted is tried again next tick; a failed edit is left
 * (the comment there still has the preview's URL, which doesn't change).
 */
async function say(d: PreviewDeps, app: App, pr: OpenPr, row: PreviewRow, why?: string): Promise<void> {
  try {
    const id = await d.github.comment(app.repo, pr.number, body(app, pr, d.url(previewApp(app, pr.number, row.port)), why), row.comment_id);
    d.store.putPreview({ ...row, comment_id: id });
  } catch (e) {
    d.log.warn({ app: app.name, pr: pr.number, err: short(e) }, "preview comment failed");
  }
}

/** The apps' tailnet node, never fatal here: the next sync (any tick) puts it right. */
const sync = (d: PreviewDeps) => d.syncEdge().catch((e) => d.log.warn({ err: short(e) }, "preview: apps node sync failed"));

async function deployOne(d: PreviewDeps, app: App, pr: OpenPr): Promise<void> {
  const name = previewName(app.name, pr.number);
  const rows = d.store.previews();
  const row = rows.find((r) => r.name === name);
  if (row && row.sha === pr.sha && (row.status === "healthy" || row.status === "failed")) {
    // This head is done; a comment that didn't go through is said now, with the failure's recorded reason.
    if (row.comment_id === null) await say(d, app, pr, row, row.status === "failed" ? (row.reason ?? "it didn't build, start or get healthy") : undefined);
    return;
  }
  const port = row?.port ?? freePort(d, rows);
  if (!port) return d.log.warn({ app: app.name, pr: pr.number }, "no free preview port");
  const pa = previewApp(app, pr.number, port);
  const now = (d.now ?? Date.now)();
  const base: PreviewRow = { name, app: app.name, pr: pr.number, port, sha: pr.sha, status: "deploying", at: now, comment_id: row?.comment_id ?? null, reason: null };
  d.store.putPreview(base);
  let r: { ok: boolean; why?: string };
  try {
    placeholders(d, pa);
    r = await d.engine.preview(pa, pr.sha);
  } catch (e) {
    r = { ok: false, why: `it couldn't be prepared (${short(e)})` };
  }
  const done: PreviewRow = { ...base, status: r.ok ? "healthy" : "failed", reason: r.ok ? null : (r.why ?? "it didn't build, start or get healthy") };
  d.store.putPreview(done);
  if (r.ok || row?.status === "healthy") await sync(d);
  d.log.info({ app: app.name, pr: pr.number, sha: pr.sha, ok: r.ok }, "preview deployed");
  await say(d, app, pr, done, r.why);
}

/** Removes one preview and everything it had; its row goes last, so a failure is retried next tick. */
async function teardown(d: PreviewDeps, r: PreviewRow): Promise<void> {
  if (!PREVIEW_NAME.test(r.name)) throw new Error(`${r.name} is not a preview`);
  d.store.putPreview({ ...r, status: "removing" });
  await sync(d); // the apps' tailnet node leaves its network first: `down` can't remove a network still in use
  await d.engine.remove({ name: r.name, host: "local" } as App);
  if (existsSync(`${d.secretsDir}/${r.name}/DATABASE_URL`)) await d.dropDb(r.name);
  rmSync(`${d.secretsDir}/${r.name}`, { recursive: true, force: true });
  rmSync(`${d.gitDir}/${r.name}.git`, { recursive: true, force: true });
  const parent = d.apps().find((a) => a.name === r.app);
  if (parent && r.comment_id) await d.github.comment(parent.repo, r.pr, `**Preview** of \`${r.sha.slice(0, 12)}\` removed.`, r.comment_id).catch(() => undefined);
  d.store.dropPreview(r.name);
  d.log.info({ app: r.app, pr: r.pr }, "preview removed");
}

/**
 * One pass: the newest PER_APP open PRs of each eligible app get a preview at their head; every other preview is removed.
 * A PR list GitHub didn't give is unknown, never "all closed": that app's previews are kept.
 */
export async function previewTick(d: PreviewDeps): Promise<void> {
  if (d.engine.draining()) return; // shutting down: a refused preview would be recorded as failed
  const keep = new Set<string>();
  const want: [App, OpenPr][] = [];
  for (const app of d.apps().filter((a) => eligible(d, a))) {
    let prs: OpenPr[];
    try {
      prs = await d.github.openPrs(app.repo);
    } catch (e) {
      d.log.warn({ app: app.name, err: short(e) }, "preview: open PRs unknown");
      for (const r of d.store.previews()) if (r.app === app.name) keep.add(r.name);
      continue;
    }
    const mine = prs
      .filter((p) => p.base === app.branch && p.head_repo.toLowerCase() === app.repo.toLowerCase() && /^[0-9a-f]{40}$/.test(p.sha) && Number.isInteger(p.number) && p.number > 0)
      .sort((a, b) => b.number - a.number)
      .slice(0, PER_APP);
    for (const p of mine) (keep.add(previewName(app.name, p.number)), want.push([app, p]));
  }
  for (const r of d.store.previews()) if (!keep.has(r.name)) await teardown(d, r).catch((e) => d.log.warn({ preview: r.name, err: short(e) }, "preview removal failed"));
  for (const [app, pr] of want) await deployOne(d, app, pr).catch((e) => d.log.warn({ app: app.name, pr: pr.number, err: short(e) }, "preview failed"));
}

/** Its own loop, never awaited by the deploy loop: a slow preview build can't delay a production deploy. */
export function startPreviews(d: PreviewDeps, everyMs = 120_000): void {
  let inflight: Promise<void> | undefined;
  const run = () => void (inflight ??= previewTick(d).catch((e) => d.log.warn({ err: short(e) }, "preview loop failed")).finally(() => (inflight = undefined)));
  run();
  setInterval(run, everyMs).unref();
}
