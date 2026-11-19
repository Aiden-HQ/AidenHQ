// Access to private agents-org repos through the instance's GitHub App, without its key: per repo, a short-lived token from
// the kernel (the github module's code host mints it), narrowed to that one repo and {contents: read} (write for the registry push), handed
// to that one git child through a credential helper reading an env var.
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

/** `more`: permissions beyond contents (previews.ts reads and comments on pull requests: pull_requests write). */
export type RepoToken = ((slug: string, perm?: "read" | "write", more?: Record<string, "read" | "write">) => Promise<string>) & {
  /** The App's bot login (`<slug>[bot]`, as the kernel reports it with each token): set once any token has been minted. */
  botLogin?: string;
};

/**
 * Whether this instance runs the GitHub code host (the github module's App part): the host recorded its agents org
 * (AIDENHQ_GITHUB_AGENTS_ORG, written when the GitHub App is created), the one fact every GitHub part follows.
 */
export function githubHost(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.AIDENHQ_GITHUB_AGENTS_ORG?.trim());
}

/**
 * Tokens for single repos (contents: read, or write for the registry push), from the kernel's POST /v1/codehost/token under this
 * module's `codehost:` grant (only the github module's code host holds the App's key), reused until 5 minutes before they expire.
 */
export function appTokens(kernelUrl: string, key: string, fetch = globalThis.fetch): RepoToken {
  const cache = new Map<string, { token: string; expires: number }>();
  const mint: RepoToken = async (slug, perm = "read", more = {}) => {
    const ck = `${slug.toLowerCase()}:${perm}:${JSON.stringify(more)}`;
    const hit = cache.get(ck);
    if (hit && hit.expires - Date.now() > 5 * 60_000) return hit.token;
    const r = await fetch(`${kernelUrl}/v1/codehost/token`, {
      method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ repo: slug, perms: { ...more, contents: perm } }), signal: AbortSignal.timeout(30_000),
    });
    const b = (await r.json().catch(() => ({}))) as any;
    if (r.status !== 200) throw new Error(`couldn't get a GitHub App token for ${slug} (the kernel said ${r.status} ${b?.error?.message ?? b?.error ?? ""})`.trim());
    cache.set(ck, { token: String(b.token), expires: Date.parse(b.expires_at) });
    if (b.app?.slug) mint.botLogin = `${b.app.slug}[bot]`;
    return String(b.token);
  };
  return mint;
}

/**
 * git args + env for a command that carries the token in env AIDENHQ_GIT_TOKEN (never argv, URL or .git/config): config a
 * planted repo could use to run code or reroute traffic is overridden, every other credential helper cleared, and this one
 * answers only `get` for protocol=https and host=github.com (as modules/github/service/src/github-app.ts).
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
