// DELETE in the release after #1065: the one-off that takes the retired GitHub App out of the repos' rules (spec
// 2026-11-20-github-owner-identity §12). On the first sign-in with the new scopes (the owner's reconnect) it rewrites, with the
// owner's token, each repo's rulesets and branch protection that name the App (by its id), then tells the owner once to delete
// the App on GitHub. Entries naming any other app (GitHub Actions' pinned checks, other integrations) stay as they are. The merge
// queue holds while it runs (main.ts). Runs once per repo: the repos done are in the cache dir.
//   bypass actor `Integration` of the App -> on the fleet org's repos and the product repo: the repository admin role (RepositoryRole 5,
//                                            verified live 2026-11-20 via GraphQL repositoryRoleName); on any other repo (a maintained
//                                            repo in someone else's org) the actor is only removed: no role is granted there
//   required check pinned to the App      -> any source (ruleset: no integration_id; branch protection: app_id -1, per
//                                            docs.github.com/rest/branches/branch-protection "Pass -1 to explicitly allow any app")
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GitHubAccess } from "../../connections/github-mcp/src/client.ts";

type Rest = Pick<GitHubAccess, "rest">;
type Notify = (n: { kind: "alert"; text: string; dedupe_key: string }) => Promise<void>;
type State = { repos: Record<string, string>; complete?: true };
const ADMIN_ROLE = 5;
const bg = { background: true };

/** A GitHub answer that wasn't a success; 5xx retries on the next pass, any other is recorded and skipped. */
class Refused extends Error {
  status: number;
  constructor(status: number, what: string) { super(`${what}: GitHub said ${status}`); this.status = status; }
}

/** The ruleset's new body when it names the App (its Integration bypass actor or a check pinned to it), else undefined. */
export function rewriteRuleset(rs: any, appId: number, admin: boolean): Record<string, unknown> | undefined {
  let changed = false;
  const seen = new Set<string>();
  const bypass_actors = (rs.bypass_actors ?? []).flatMap((a: any) => {
    if (a.actor_type !== "Integration" || Number(a.actor_id) !== appId) return [a];
    changed = true;
    return !admin ? [] : [{ actor_type: "RepositoryRole", actor_id: ADMIN_ROLE, bypass_mode: a.bypass_mode ?? "always" }];
  }).filter((a: any) => { const k = `${a.actor_type}:${a.actor_id}`; return seen.has(k) ? false : (seen.add(k), true); });
  const rules = (rs.rules ?? []).map((r: any) => {
    if (r.type !== "required_status_checks") return r;
    return { ...r, parameters: { ...r.parameters, required_status_checks: (r.parameters?.required_status_checks ?? []).map((c: any) => {
      if (Number(c.integration_id) !== appId) return c;
      changed = true;
      const { integration_id: _, ...rest } = c;
      return rest;
    }) } };
  });
  if (!changed) return undefined;
  return { name: rs.name, target: rs.target, enforcement: rs.enforcement, conditions: rs.conditions, rules, bypass_actors };
}

/** Every page of a list endpoint; a 403 or 404 (no such org, rulesets not offered on this plan) is an empty list. */
async function list(access: Rest, path: string): Promise<any[]> {
  const out: any[] = [];
  for (let page = 1; ; page++) {
    const r = await access.rest("GET", `${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`, undefined, bg);
    if (r.status === 403 || r.status === 404) return out;
    if (r.status !== 200) throw new Refused(r.status, `listing ${path}`);
    out.push(...r.body);
    if (r.body.length < 100) return out;
  }
}

async function rewriteRepo(access: Rest, repo: string, appId: number, admin: boolean): Promise<string> {
  const notes: string[] = [];
  for (const { id } of await list(access, `/repos/${repo}/rulesets?includes_parents=false`)) {
    const full = await access.rest("GET", `/repos/${repo}/rulesets/${id}`, undefined, bg);
    if (full.status !== 200) throw new Refused(full.status, `reading ruleset ${id}`);
    const body = rewriteRuleset(full.body, appId, admin);
    if (!body) continue;
    const put = await access.rest("PUT", `/repos/${repo}/rulesets/${id}`, body, bg);
    if (put.status !== 200) throw new Refused(put.status, `rewriting ruleset ${id}`);
    notes.push(`ruleset ${full.body.name}`);
  }
  const info = await access.rest("GET", `/repos/${repo}`, undefined, bg);
  if (info.status !== 200) throw new Refused(info.status, "reading the repo");
  const checks = await access.rest("GET", `/repos/${repo}/branches/${encodeURIComponent(info.body.default_branch)}/protection/required_status_checks`, undefined, bg);
  if (checks.status === 200 && (checks.body.checks ?? []).some((c: any) => Number(c.app_id) === appId)) {
    const patch = await access.rest("PATCH", `/repos/${repo}/branches/${encodeURIComponent(info.body.default_branch)}/protection/required_status_checks`,
      { strict: checks.body.strict, checks: checks.body.checks.map((c: any) => ({ context: c.context, app_id: Number(c.app_id) === appId ? -1 : c.app_id ?? -1 })) }, bg);
    if (patch.status !== 200) throw new Refused(patch.status, "rewriting branch protection");
    notes.push("branch protection");
  }
  return notes.length ? `rewrote ${notes.join(", ")}` : "nothing named the App";
}

