// The instance's optional GitHub App (docs/design/github-identity.md): every GitHub write goes as it wherever it is installed on
// the target and its installation has accepted the permissions the write needs (client.ts actorFor), else as the owner. Its id
// and key are in this process's own vault dir (`<state>/github-app/{app_id,key.pem}`, written by the kernel's /setup/github-app),
// read when needed, so a new App works without a restart. Who it is (its slug and bot) is read from GitHub, never stored. The
// JWT and installation tokens never leave this process, except a session box's narrowed token (ops.ts app_token).
import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const API = "https://api.github.com";
const b64url = (v: unknown) => Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64url");

/** RS256 App JWT: issued 60 s in the past (clock drift), valid 9 minutes (GitHub's cap is 10). */
export function appJwt(appId: string, key: string, now = Date.now()): string {
  const iat = Math.floor(now / 1000) - 60;
  const body = `${b64url({ alg: "RS256", typ: "JWT" })}.${b64url({ iat, exp: iat + 540, iss: appId })}`;
  return `${body}.${createSign("RSA-SHA256").update(body).sign(key, "base64url")}`;
}

/** The App is set up but doesn't work (its saved files, its key, a suspension, GitHub's refusal or outage): never a quiet owner. */
export class AppError extends Error {}

/** How long an installation answer (installed or not, its accepted permissions) and the App's identity are reused. */
const LOOKUP_MS = 10 * 60_000;

/** An installation as GitHub answers it: its id, the permissions its owner has accepted, and its settings page. */
export type Installation = { id: number; permissions: Record<string, string>; html_url: string; account: string };
/** The App as GitHub names it: its id, slug, its bot's login (`<slug>[bot]`) and the bot user's id. */
export type AppIdentity = { id: number; slug: string; login: string; botId: number };

export type GitHubApp = ReturnType<typeof gitHubApp>;

