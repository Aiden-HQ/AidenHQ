// The owner's optional GitHub App (spec 2026-11-22-github-app-review-writer): code review's writes, and the fleet's repo reads where
// its installation holds the permission (client.ts readerFor). Its id and key are in this process's own vault dir
// (`<state>/github-app/{app_id,key.pem,slug}`, written by the kernel's /setup/github-app), read when needed, so a new App works without
// a restart. Without them, or on a repo it isn't installed on, code review posts and the fleet reads as the owner. The JWT and
// installation tokens never leave this process (restored from #1134's service/src/github-app.ts).
import { createSign } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const API = "https://api.github.com";
const b64url = (v: unknown) => Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64url");

/** RS256 App JWT: issued 60 s in the past (clock drift), valid 9 minutes (GitHub's cap is 10). */
export function appJwt(appId: string, key: string, now = Date.now()): string {
  const iat = Math.floor(now / 1000) - 60;
  const body = `${b64url({ alg: "RS256", typ: "JWT" })}.${b64url({ iat, exp: iat + 540, iss: appId })}`;
  return `${body}.${createSign("RSA-SHA256").update(body).sign(key, "base64url")}`;
}

export class AppError extends Error {}

/** How long a repo's installation answer (installed or not, and the permissions it holds) is reused. */
const LOOKUP_MS = 10 * 60_000;

export type GitHubApp = ReturnType<typeof gitHubApp>;

