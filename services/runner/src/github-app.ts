// GitHub access through the instance's GitHub App, whose key only the runner holds. It is owned by the agents org
// (where an approved create_repo card creates repos) and public, so other orgs can install it on selected repos. Per action the runner
// mints a short-lived installation token narrowed to one repo and the permissions it needs, hands it to that one git or
// gh child (credential helper / GH_TOKEN env). An agent gets only a read token (READ) for its task's repos, for its gh.
// Repos no App covers keep the old path.
import { createSign } from "node:crypto";

const b64url = (v: unknown) => Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64url");

/** RS256 App JWT: issued 60s in the past (clock drift), valid 9 minutes (GitHub's cap is 10). */
export function appJwt(appId: string | number, key: string, now = Date.now()): string {
  const iat = Math.floor(now / 1000) - 60;
  const body = `${b64url({ alg: "RS256", typ: "JWT" })}.${b64url({ iat, exp: iat + 600, iss: String(appId) })}`;
  return `${body}.${createSign("RSA-SHA256").update(body).sign(key, "base64url")}`;
}

export const READ = { contents: "read", pull_requests: "read", checks: "read", statuses: "read", actions: "read", issues: "read" };
export const WRITE = { contents: "write", pull_requests: "write", checks: "read", statuses: "read" };

/**
 * The App. Which orgs it covers comes from its installations (GET /app/installations,
 * cached 10 minutes, refreshed on a miss); a repo is covered when a token narrowed to it can be minted.
 */
