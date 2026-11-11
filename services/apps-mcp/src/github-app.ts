// Read access to private agents-org repos through the instance's GitHub App. A minimal copy of
// services/runner/src/github-app.mjs (separate package): per repo, a short-lived installation token narrowed to that one
// repo and {contents: read}, handed to that one git child through a credential helper reading an env var.
import { createSign } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

function readSettings(instanceDir: string): Record<string, unknown> | undefined {
  const f = join(instanceDir, "instance.yaml");
  return existsSync(f) ? (parse(readFileSync(f, "utf8")) as { settings?: Record<string, unknown> } | null)?.settings : undefined;
}

/** The agents org: settings.github_agents_org, else aidenhq-<instance_name> (scripts/modules.mjs agrees). */
export function readAgentsOrg(instanceDir: string): string | undefined {
  const s = readSettings(instanceDir);
  return (s?.github_agents_org as string) || (s?.instance_name ? `aidenhq-${s.instance_name}` : undefined);
}

/** settings.github_orgs: the GitHub orgs/users apps may be built from, besides the agents org. */
export function readOrgs(instanceDir: string): string[] {
  const v = readSettings(instanceDir)?.github_orgs;
  return Array.isArray(v) ? v.map(String) : [];
}

const b64url = (v: unknown) => Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64url");

/** RS256 App JWT: issued 60s in the past (clock drift), valid 10 minutes from then. */
function appJwt(appId: string, key: string, now = Date.now()): string {
  const iat = Math.floor(now / 1000) - 60;
  const body = `${b64url({ alg: "RS256", typ: "JWT" })}.${b64url({ iat, exp: iat + 600, iss: appId })}`;
  return `${body}.${createSign("RSA-SHA256").update(body).sign(key, "base64url")}`;
}

export type RepoToken = (slug: string, perm?: "read" | "write") => Promise<string>;

/** Mints tokens for single repos (contents: read, or write for the registry push; the App must hold contents: write), reused until 5 minutes before expiry. Undefined when the App's files are absent. */
export function appTokens(dir: string, fetch = globalThis.fetch): RepoToken | undefined {
  if (!existsSync(join(dir, "app_id")) || !existsSync(join(dir, "key.pem"))) return undefined;
  const appId = readFileSync(join(dir, "app_id"), "utf8").trim();
  const key = readFileSync(join(dir, "key.pem"), "utf8");
  const cache = new Map<string, { token: string; expires: number }>();
  const api = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(`https://api.github.com${path}`, {
      method,
      headers: { authorization: `Bearer ${appJwt(appId, key)}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(20_000),
    });
    return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
  };
  return async (slug, perm = "read") => {
    const ck = `${slug.toLowerCase()}:${perm}`;
    const hit = cache.get(ck);
    if (hit && hit.expires - Date.now() > 5 * 60_000) return hit.token;
    const [owner, name] = slug.split("/");
    const inst = await api("GET", `/repos/${owner}/${name}/installation`);
    if (inst.status !== 200) throw new Error(`the GitHub App can't see ${slug} (GitHub said ${inst.status} ${inst.body?.message ?? ""})`.trim());
    const r = await api("POST", `/app/installations/${inst.body.id}/access_tokens`, { repositories: [name], permissions: { contents: perm } });
    if (r.status !== 201) throw new Error(`couldn't get a GitHub App token for ${slug} (GitHub said ${r.status} ${r.body?.message ?? ""})`.trim());
    cache.set(ck, { token: r.body.token, expires: Date.parse(r.body.expires_at) });
    return r.body.token as string;
  };
}

/**
 * git args + env for a command that carries the token in env AIDENHQ_GIT_TOKEN (never argv, URL or .git/config): config a
 * planted repo could use to run code or reroute traffic is overridden, every other credential helper cleared, and this one
 * answers only `get` for protocol=https and host=github.com (as services/runner/src/github-app.mjs).
 */
export const CREDENTIAL_ARGS = [
  "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=", "-c", "core.sshCommand=", "-c", "http.proxy=",
  "-c", "credential.helper=",
  "-c", 'credential.helper=!f(){ test "$1" = get || return 0; h=; p=; while IFS= read -r l && [ -n "$l" ]; do case "$l" in host=*) h="${l#host=}";; protocol=*) p="${l#protocol=}";; esac; done; [ "$p" = https ] && [ "$h" = github.com ] || return 0; echo username=x-access-token; echo "password=$AIDENHQ_GIT_TOKEN"; }; f',
];

export const withGitToken = (args: string[], env: NodeJS.ProcessEnv, token: string): { args: string[]; env: NodeJS.ProcessEnv } => ({
  args: [...CREDENTIAL_ARGS, ...args],
  env: { ...env, GIT_CONFIG_NOSYSTEM: "1", AIDENHQ_GIT_TOKEN: token },
});