/** The repos to rewrite: the fleet org's, the product repo, the maintained repos (maintainer_repos) and the instance repo. */
export async function migrationRepos(access: Rest, d: { fleetOrg?: string; productRepo?: string; maintained?: string[]; instanceRepo?: string }): Promise<string[]> {
  const fleet = d.fleetOrg ? (await list(access, `/orgs/${d.fleetOrg}/repos?type=all`)).filter((r) => !r.archived).map((r) => String(r.full_name)) : [];
  return [...new Set([...fleet, d.productRepo, ...(d.maintained ?? []), d.instanceRepo].filter((r): r is string => Boolean(r)))];
}

/**
 * Once per repo (recorded in `file`), then one owner alert to delete the App. A repo GitHub refuses (4xx, or one the owner
 * can't reach) is recorded as skipped and logged; a 5xx, rate limit or network error rejects and the next pass resumes.
 */
export async function dropApp(access: Rest, repos: string[], notify: Notify, o: { file: string; org: string; appId: number; admin: (repo: string) => boolean; log?: (msg: string, f?: Record<string, unknown>) => void }): Promise<void> {
  const state: State = existsSync(o.file) ? JSON.parse(readFileSync(o.file, "utf8")) : { repos: {} };
  const save = () => { writeFileSync(`${o.file}.tmp`, JSON.stringify(state)); renameSync(`${o.file}.tmp`, o.file); };
  for (const repo of repos) {
    if (state.repos[repo]) continue;
    try {
      state.repos[repo] = await rewriteRepo(access, repo, o.appId, o.admin(repo));
    } catch (e) {
      const need = (e as { need?: { cause?: string } }).need;
      if (e instanceof Refused ? e.status < 500 : need?.cause === "unreachable") state.repos[repo] = `skipped: ${(e as Error).message}`;
      else throw e;
    }
    o.log?.("app migration", { repo, result: state.repos[repo] });
    save();
  }
  await notify({ kind: "alert", dedupe_key: "github:app-uninstall", text: `The GitHub App isn't used any more. Uninstall and delete it on GitHub: https://github.com/organizations/${o.org}/settings/installations` });
  state.complete = true;
  save();
}

/**
 * Runs dropApp on the first pass whose sign-in has the `workflow` scope (the reconnect), every 30 s until it finishes.
 * `pending()` is true from that sign-in until then: the merge queue holds.
 */
export function startAppMigration(d: { access: GitHubAccess; appId: number; cacheDir: string; fleetOrg?: string; productRepo?: string; maintained?: string[]; instanceRepo?: string; kernelUrl: string; key: string; log: (msg: string, f?: Record<string, unknown>) => void }) {
  const file = join(d.cacheDir, "migrated-from-app.json");
  let finished = existsSync(file) && Boolean((JSON.parse(readFileSync(file, "utf8")) as State).complete);
  const notify: Notify = async (n) => {
    const r = await fetch(`${d.kernelUrl}/v1/notify`, { method: "POST", signal: AbortSignal.timeout(10_000), headers: { authorization: `Bearer ${d.key}`, "content-type": "application/json" }, body: JSON.stringify(n) });
    if (!r.ok) throw new Error(`notify failed: ${r.status}`);
  };
  const org = d.fleetOrg || d.productRepo?.split("/")[0] || "";
  const pending = () => !finished && d.access.connected() && d.access.scopes().includes("workflow");
  let running = false;
  const step = async () => {
    if (running || !pending()) return;
    running = true;
    try {
      await dropApp(d.access, await migrationRepos(d.access, d), notify, { file, org, appId: d.appId, admin: (r) => (d.fleetOrg ? r.startsWith(`${d.fleetOrg}/`) : false) || r === d.productRepo, log: d.log });
      finished = true;
    } catch (e) { d.log("app migration will retry", { err: (e as Error).message }); } finally { running = false; }
  };
  const t = setInterval(() => void step(), 30_000);
  t.unref?.();
  void step();
  return { pending, step };
}
