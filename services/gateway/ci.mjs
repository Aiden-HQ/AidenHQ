// App CI code review through the gateway (the `code-review` job of modules/core/templates/ci, on the self-hosted runners of
// modules/ci): who may get a CI token, and what a CI model call may send. lib.mjs issues and checks the tokens.
//
// A job proves itself with GitHub Actions' OIDC token (permission `id-token: write`, audience CI_AUDIENCE), checked here
// against GitHub's published keys: signed RS256 by GitHub, for a pull_request job on a self-hosted runner in one of the
// instance's orgs. The repo and PR come from that signed token: the trusted attribution. Everything the job itself sends
// (the head sha) is advisory. The gateway then issues an opaque, short-lived `ahqci_` token bound to that repo and PR.
import { createPublicKey, verify } from "node:crypto";

export const CI_KIND = "ci-code-review";
export const CI_PREFIX = "ahqci_";
export const CI_AUDIENCE = "aidenhq-gateway";
export const GITHUB_ISSUER = "https://token.actions.githubusercontent.com";
const SKEW_S = 60;

/**
 * GitHub's OIDC signing keys by kid, from its JWKS: refreshed hourly, and on an unknown kid at most once a minute (whatever
 * the outcome, so a flood of bad tokens never becomes a flood of fetches). A failed refresh keeps the keys it had; with none,
 * every token is refused (fails closed).
 */
export function githubKeys(url = `${GITHUB_ISSUER}/.well-known/jwks`, now = Date.now) {
  let keys = new Map(), fetchedAt = 0, triedAt = 0, pending;
  const refresh = async () => {
    triedAt = now();
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`GitHub's OIDC keys answered ${res.status}`);
    const next = new Map();
    for (const k of (await res.json())?.keys ?? []) {
      if (k?.kty !== "RSA" || typeof k.kid !== "string") continue;
      try { next.set(k.kid, createPublicKey({ key: k, format: "jwk" })); } catch {}
    }
    keys = next;
    fetchedAt = now();
  };
  return async (kid) => {
    const stale = now() - fetchedAt > 3600_000 || !keys.has(kid);
    if (stale && now() - triedAt > 60_000) {
      pending ??= refresh().catch(() => {}).finally(() => { pending = undefined; });
      await pending;
    }
    return keys.get(kid);
  };
}

/**
 * The checked claims of a GitHub Actions OIDC token: { repo, pr, runId, attempt } for a pull_request job of the repo's own
 * CI workflow (.github/workflows/ci.yml) on a self-hosted runner in one of `orgs`. Anything else throws a 401. The claims are read and checked first (cheap: junk never reaches a key lookup
 * or the RSA check), then the signature (about 20 microseconds); only then do they count.
 */
export async function verifyGithubOidc(jwt, { orgs, keyFor, now = Date.now }) {
  const bad = (why) => Object.assign(new Error(`not a GitHub Actions token this gateway takes (${why})`), { status: 401, type: "unauthorized" });
  const parts = String(jwt ?? "").split(".");
  if (parts.length !== 3 || parts.some((p) => !p || p.length > 8192)) throw bad("malformed");
  const json = (s) => { try { return JSON.parse(Buffer.from(s, "base64url").toString("utf8")); } catch { return undefined; } };
  const header = json(parts[0]);
  const c = json(parts[1]);
  if (header?.alg !== "RS256" || typeof header.kid !== "string" || !c || typeof c !== "object") throw bad("malformed");
  const t = now() / 1000;
  if (c.iss !== GITHUB_ISSUER || c.aud !== CI_AUDIENCE) throw bad("issuer or audience");
  if (!(typeof c.exp === "number" && c.exp > t - SKEW_S) || (c.nbf !== undefined && !(c.nbf <= t + SKEW_S))) throw bad("expired");
  const owner = String(c.repository_owner ?? "").toLowerCase();
  const repo = typeof c.repository === "string" && /^[\w.-]{1,100}\/[\w.-]{1,100}$/.test(c.repository) ? c.repository : "";
  if (!owner || !orgs.some((o) => String(o).toLowerCase() === owner) || repo.split("/")[0].toLowerCase() !== owner) throw bad("not this instance's org");
  if (c.runner_environment !== "self-hosted") throw bad("not a self-hosted runner");
  const pr = c.event_name === "pull_request" ? /^refs\/pull\/(\d{1,9})\/merge$/.exec(String(c.ref ?? "")) : null;
  if (!pr) throw bad("not a pull request's job");
  // Our CI workflow, for this repo and PR (a PR can still edit ci.yml: the caps are the boundary, this keeps other workflows
  // and other PRs' tokens out); a plain base branch; and the run, so each run attempt trades its token once (lib.mjs).
  if (c.workflow_ref !== `${repo}/.github/workflows/ci.yml@refs/pull/${pr[1]}/merge`) throw bad("not this repo's CI workflow for this PR");
  if (typeof c.base_ref !== "string" || !/^[\w.-]+(?:\/[\w.-]+)*$/.test(c.base_ref) || c.base_ref.includes("..") || c.base_ref.length > 200) throw bad("no plain base branch");
  const runId = /^\d{1,20}$/.test(String(c.run_id)) ? String(c.run_id) : "";
  const attempt = /^\d{1,6}$/.test(String(c.run_attempt)) ? String(c.run_attempt) : "";
  if (!runId || !attempt) throw bad("no run");
  const key = await keyFor(header.kid);
  if (!key) throw bad("unknown signing key");
  if (!verify("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], "base64url"))) throw bad("signature");
  return { repo, pr: Number(pr[1]), runId, attempt };
}

// What a CI call may send: the chat-completion fields codegenie sends (probed on 0.7.0), nothing that changes where or what
// OpenRouter runs (no `models` fallbacks, presets, plugins, web search or server tools). The provider block may only steer
// among providers; the gateway adds ZDR.
const BODY = new Set(["model", "messages", "stream", "stream_options", "tools", "tool_choice", "parallel_tool_calls", "reasoning", "store", "max_tokens", "max_completion_tokens", "temperature", "top_p", "stop", "seed", "response_format", "provider"]);
const PROVIDER = new Set(["only", "order", "allow_fallbacks", "ignore", "require_parameters", "sort", "quantizations"]);

/** Why a CI call's body is refused, or undefined. `models`: the allowed model ids, exactly. */
export function ciBodyProblem(body, models) {
  if (!models.includes(body.model)) return `model ${String(body.model).slice(0, 80)} isn't one CI code review may use (settings.ci_review_models)`;
  const extra = Object.keys(body).find((k) => !BODY.has(k));
  if (extra) return `field ${extra.slice(0, 40)} isn't allowed in a CI call`;
  if (body.tools !== undefined && (!Array.isArray(body.tools) || body.tools.some((t) => t?.type !== "function"))) return "only function tools are allowed in a CI call";
  const p = body.provider;
  if (p !== undefined && (!p || typeof p !== "object" || Array.isArray(p) || Object.keys(p).some((k) => !PROVIDER.has(k)))) return "only provider order and filters are allowed in a CI call";
  return undefined;
}
