// The kernel's own write kinds (spec §5.2): kernel.apply (a fleet apply: a commit landed on the instance repo and applied,
// with the module changes it brings) and kernel.raise_cap (a spend cap doubled), and the host runner's kinds until the code
// host module takes them (3d): push, pr, merge and create_repo. Each kind's args schema is strict; the runner's own side of
// the contract is services/runner/src/cards.ts (its card-contract test fails when a field it builds is missing here).
// The runner plans and executes its kinds and kernel.apply (it is the code host until 3d): it files them with its plan
// (POST /v1/writes with the runner's key), claims them once approved and reports their outcome. kernel.raise_cap is filed
// and run by the kernel itself (the model gateway).
import type { Card } from "./records.ts";
import type { Kind, Schema } from "./writes.ts";

const SHA: Schema = { type: "string", pattern: "^[0-9a-f]{40}$" };
const REPO: Schema = { type: "string", pattern: "^[\\w.-]+\\/[\\w.-]+$" };
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
    prs: { type: "array", minItems: 1, maxItems: 30, items: obj({ repo: REPO, number: { type: "integer", minimum: 1 }, url: { type: "string", pattern: "^https:\\/\\/github\\.com\\/[\\w.-]+\\/[\\w.-]+\\/pull\\/\\d+$" }, head: SHA, noReview: { enum: [true] }, patch: PATCH }, ["repo", "number", "url"]) },
    gap: { type: "integer", minimum: 0, maximum: 720 },
  }, ["prs"]),
  // A new app's repository in the agents org (the runner's tiers.mjs refuses any other org or name before filing).
  create_repo: obj({ repo: { type: "string", pattern: "^[\\w.-]+\\/[a-z][a-z0-9-]{0,62}$" } }, ["repo"]),
};

// authority: the module changes the apply brings, one line each (kernel/src/loader/authority.ts), shown on the card;
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

/** The kernel's kinds, beside the modules' compiled ones (config/kernel/writes.json). */
export const KERNEL_KINDS: Record<string, Kind> = {
  ...Object.fromEntries(Object.entries(RUNNER_ARGS).map(([k, args]) => [`runner.${k}`, { module: "runner", floor: 0, tools: [], args, runner: true } as Kind])),
  "kernel.apply": { module: "kernel", floor: 0, tools: [], args: APPLY_ARGS, runner: true },
  "kernel.raise_cap": { module: "kernel", floor: 2, tools: [], args: RAISE_ARGS },
};