export function gitHubApp({ dir, fetchImpl = fetch, now = Date.now }: { dir: string; fetchImpl?: typeof fetch; now?: () => number }) {
  const read = (name: string) => { try { return readFileSync(join(dir, name), "utf8").trim(); } catch { return ""; } };
  /**
   * The App's id, key and slug; undefined when none of its files exists (the App isn't set up). A set that is there but
   * incomplete or unreadable throws here, for the card's warning; reviews treat it as no App (`quiet`) and post as the owner:
   * the App is optional, and the owner is the intended fallback (owner, 2026-11-22).
   */
  const creds = () => {
    if (!["app_id", "key.pem", "slug"].some((f) => existsSync(join(dir, f)))) return undefined;
    const id = read("app_id"), key = read("key.pem"), slug = read("slug");
    if (!/^[0-9]{1,12}$/.test(id) || !key.includes("PRIVATE KEY") || !/^[a-z0-9-]{1,100}$/.test(slug)) throw new AppError("the GitHub App's saved id, key or name is missing or unreadable: create it again on its setup page");
    return { id, key, slug };
  };
  const quiet = () => { try { return creds(); } catch { return undefined; } };
  const lookups = new Map<string, { found: { id: number; permissions: Record<string, string> } | null; at: number }>();
  const tokens = new Map<number, { token: string; expires: number }>();
  /**
   * Why the App last failed (its key, a suspension, a refusal of its token or of a write), until a write as it succeeds; kept
   * for the App it happened to (`for`, its id), so a removed or replaced App never shows an old one's failure.
   */
  let failed: { for: string; why: string } | undefined;
  const fail = (why: string) => { const id = quiet()?.id; failed = id ? { for: id, why: why.slice(0, 200) } : undefined; };
  const track = async <T>(go: () => Promise<T>): Promise<T> => {
    try { return await go(); } catch (e) { fail((e as Error).message); throw e; }
  };
  /** After GitHub rate-limited the App's own requests (Retry-After, or its limit used up): none goes before this (epoch ms). */
  let blockedUntil = 0;

  async function api(method: string, path: string, auth: string, body?: unknown): Promise<{ status: number; body: any }> {
    if (blockedUntil > now()) throw new AppError(`the GitHub App is rate limited until ${new Date(blockedUntil).toISOString()}`);
    const r = await fetchImpl(`${API}${path}`, { method, headers: { authorization: `Bearer ${auth}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "aidenhq", ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20_000) });
    const retry = Number(r.headers.get("retry-after"));
    if (r.status === 429 || (r.status === 403 && ((Number.isFinite(retry) && retry > 0) || r.headers.get("x-ratelimit-remaining") === "0"))) {
      blockedUntil = Number.isFinite(retry) && retry > 0 ? now() + retry * 1000 : Number(r.headers.get("x-ratelimit-reset")) * 1000 || now() + 60_000;
    }
    return { status: r.status, body: await r.json().catch(() => ({})) };
  }
  const jwt = () => { const c = creds()!; return appJwt(c.id, c.key, now()); };
  const refused = (what: string, r: { status: number; body: any }): AppError => new AppError(`the GitHub App: ${what} (GitHub said ${r.status} ${String(r.body?.message ?? "").slice(0, 150)})`.trim());

  /**
   * The App's installation on `repo` (owner/name): its id and the permissions it has accepted, or null when the App isn't set up
   * (or its saved files are broken) or GitHub confirms it isn't installed there (404). Any other answer (a bad key, a suspended App,
   * a rate limit) throws: a review never quietly moves to the owner's account because the App broke.
   */
  const installed = (repo: string): Promise<{ id: number; permissions: Record<string, string> } | null> => track(async () => {
    const c = quiet();
    if (!c) return null;
    if (!/^[\w.-]{1,100}\/[\w.-]{1,100}$/.test(repo) || repo.split("/").some((p) => /^\.+$/.test(p))) throw new AppError(`not a repository: ${repo.slice(0, 200)}`);
    const k = `${c.id}:${repo.toLowerCase()}`;
    const hit = lookups.get(k);
    if (hit && now() - hit.at < LOOKUP_MS) return hit.found;
    const r = await api("GET", `/repos/${repo}/installation`, jwt());
    if (r.status !== 200 && r.status !== 404) throw refused(`couldn't look up its installation on ${repo}`, r);
    const id = r.status === 200 && Number.isInteger(r.body?.id) ? Number(r.body.id) : null;
    if (r.status === 200 && id === null) throw refused(`no installation id for ${repo}`, r);
    const permissions = r.body?.permissions && typeof r.body.permissions === "object" ? Object.fromEntries(Object.entries(r.body.permissions).map(([p, v]) => [p, String(v)])) : {};
    const found = id === null ? null : { id, permissions };
    lookups.set(k, { found, at: now() });
    return found;
  });

  return {
    installed,
    /** The App's installation id on `repo`, or null (see `installed`). */
    installation: async (repo: string): Promise<number | null> => (await installed(repo))?.id ?? null,
    /** An installation token, reused until 5 minutes before it expires; `fresh` drops the cached one (GitHub refused it). */
    token: (installation: number, fresh = false): Promise<string> => track(async () => {
      const hit = tokens.get(installation);
      if (!fresh && hit && hit.expires - now() > 5 * 60_000) return hit.token;
      const r = await api("POST", `/app/installations/${installation}/access_tokens`, jwt());
      if (r.status !== 201 || typeof r.body?.token !== "string") throw refused("couldn't get an installation token", r);
      tokens.set(installation, { token: r.body.token, expires: Date.parse(r.body.expires_at) || now() + 3_600_000 });
      return r.body.token;
    }),
    /**
     * A fresh installation token narrowed to `repositories` (names in the installation's account) and `permissions`, never cached:
     * what a session box's git credential helper gets (ops.ts app_token). GitHub caps its life at one hour.
     */
    mint: (installation: number, narrow: { repositories: string[]; permissions: Record<string, string> }): Promise<{ token: string; expires_at: string }> => track(async () => {
      const r = await api("POST", `/app/installations/${installation}/access_tokens`, jwt(), narrow);
      if (r.status === 403 || r.status === 422) throw refused("the installation refused a token with contents and pull requests write: accept the App's new Contents permission on GitHub (the App's settings, Permissions, then this installation's review request) and make sure the App has access to the repository", r);
      if (r.status !== 201 || typeof r.body?.token !== "string") throw refused("couldn't get a narrowed installation token", r);
      return { token: r.body.token, expires_at: String(r.body.expires_at ?? "") };
    }),
    /** The App's slug (its bot is `<slug>[bot]`), or undefined while it isn't set up (or its saved files are broken). */
    slug: (): string | undefined => quiet()?.slug,
    /** Why the App is failing: its saved files, or its last failure since a write as it last worked. */
    failure: (): string | undefined => {
      let c;
      // A vault dir that is there but can't be read looks like no App to existsSync: say so on the card.
      try { readdirSync(dir); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") return `the GitHub App's saved files can't be read (${(e as NodeJS.ErrnoException).code})`; }
      try { c = creds(); } catch (e) { return (e as Error).message; }
      return c && failed?.for === c.id ? failed.why : undefined;
    },
    /** A write as the App's installation answered (client.ts): a refusal is its failure; a success clears it. */
    wrote: (refusal?: string): void => (refusal ? fail(refusal) : void (failed = undefined)),
  };
}
