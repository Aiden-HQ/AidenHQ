// The kernel's own write kinds (spec §5.2): kernel.apply (a fleet apply: a commit landed on the instance repo and applied,
// with the module changes it brings) and kernel.raise_cap (a spend cap doubled), and the host runner's kinds until the code
// host module takes them (3d): push, pr, merge and create_repo. Each kind's args schema is strict; the runner's own side of
// the contract is services/runner/src/cards.ts (its card-contract test fails when a field it builds is missing here).
// The runner plans and executes its kinds and kernel.apply (it is the code host until 3d): it files them with its plan
// (POST /v1/writes with the runner's key), claims them once approved and reports their outcome. kernel.raise_cap is filed
// and run by the kernel itself (the model gateway).
import type { Card } from "./records.ts";
import { requestPatches } from "./tier.ts";
import type { Kind, Schema } from "./writes.ts";

const SHA: Schema = { type: "string", pattern: "^[0-9a-f]{40}$" };
// owner/name only: no `.git`, no trailing slash, no further path (repoKey canonicalises what reaches the same repo).
const NAME = "[\\w.-]+\\/(?![\\w.-]*\\.git(?:$|\\/))[\\w.-]*[\\w-]";
const REPO: Schema = { type: "string", pattern: `^${NAME}$` };
const PATCH: Schema = { type: "string", pattern: "^[0-9a-f]{64}$" };
const REF: Schema = { type: "string", minLength: 1, maxLength: 200, pattern: "^[^\\s`]+$" };
const BRANCH: Schema = { type: "object", additionalProperties: false, required: ["repo", "branch", "sha"], properties: { repo: REPO, branch: REF, sha: SHA, base: SHA, patch: PATCH } };
const BRANCHES: Schema = { type: "array", minItems: 1, maxItems: 30, items: BRANCH };
const obj = (properties: Record<string, Schema>, required: string[]): Schema => ({ type: "object", additionalProperties: false, required, properties });

export const RUNNER_ARGS: Record<string, Schema> = {
  push: obj({ only: BRANCHES }, ["only"]),
  // merge: the product repo's one-card path (push, PR, then merge at exactly these commits once green), shown on the card.
  pr: obj({ only: BRANCHES, text: obj({ title: { type: "string", maxLength: 300 }, body: { type: "string", maxLength: 60_000 } }, ["title", "body"]), merge: { enum: [true] } }, ["only"]),
  merge: obj({
    prs: { type: "array", minItems: 1, maxItems: 30, items: obj({ repo: REPO, number: { type: "integer", minimum: 1 }, url: { type: "string", pattern: `^(?:https:\\/\\/github\\.com\\/${NAME}\\/pull|codehost:${NAME}\\/change)\\/\\d+$` }, head: SHA, noReview: { enum: [true] }, patch: PATCH }, ["repo", "number", "url"]) },
    gap: { type: "integer", minimum: 0, maximum: 720 },
  }, ["prs"]),
  // A new app's repository in the agents org (the runner's tiers.mjs refuses any other org or name before filing).
  create_repo: obj({ repo: { type: "string", pattern: "^[\\w.-]+\\/[a-z][a-z0-9-]{0,62}$" } }, ["repo"]), // never `.git`: the name is lower-case letters, digits, dashes
};

// authority: the module changes the apply brings, one line each (scripts/compiler/authority.ts), shown on the card;
// ownerRequired: one of them adds module authority, so after the reviewer only the owner approves it (in the digest, as args).
const APPLY_ARGS = obj({
  repo: REPO, branch: REF, sha: SHA, files: { type: "array", minItems: 1, maxItems: 200, items: { type: "string", maxLength: 300 } },
  authority: { type: "array", minItems: 1, maxItems: 200, items: { type: "string", maxLength: 300, pattern: "^[^\\p{Cc}\\p{Cf}]+$" } }, ownerRequired: { type: "boolean" },
}, ["repo", "branch", "sha", "files"]);

const RAISE_ARGS = obj({
  scope: { enum: ["run", "task", "day"] }, agentId: { type: "string", minLength: 1, maxLength: 80 }, subject: { type: "string", pattern: "^[\\w:.-]{1,128}$" },
  cap: { type: "number", exclusiveMinimum: 0, maximum: 1000 }, spent: { type: "number", minimum: 0, maximum: 100_000 }, to: { type: "number" },
}, ["scope", "agentId", "subject", "cap", "spent", "to"]);

