// Git and GitHub as the owner, inside the GitHub process (spec 2026-11-20-github-owner-identity §1, §4): the owner's token
// reaches a git child only through its env (never argv, a URL or .git/config), and every commit the code host makes carries the
// AidenHQ trailer naming the agent (aidenhq-sdk/attribution.ts). Which repos are the fleet's own (the fleet org's and the product repo) decides where it merges.
import type { GitHubAccess } from "../../connections/github-mcp/src/client.ts";

/** GitHub as the code host calls it: the owner's client (rate limiter, typed needs). */
export type Gh = GitHubAccess["rest"];

export { trailer, withTrailer, hasTrailer, footer, withFooter, hasFooter } from "./aidenhq-sdk/attribution.ts";

/** The typed need a GitHub failure carries (client.ts GitHubNeed), read by shape: this code doesn't load github-mcp's code. */
export const needOf = (e: unknown): { cause: string } | undefined => {
  const n = (e as { need?: { cause?: unknown } } | undefined)?.need;
  return n && typeof n.cause === "string" ? (n as { cause: string }) : undefined;
};
/** GitHub is signed out or its sign-in stopped working: a write waits for the reconnect rather than failing. */
export const disconnected = (e: unknown) => ["not_connected", "expired"].includes(needOf(e)?.cause ?? "");

/** git env that makes `who` the author and committer. */
export const identityEnv = (who: { name: string; email: string }) => ({ GIT_AUTHOR_NAME: who.name, GIT_AUTHOR_EMAIL: who.email, GIT_COMMITTER_NAME: who.name, GIT_COMMITTER_EMAIL: who.email });

/** True when slug ("org/name") is in the fleet org. */
export const inOrg = (org: string | undefined, slug: string | undefined) => Boolean(org && slug) && slug!.split("/")[0]!.toLowerCase() === org!.toLowerCase();

const sameSlug = (a: string | undefined, b: string | undefined) => Boolean(a && b) && a!.toLowerCase() === b!.toLowerCase();
type ProductRepos = string | string[] | undefined;
const isProduct = (slug: string | undefined, product: ProductRepos) => [product ?? []].flat().some((p) => sameSlug(slug, p));

/** Our own repositories (the fleet org's and the product repo): their PR text may name our tooling. */
export const ownRepo = (slug: string | undefined, fleetOrg: string | undefined, productRepo: ProductRepos) => inOrg(fleetOrg, slug) || isProduct(slug, productRepo);

/**
 * Where the merge queue merges (owner, 2026-11-20): our own repositories and every listed repository (`listed`: the
 * owner listed it for the Maintainer or Ship). Elsewhere the code host only opens PRs.
 */
export const mergeable = (slug: string | undefined, fleetOrg: string | undefined, productRepo: ProductRepos, listed: string[]) =>
  ownRepo(slug, fleetOrg, productRepo) || listed.some((m) => sameSlug(slug, m));

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
