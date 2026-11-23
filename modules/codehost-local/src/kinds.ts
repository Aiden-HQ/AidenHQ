// codehost-local's write kinds, as code rather than only as a comment: `codehost-local.{push,pr,merge,close,create_repo}`, the
// same actions codehost-github declares, each with its args schema, its floor and its card. They belong to the module that holds
// the `codehost` role for the org `local` (module.yaml `provides: [ codehost ]`), and the kernel registers exactly these when
// that module is enabled: nothing here touches GitHub or a token, because the executor behind them is this
// module's, running in the kernel's process (src/host.ts `executor`, wired in kernel/src/main.ts).
//
// The floors are codehost-github's (modules/github/module.yaml): every kind files at 0 and plan.ts raises what it must. A
// `local/*` merge is Tier 1 `local-merge` (modules/github/service/src/plan.ts mergeParts), so the AI reviewer still reads its
// diff.
import type { Kind } from "../../../kernel/src/writes.ts";

type Schema = Record<string, unknown>;
const obj = (properties: Record<string, Schema>, required: string[]): Schema => ({ type: "object", additionalProperties: false, required, properties });
/** A repository on this server: the org `local` only, no `.git`, no path beyond the name. */
const REPO = { type: "string", pattern: "^local/[\\w.-]+$" };
const BRANCHES = obj({
  workspace: { type: "string", pattern: "^[A-Za-z][A-Za-z0-9]*-[0-9]+$" },
  only: { type: "array", minItems: 1, maxItems: 30, items: obj({ repo: REPO, branch: { type: "string", minLength: 1, maxLength: 200, pattern: "^[\\w./-]+$" }, sha: { type: "string", pattern: "^[0-9a-f]{40}$" } }, ["repo", "branch", "sha"]) },
  // `body` is optional: `aidenhq publish` without --body-file names no body, and an open change keeps its description.
  text: obj({ title: { type: "string", maxLength: 300 }, body: { type: "string", maxLength: 60000 } }, ["title"]),
}, ["workspace", "only"]);
const CHANGES = (head: boolean) => obj({ prs: { type: "array", minItems: 1, maxItems: 30, items: obj({ repo: REPO, number: { type: "integer", minimum: 1 }, ...(head ? { head: { type: "string", pattern: "^[0-9a-f]{40}$" } } : {}) }, head ? ["repo", "number", "head"] : ["repo", "number"]) } }, ["prs"]);
const CARD = { target: "{{target}}", sentence: "{{sentence}}", details: "{{diff}}" };

/** The actions and their args: what a local change may ask for. */
export const LOCAL_ACTIONS: { action: "push" | "pr" | "merge" | "close" | "create_repo"; args: Schema }[] = [
  { action: "push", args: BRANCHES },
  { action: "pr", args: BRANCHES },
  { action: "merge", args: CHANGES(true) },
  { action: "close", args: CHANGES(false) },
  { action: "create_repo", args: obj({ repo: { type: "string", pattern: "^local/[a-z][a-z0-9-]{0,62}$" } }, ["repo"]) },
];

/**
 * The kinds the kernel registers for codehost-local, by kind id. The executor is the module's own, in process: the kernel calls
 * `host.ts`'s plan and execute directly (kernel/src/writes.ts `inProcess`), so no service, no secret and no GitHub credential is
 * involved. `module: "codehost-local"` is what routes a `codehost.<action>` naming a `local/*` repo to these (kernel/src/codehost.ts
 * `routeKind`), and what grants an Engineer job the kinds it may ask for (kernel/src/admission.ts, its CODEHOSTS).
 */
export function localKinds(): Record<string, Kind> {
  return Object.fromEntries(LOCAL_ACTIONS.map(({ action, args }) => [
    `codehost-local.${action}`,
    { module: "codehost-local", floor: 0, tools: [], args, card: CARD } as Kind,
  ]));
}

/** The kinds, as the kernel's registry wants them (kernel/src/main.ts, and the tests). */
export const LOCAL_KINDS: Record<string, Kind> = localKinds();
