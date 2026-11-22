// The kernel's own write kind (spec §5.2): kernel.apply (a fleet apply: a commit landed on the instance repo and applied,
// with the module changes it brings; planned by apply-tier.ts). Its args schema is strict.
import type { Card } from "./records.ts";
import type { Kind, Schema } from "./writes.ts";

const SHA: Schema = { type: "string", pattern: "^[0-9a-f]{40}$" };
// owner/name only: no `.git`, no trailing slash, no further path (repoKey canonicalises what reaches the same repo).
const NAME = "[\\w.-]+\\/(?![\\w.-]*\\.git(?:$|\\/))[\\w.-]*[\\w-]";
const REPO: Schema = { type: "string", pattern: `^${NAME}$` };
const REF: Schema = { type: "string", minLength: 1, maxLength: 200, pattern: "^[^\\s`]+$" };
const obj = (properties: Record<string, Schema>, required: string[]): Schema => ({ type: "object", additionalProperties: false, required, properties });

// authority: the module changes the apply brings, one line each (scripts/compiler/authority.ts), shown on the card; release:
// the release the owner's auto-updates ask for, set only by the planner on the updater's verified move (apply-tier.ts
// standingRelease).
const APPLY_ARGS = obj({
  repo: REPO, branch: REF, sha: SHA, files: { type: "array", minItems: 1, maxItems: 200, items: { type: "string", maxLength: 300 } },
  authority: { type: "array", minItems: 1, maxItems: 1000, items: { type: "string", maxLength: 4000, pattern: "^[^\\p{Cc}\\p{Cf}]+$" } },
  release: { type: "string", pattern: "^[0-9]{4}\\.[0-9]{1,2}(\\.[0-9]+){0,2}$" },
}, ["repo", "branch", "sha", "files"]);

/** An apply's card, from its validated args and the diff the planner computed (bound by its hash in the record's targets). */
export function applyCard(a: { repo: string; branch: string; sha: string; files: string[]; authority?: string[] }, diff: string): Card {
  const authority = a.authority?.length ? `\nModule changes:\n${a.authority.join("\n")}` : "";
  return { target: `${a.repo} ${a.branch}`, sentence: `Apply a change to the fleet's configuration (commit ${a.sha.slice(0, 12)}).`, changes: `Lands ${a.sha.slice(0, 12)} on ${a.repo}'s main and re-applies the live fleet. Files: ${a.files.join(", ")}${authority}`, reads: "Nothing new.", cost: "No model cost; services restart.", details: diff };
}

/**
 * The product and instance repositories (owner/name, AIDENHQ_PRODUCT_REPO, AIDENHQ_INSTANCE_REPO) and the agents orgs the
 * fleet's own repos live in: one per enabled code host (`agentsOrgs`: the GitHub agents org, and `local` with codehost-local);
 * `agentsOrg` alone is the GitHub-only shape.
 */
export type Repos = { product?: string; instance?: string; agentsOrg?: string; agentsOrgs?: string[] };
/** The org codehost-local owns: a change request there is `codehost:local/<name>/change/<n>`. */
export const LOCAL_ORG = "local";
/**
 * A repository as one key, however it is written: owner/name lower-cased, a trailing `.git` and slashes dropped; anything
 * else (more path, odd characters, nothing) is no repository (undefined). Every rule here compares only these keys.
 */
export function repoKey(v: unknown): string | undefined {
  const s = String(v ?? "").trim().toLowerCase().replace(/\/+$/, "").replace(/\.git$/, "").replace(/\/+$/, "");
  return /^[\w.-]+\/[\w.-]+$/.test(s) && !/(^|\/)\.+($|\/)/.test(s) ? s : undefined;
}
/**
 * The kernel's roles a module may request (module.yaml roles.requests): each opens one backplane route or, for kernel.apply,
 * filing that kernel kind. No module declares a kernel.* role or a role named after a write kind (compile refuses both).
 */
export const KERNEL_ROLES = ["kernel.apply", "kernel.checks", "kernel.cp-read", "kernel.facts", "kernel.flow-read", "kernel.grader", "kernel.jobs", "kernel.lane", "kernel.notify", "kernel.owner-notice", "kernel.routines", "kernel.routing", "kernel.settings", "kernel.tasks", "kernel.wake", "kernel.work-read"];

/** The kernel's kinds, beside the modules' compiled ones (config/kernel/writes.json). */
export const KERNEL_KINDS: Record<string, Kind> = {
  // An apply is always read by the reviewer first (floor 1): planned by the kernel (apply-tier.ts).
  "kernel.apply": { module: "kernel", floor: 1, tools: [], args: APPLY_ARGS },
};