export function gitHubApp({ dir, fetchImpl = fetch, now = Date.now }: { dir: string; fetchImpl?: typeof fetch; now?: () => number }) {
  /** A saved file's text; undefined only when it isn't there (ENOENT). Any other failure to read it is a broken App. */
  const read = (name: string): string | undefined => {
    try { return readFileSync(join(dir, name), "utf8").trim(); } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return undefined;
      throw new AppError(`the GitHub App's saved files can't be read (${code})`);
    }
  };
  /** The App's id and key; undefined when neither file exists (no App). A set that is there but broken throws. */
  const creds = () => {
    const id = read("app_id"), key = read("key.pem");
    if (id === undefined && key === undefined) return undefined;
    if (!/^[0-9]{1,12}$/.test(id ?? "") || !key?.includes("PRIVATE KEY")) throw new AppError("the GitHub App's saved id or key is missing or unreadable: create it again on its setup page");
    return { id: id!, key };
  };
  const lookups = new Map<string, { found: Installation | null; at: number }>();
  const tokens = new Map<number, { token: string; expires: number }>();
  let who: { for: string; identity: AppIdentity; at: number } | undefined;
  /** Why the App last failed, kept for the App it happened to (`for`, its id) until a call as it works again. */
  let failed: { for: string; why: string } | undefined;
  const fail = (why: string) => { let id: string | undefined; try { id = creds()?.id; } catch { /* the files' own failure is reported by failure() */ } failed = id ? { for: id, why: why.slice(0, 200) } : undefined; };
  const track = async <T>(go: () => Promise<T>): Promise<T> => {
    try { return await go(); } catch (e) { fail((e as Error).message); throw e; }
  };
  /** After GitHub rate-limited the App's own requests: none goes before this (epoch ms). */
  let blockedUntil = 0;

  async function api(method: string, path: string, auth: string, body?: unknown): Promise<{ status: number; body: any }> {
    if (blockedUntil > now()) throw new AppError(`the GitHub App is rate limited until ${new Date(blockedUntil).toISOString()}`);
    const r = await fetchImpl(`${API}${path}`, { method, headers: { authorization: `Bearer ${auth}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "aidenhq", ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20_000) })
      .catch((e: Error) => { throw new AppError(`the GitHub App: GitHub didn't answer (${String(e.message).slice(0, 120)})`); });
    const retry = Number(r.headers.get("retry-after"));
    if (r.status === 429 || (r.status === 403 && ((Number.isFinite(retry) && retry > 0) || r.headers.get("x-ratelimit-remaining") === "0"))) {
      blockedUntil = Number.isFinite(retry) && retry > 0 ? now() + retry * 1000 : Number(r.headers.get("x-ratelimit-reset")) * 1000 || now() + 60_000;
    }
    return { status: r.status, body: await r.json().catch(() => ({})) };
  }
  const jwt = (c: { id: string; key: string }) => appJwt(c.id, c.key, now());
  const refused = (what: string, r: { status: number; body: any }): AppError => new AppError(`the GitHub App: ${what} (GitHub said ${r.status} ${String(r.body?.message ?? "").slice(0, 150)})`.trim());
  const perms = (p: unknown) => (p && typeof p === "object" ? Object.fromEntries(Object.entries(p).map(([k, v]) => [k, String(v)])) : {});

  /** One installation lookup (cached by the App's id and the target): null on GitHub's 404, an AppError on anything else. */
  const lookup = (key: string, paths: string[]): Promise<Installation | null> => track(async () => {
    const c = creds();
    if (!c) return null;
    const k = `${c.id}:${key}`;
    const hit = lookups.get(k);
    if (hit && now() - hit.at < LOOKUP_MS) return hit.found;
    let found: Installation | null = null;
    for (const path of paths) {
      const r = await api("GET", path, jwt(c));
      if (r.status === 404) continue;
      if (r.status !== 200 || !Number.isInteger(r.body?.id)) throw refused(`couldn't look up its installation (${path})`, r);
      found = { id: Number(r.body.id), permissions: perms(r.body.permissions), html_url: String(r.body.html_url ?? ""), account: String(r.body.account?.login ?? "") };
      break;
    }
    lookups.set(k, { found, at: now() });
    return found;
  });
  const NAME = /^[\w.-]{1,100}$/;

  return {
    /** Whether an App is set up at all (either of its files is there); a broken one is still set up. */
    configured: (): boolean => { try { return creds() !== undefined; } catch { return true; } },
    /** The App's installation on `repo` (owner/name), or null: no App, or GitHub says it isn't installed there. A broken App throws. */
    installed: (repo: string): Promise<Installation | null> => {
      const [o, n, ...rest] = repo.split("/");
      if (rest.length || !o || !n || !NAME.test(o) || !NAME.test(n) || [o, n].some((p) => /^\.+$/.test(p))) return Promise.reject(new AppError(`not a repository: ${repo.slice(0, 200)}`));
      return lookup(`repo:${repo.toLowerCase()}`, [`/repos/${o}/${n}/installation`]);
    },
    /** The App's installation on an organization or a user account, or null (see `installed`). */
    installedOn: (org: string): Promise<Installation | null> => {
      if (!NAME.test(org) || /^\.+$/.test(org)) return Promise.reject(new AppError(`not an account: ${org.slice(0, 100)}`));
      return lookup(`org:${org.toLowerCase()}`, [`/orgs/${org}/installation`, `/users/${org}/installation`]);
    },
    /** Drops the cached installation of a repo (`owner/name`) or account: GitHub refused a call its accepted permissions allowed. */
    evict: (target: string): void => {
      const t = target.toLowerCase();
      for (const k of lookups.keys()) if (k.endsWith(`:repo:${t}`) || k.endsWith(`:org:${t}`) || (!t.includes("/") && k.includes(`:repo:${t}/`))) lookups.delete(k);
    },
    /** An installation token, reused until 5 minutes before it expires; `fresh` drops the cached one (GitHub refused it). */
    token: (installation: number, fresh = false): Promise<string> => track(async () => {
      const c = creds();
      if (!c) throw new AppError("the GitHub App isn't set up");
      const hit = tokens.get(installation);
      if (!fresh && hit && hit.expires - now() > 5 * 60_000) return hit.token;
      const r = await api("POST", `/app/installations/${installation}/access_tokens`, jwt(c));
      if (r.status !== 201 || typeof r.body?.token !== "string") throw refused("couldn't get an installation token", r);
      tokens.set(installation, { token: r.body.token, expires: Date.parse(r.body.expires_at) || now() + 3_600_000 });
      return r.body.token;
    }),
    /**
     * A fresh installation token narrowed to `repositories` (names in the installation's account) and `permissions`, never cached:
     * what a session box's git credential helper gets (ops.ts app_token). GitHub caps its life at one hour.
     */
    mint: (installation: number, narrow: { repositories: string[]; permissions: Record<string, string> }): Promise<{ token: string; expires_at: string }> => track(async () => {
      const c = creds();
      if (!c) throw new AppError("the GitHub App isn't set up");
      const r = await api("POST", `/app/installations/${installation}/access_tokens`, jwt(c), narrow);
      if (r.status !== 201 || typeof r.body?.token !== "string") throw refused("couldn't get a narrowed installation token", r);
      return { token: r.body.token, expires_at: String(r.body.expires_at ?? "") };
    }),
    /** Who the App is, read from GitHub (`GET /app`, then its bot user), or undefined while no App is set up. A broken App throws. */
    identity: (): Promise<AppIdentity | undefined> => track(async () => {
      const c = creds();
      if (!c) return undefined;
      if (who?.for === c.id && now() - who.at < LOOKUP_MS) return who.identity;
      const app = await api("GET", "/app", jwt(c));
      if (app.status !== 200 || typeof app.body?.slug !== "string") throw refused("couldn't read the App", app);
      const login = `${app.body.slug}[bot]`;
      const bot = await api("GET", `/users/${encodeURIComponent(login)}`, jwt(c));
      if (bot.status !== 200 || !Number.isInteger(bot.body?.id)) throw refused(`couldn't read its bot ${login}`, bot);
      const identity = { id: Number(app.body.id), slug: String(app.body.slug), login, botId: Number(bot.body.id) };
      who = { for: c.id, identity, at: now() };
      return identity;
    }),
    /**
     * Every installation with the permissions the App asks for that it hasn't accepted (`GET /app` against `GET /app/installations`):
     * the board card's rows. Empty while no App is set up.
     */
    installations: (): Promise<{ account: string; html_url: string; repos: "all" | "selected"; lagging: string[] }[]> => track(async () => {
      const c = creds();
      if (!c) return [];
      const app = await api("GET", "/app", jwt(c));
      if (app.status !== 200) throw refused("couldn't read the App", app);
      const wanted = perms(app.body?.permissions);
      const out: { account: string; html_url: string; repos: "all" | "selected"; lagging: string[] }[] = [];
      for (let page = 1; page <= 10; page++) {
        const r = await api("GET", `/app/installations?per_page=100&page=${page}`, jwt(c));
        if (r.status !== 200 || !Array.isArray(r.body)) throw refused("couldn't list its installations", r);
        for (const i of r.body) {
          const has = perms(i?.permissions);
          out.push({ account: String(i?.account?.login ?? ""), html_url: String(i?.html_url ?? ""), repos: i?.repository_selection === "all" ? "all" : "selected", lagging: Object.entries(wanted).filter(([p, level]) => !covers(has[p], level)).map(([p]) => p).sort() });
        }
        if (r.body.length < 100) break;
      }
      return out;
    }),
    /** Why the App is failing: its saved files, or its last failure since a call as it last worked. */
    failure: (): string | undefined => {
      let c;
      try { c = creds(); } catch (e) { return (e as Error).message; }
      return c && failed?.for === c.id ? failed.why : undefined;
    },
    /** A call as the App's installation answered (client.ts): a refusal is its failure; a success clears it. */
    wrote: (refusal?: string): void => (refusal ? fail(refusal) : void (failed = undefined)),
  };
}

/** Whether an accepted level covers a wanted one (write covers read; admin covers both). */
export const covers = (have: string | undefined, want: string) => have === want || have === "admin" || (have === "write" && want === "read");