/** An apply's card, from its validated args and the diff the runner computed (bound by its hash in the record's targets). */
export function applyCard(a: { repo: string; branch: string; sha: string; files: string[]; authority?: string[] }, diff: string): Card {
  const authority = a.authority?.length ? `\nModule changes (the owner decides those marked owner, after the AI reviewer):\n${a.authority.join("\n")}` : "";
  return { target: `${a.repo} ${a.branch}`, sentence: `Apply a change to the fleet's configuration (commit ${a.sha.slice(0, 12)}).`, changes: `Lands ${a.sha.slice(0, 12)} on ${a.repo}'s main and re-applies the live fleet. Files: ${a.files.join(", ")}${authority}`, reads: "Nothing new.", cost: "No model cost; services restart.", details: diff };
}

const oneLine = (s: string, max: number) => s.replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/g, " ").trim().slice(0, max);
const usd = (n: number) => `$${n.toFixed(2)}`;
/** A raise_cap's card: every number is the gateway's ledger; the agent's name is looked up, printable and capped. */
export function raiseCapCard(a: { scope: string; agentId: string; subject: string; cap: number; spent: number; to: number }, agentName: string, identifier: string): Card {
  const who = oneLine(agentName, 80) || a.agentId;
  const on = a.scope === "run" ? "this run" : a.scope === "task" ? `task ${identifier}` : `${a.subject} (UTC day)`;
  return {
    target: `${who} ${a.scope} cap`, sentence: `Double ${who}'s ${a.scope} spend cap from ${usd(a.cap)} to ${usd(a.to)}.`, reads: "Nothing new.",
    changes: `${who} may spend up to ${usd(a.to)} on ${on} (${usd(a.spent)} spent so far); its calls are refused again at the new cap.`,
    cost: `Up to ${usd(Math.max(0, a.to - a.spent))} more in model calls.`, details: `agent: ${a.agentId}\nscope: ${a.scope}\non: ${a.subject}\ncap: ${usd(a.cap)} → ${usd(a.to)}\nspent: ${usd(a.spent)}`,
  };
}

/**
 * The product and instance repositories (owner/name, AIDENHQ_PRODUCT_REPO, AIDENHQ_INSTANCE_REPO) and the agents orgs the
 * fleet's own repos live in: one per enabled code host (`agentsOrgs`: the GitHub agents org, and `local` with codehost-local);
 * `agentsOrg` alone is the GitHub-only shape.
 */
export type Repos = { product?: string; instance?: string; modules?: string; agentsOrg?: string; agentsOrgs?: string[] };
/** The org codehost-local owns: a change request there is `codehost:local/<name>/change/<n>`. */
export const LOCAL_ORG = "local";
/**
 * A repository as one key, however it is written: owner/name lower-cased, a trailing `.git` and slashes dropped; anything
 * else (more path, odd characters, nothing) is no repository (undefined). Every rule here compares only these keys, and the
 * runner compares with the same function.
 */