export function appClient({ appId, key, fetch = globalThis.fetch, log = () => {}, now = Date.now }: { appId: string | number; key: string; fetch?: typeof globalThis.fetch; log?: (...a: any[]) => void; now?: () => number }) {
  const api = async (method: string, path: string, auth: string, body?: unknown): Promise<{ status: number; body: any }> => {
    const r = await fetch(`https://api.github.com${path}`, {
      method,
      headers: { authorization: `Bearer ${auth}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(20_000),
    });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  let installs = { at: -Infinity, byOrg: new Map<string, number>() };
  const tokens = new Map<string, { token: string; expires: number }>(); // org+repos+perms → { token, expires }: one per repo and permission set, reused for up to ~55 min
  const covered = new Map<string, { yes: boolean; at: number }>(); // slug → { yes, at }

  /** org (lowercase) → installation id, read again after 10 minutes or when `refresh`. */
  async function installations(refresh = false) {
    if (!refresh && now() - installs.at < 10 * 60_000) return installs.byOrg;
    const r = await api("GET", "/app/installations?per_page=100", appJwt(appId, key, now()));
    if (r.status !== 200) throw new Error(`the GitHub App: couldn't list installations (GitHub said ${r.status} ${r.body?.message ?? ""})`.trim());
    installs = { at: now(), byOrg: new Map(r.body.map((i: any) => [String(i.account?.login).toLowerCase(), i.id])) };
    return installs.byOrg;
  }
  async function installationId(org: string) {
    const k = org.toLowerCase();
    return (await installations()).get(k) ?? (await installations(true)).get(k);
  }

  /**
   * An installation token in org for these repos (names, not slugs) and permissions; reused until 5 minutes before expiry.
   * `fresh`: always a new one (a full hour), for a token handed to a job that may run that long.
   */
  async function token(org: string, { repositories, permissions, fresh = false }: { repositories?: string[]; permissions?: Record<string, string>; fresh?: boolean } = {}): Promise<string> {
    const k = JSON.stringify([org.toLowerCase(), repositories ?? null, permissions ?? null]);
    const hit = tokens.get(k);
    if (!fresh && hit && hit.expires - now() > 5 * 60_000) return hit.token;
    const id = await installationId(org);
    if (!id) throw Object.assign(new Error(`the GitHub App isn't installed on ${org}`), { status: 404 });
    const body = { ...(repositories ? { repositories } : {}), ...(permissions ? { permissions } : {}) };
    const r = await api("POST", `/app/installations/${id}/access_tokens`, appJwt(appId, key, now()), body);
    if (r.status !== 201) throw Object.assign(new Error(`couldn't get a GitHub App token for ${org} (GitHub said ${r.status} ${r.body?.message ?? ""})`.trim()), { status: r.status });
    tokens.set(k, { token: r.body.token, expires: Date.parse(r.body.expires_at) });
    return r.body.token;
  }

  /** True when the App can act on org/name (installed there, and the repo is in the installation's selection). */
  async function covers(slug: string): Promise<boolean> {
    const k = slug.toLowerCase();
    const hit = covered.get(k);
    if (hit && (hit.yes || now() - hit.at < 10 * 60_000)) return hit.yes;
    const [org, name] = slug.split("/") as [string, string];
    const yes = await token(org, { repositories: [name], permissions: { metadata: "read" } }).then(
      () => true,
      (err: any) => (err.status === 404 || err.status === 422 ? false : Promise.reject(err)),
    );
    covered.set(k, { yes, at: now() });
    return yes;
  }

  /**
   * Whether org/name exists, in an org this App is installed on. Read only: naming, adding or detecting a repo never creates
   * it. Anything but 200 or 404 throws, so a bad minute on GitHub is never read as "doesn't exist".
   */
  async function repoExists(slug: string): Promise<boolean> {
    const [org, name] = slug.split("/") as [string, string];
    // An un-narrowed metadata token: a repo-narrowed one can't be minted for a repo that doesn't exist.
    const r = await api("GET", `/repos/${org}/${name}`, await token(org, { permissions: { metadata: "read" } }));
    if (r.status === 200) return true;
    if (r.status === 404) return false;
    throw new Error(`couldn't check ${slug} on GitHub (GitHub said ${r.status} ${r.body?.message ?? ""})`.trim());
  }

  /**
   * Create org/name, private, with a README: only for an approved create_repo card (the runner's one caller). "exists" |
   * "created". A creation-only token; if GitHub refuses that permission, fail loudly rather than widen the token.
   */
  async function createRepo(slug: string): Promise<"exists" | "created"> {
    if (await repoExists(slug)) return "exists";
    const [org, name] = slug.split("/") as [string, string];
    const creator = await token(org, { permissions: { repository_creation: "write" } });
    const r = await api("POST", `/orgs/${org}/repos`, creator, { name, private: true, auto_init: true });
    if (r.status !== 201) throw new Error(`couldn't create ${org}/${name}: GitHub said ${r.status} ${r.body?.message ?? ""}`.trim());
    covered.delete(slug.toLowerCase());
    return "created";
  }

  let bot: { name: string; email: string } | undefined;
  /** The App's bot commit identity: `<slug>[bot]` <`<id>+<slug>[bot]@users.noreply.github.com`>, resolved once. */
  async function identity() {
    if (bot) return bot;
    const me = await api("GET", "/app", appJwt(appId, key, now()));
    if (me.status !== 200) throw new Error(`couldn't read the GitHub App (GitHub said ${me.status})`);
    const name = `${me.body.slug}[bot]`;
    const user = await fetch(`https://api.github.com/users/${encodeURIComponent(name)}`, { headers: { accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(20_000) });
    const id = user.status === 200 ? ((await user.json()) as any).id : undefined;
    if (!id) throw new Error(`couldn't find the GitHub user ${name} (GitHub said ${user.status})`);
    return (bot = { name, email: `${id}+${name}@users.noreply.github.com` });
  }

  return { installations, token, covers, repoExists, createRepo, identity };
}

export type AppClient = ReturnType<typeof appClient>;

/** Commit identity without the App: never the owner's. */
export const DEFAULT_IDENTITY = { name: "AidenHQ agent", email: "agent@aidenhq.invalid" };
/** git env that makes `who` the author and committer. */
export const identityEnv = (who: { name: string; email: string }) => ({ GIT_AUTHOR_NAME: who.name, GIT_AUTHOR_EMAIL: who.email, GIT_COMMITTER_NAME: who.name, GIT_COMMITTER_EMAIL: who.email });

/** True when slug ("org/name") is in the agents org. */
export const inOrg = (org: string | undefined, slug: string | undefined) => Boolean(org && slug) && slug!.split("/")[0]!.toLowerCase() === org!.toLowerCase();

/**
 * Origin URL for an agents-org repo. The `x-access-token@` user keeps it from matching the host's global
 * `url.git@github.com:.pushInsteadOf https://github.com/` (pushes stay on HTTPS) and `insteadOf git@github.com:`.
 */
export const appRemoteUrl = (slug: string) => `https://x-access-token@github.com/${slug}.git`;

/** "org/name" for an https://github.com/ URL (with or without the x-access-token user); anything else: undefined. */
export function appSlugOf(url: unknown): string | undefined {
  const m = /^https:\/\/(?:x-access-token@)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(String(url ?? ""));
  return m ? `${m[1]}/${m[2]}` : undefined;
}

/**
 * Per-command git config for a token in env AIDENHQ_GIT_TOKEN (never argv, URL or .git/config): settings a planted repo
 * config could use to run code or reroute traffic are overridden, every other credential helper is cleared, and this
 * one answers only `get` for protocol=https and host=github.com exactly.
 */
export const CREDENTIAL_ARGS = [
  "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=", "-c", "core.sshCommand=", "-c", "http.proxy=",
  "-c", "credential.helper=",
  "-c", 'credential.helper=!f(){ test "$1" = get || return 0; h=; p=; while IFS= read -r l && [ -n "$l" ]; do case "$l" in host=*) h="${l#host=}";; protocol=*) p="${l#protocol=}";; esac; done; [ "$p" = https ] && [ "$h" = github.com ] || return 0; echo username=x-access-token; echo "password=$AIDENHQ_GIT_TOKEN"; }; f',
];

/** git args + env for a command that carries the token. */
export const withGitToken = (args: string[], env: NodeJS.ProcessEnv, token: string) => ({ args: [...CREDENTIAL_ARGS, ...args], env: { ...env, GIT_CONFIG_NOSYSTEM: "1", AIDENHQ_GIT_TOKEN: token } });

/** gh child options: GH_TOKEN for that one process when `app` (the App covering the repo) is set, else the host's gh login. */
export async function ghOptions(app: AppClient | null | undefined, slug: string | undefined, perms: Record<string, string>, extra: { env?: NodeJS.ProcessEnv; [k: string]: unknown } = {}) {
  if (!app || !slug) return extra; // no App for this repo: the host's gh login, as before
  const [org, name] = slug.split("/") as [string, string];
  const token = await app.token(org, { repositories: [name], permissions: perms });
  return { ...extra, env: { ...(extra.env ?? process.env), GH_TOKEN: token } };
}