export function repoKey(v: unknown): string | undefined {
  const s = String(v ?? "").trim().toLowerCase().replace(/\/+$/, "").replace(/\.git$/, "").replace(/\/+$/, "");
  return /^[\w.-]+\/[\w.-]+$/.test(s) && !/(^|\/)\.+($|\/)/.test(s) ? s : undefined;
}
/** The repository a GitHub PR's URL or a local change request's URL (codehost:<org>/<name>/change/<n>) names. */
export const urlRepo = (url: unknown) => repoKey(/^(?:https:\/\/github\.com\/([^/]+\/[^/]+)\/pull|codehost:([^/]+\/[^/]+)\/change)\/\d+\/*$/.exec(String(url ?? "").trim())?.slice(1).find(Boolean));
/**
 * What the kernel derives from a runner kind's args itself, never from the runner's plan:
 * - unknown product or instance repo: nothing can be told apart from them, so every runner kind is the owner's after the
 *   reviewer (fails closed, as tiers.mjs's unknown-repos);
 * - a refusal: a push, PR or merge on the instance repo (it changes only through kernel.apply), a merge whose PR URL names
 *   another repo than its `repo`, a repository created over the product's or the instance's name;
 * - the floor: a push, PR or merge runs at once (floor 0) only in the agents orgs, off its main branch, never on the product
 *   or instance repo, never a PR that also merges, and never a local change request's merge (no CI review read it: local-merge) (today's Tier 0 rules, as far as the args show them; the rest, such as
 *   green checks on the exact head, the runner's merge queue holds at execution); anything else at least the reviewer;
 * - new module authority (an apply's ownerRequired): the owner decides after the reviewer;
 * - the replacement target, and the veto's content keys (each branch's or PR's patch; "?" when one has none: fails closed).
 */
export function runnerFacts(kind: string, args: any, repos: Repos): { floor: 0 | 1 | 2; owner: boolean; refuse?: string; ownerRequired: boolean; target?: string; content: string | null } {
  const action = kind.replace(/^(runner|kernel)\./, "");
  const branches: { repo: string; branch: string }[] = args?.only ?? [];
  const prs: { repo: string; url: string }[] = args?.prs ?? [];
  const refused = (why: string) => ({ floor: 2 as const, owner: false, refuse: why, ownerRequired: false, content: null });
  if (prs.some((p) => !urlRepo(p.url) || urlRepo(p.url) !== repoKey(p.repo))) return refused("a PR's URL names another repository than its repo");
  const named = [...branches.map((b) => b.repo), ...prs.map((p) => p.repo), ...(action === "create_repo" || action === "apply" ? [args?.repo] : [])];
  const touched = named.map(repoKey);
  if (touched.some((r) => !r)) return refused("a repository isn't owner/name");
  const product = repoKey(repos.product) ?? "", instance = repoKey(repos.instance) ?? "";
  if (instance && action !== "apply" && touched.includes(instance)) return refused("the instance repo changes only through apply");
  if (product && action === "create_repo" && touched.includes(product)) return refused("the product repo already exists");
  const orgs = [repos.agentsOrgs ?? repos.agentsOrg].flat().filter(Boolean).map((o) => String(o).toLowerCase());
  if (action === "create_repo" && orgs.length && !orgs.includes(touched[0]!.split("/")[0]!)) return refused("repositories are created only in the agents org");
  const unknown = !product || !instance;
  const ours = orgs.length > 0 && touched.every((r) => orgs.includes(r!.split("/")[0]!) && r !== product && r !== instance);
  const localMerge = action === "merge" && touched.some((r) => r!.split("/")[0] === LOCAL_ORG);
  const floor = unknown ? 2 : !ours || localMerge || branches.some((b) => /^(main|master)$/.test(b.branch)) || args?.merge === true ? 1 : 0;
  const target = action === "merge" && prs.length ? prs.map((p) => `${urlRepo(p.url)}#${String(p.url).replace(/\/+$/, "").split("/").pop()}`).sort().join(" ")
    : (action === "push" || action === "pr") && branches.length ? branches.map((b) => `${repoKey(b.repo)} ${b.branch}`).sort().join(" ")
    : action === "apply" ? `${repoKey(args.repo)} ${args.branch}` : action === "create_repo" ? repoKey(args.repo) : undefined;
  const p = requestPatches(action, { branches, prs });
  return { floor, owner: unknown, ownerRequired: action === "apply" && args?.ownerRequired === true, ...(target ? { target } : {}), content: p === undefined ? null : p === null ? "?" : p };
}

/**
 * The kernel's roles a module may request (module.yaml roles.requests): each opens one backplane route or, for kernel.apply,
 * filing that kernel kind. No module declares a kernel.* role or a role named after a write kind (compile refuses both).
 */
export const KERNEL_ROLES = ["kernel.apply", "kernel.checks", "kernel.cp-read", "kernel.grader", "kernel.jobs", "kernel.lane", "kernel.notify", "kernel.owner-notice", "kernel.tasks", "kernel.wake", "kernel.work-read"];

/** The kernel's kinds, beside the modules' compiled ones (config/kernel/writes.json). */
export const KERNEL_KINDS: Record<string, Kind> = {
  // An apply is always read by the reviewer first (floor 1); a push, a PR, a merge and a new repo by what they touch (runnerFacts).
  // A new repository grows the agents org: the reviewer and a second one always (tiers.mjs createRepoParts).
  ...Object.fromEntries(Object.entries(RUNNER_ARGS).map(([k, args]) => [`runner.${k}`, { module: "runner", floor: k === "create_repo" ? 1 : 0, ...(k === "create_repo" ? { panel: true } : {}), tools: [], args, runner: true } as Kind])),
  // kernel.apply: planned by the kernel (apply-tier.ts) once the switch drops `runner`; its files raise it by the path inventory.
  "kernel.apply": { module: "kernel", floor: 1, paths: true, tools: [], args: APPLY_ARGS, runner: true },
  "kernel.raise_cap": { module: "kernel", floor: 2, tools: [], args: RAISE_ARGS },
};
