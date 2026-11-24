// Ship's config tools (role ship-admin), on the module's MCP connection `ship`: `ship_config` reads the effective settings per
// repo, `ship_configure` changes one repo's entry. Built like code-review's: the change is applied to the raw value, the whole
// result validated, and one typed settings change filed as the calling job (POST /v1/settings/agent).
// A change that loosens anything (loosens()) is the owner's: the tool refuses it and the owner makes it from the board.
import { CONTROLS, covers, effective, loosens, PRESETS, validate, type Scope } from "./settings.ts";
import { status } from "./status.ts";
import type { State } from "./state.ts";
import type { Tool } from "./mcp.ts";

type Dict = Record<string, unknown>;
export interface Change {
  /** `owner/name`, or `defaults` for the entry every uncovered-by-entry repo takes. */
  repo: string;
  /** A preset name, a map of fields (merged into the entry), or null to remove the entry. */
  change: unknown;
  scope: Scope;
}

/** The setting after a change, the summary lines and what it loosens. Throws with an owner-readable reason. */
export function applyShipChange(raw: Dict, c: Change): { value: Dict; summary: string[]; loosens: string[] } {
  const value: Dict = structuredClone(raw ?? {});
  const isDefaults = c.repo === "defaults";
  const repos = (value.repos ??= {}) as Dict;
  const key = isDefaults ? "defaults" : Object.keys(repos).find((k) => k.toLowerCase() === c.repo.toLowerCase()) ?? c.repo;
  const old = isDefaults ? value.defaults : repos[key];
  let next: unknown;
  let summary: string;
  if (c.change === null) { next = undefined; summary = `${c.repo}: back to the defaults`; }
  else if (typeof c.change === "string") { if (!Object.hasOwn(PRESETS, c.change)) throw new Error(`${c.change} isn't a preset (cautious or full)`); next = c.change; summary = `${c.repo}: ship ${c.change}`; }
  else if (c.change && typeof c.change === "object" && !Array.isArray(c.change)) {
    const base = typeof old === "string" ? { preset: old } : (old as Dict) ?? {};
    const ch = c.change as Dict;
    // caps and safe merge field by field: lowering one cap keeps the others.
    next = { ...base, ...ch, ...Object.fromEntries(["caps", "safe"].filter((k) => ch[k] && typeof ch[k] === "object").map((k) => [k, { ...((base as Dict)[k] as Dict), ...(ch[k] as Dict) }])) };
    summary = `${c.repo}: ${Object.keys(c.change).join(", ")} changed`;
  } else throw new Error("change is a preset name, a map of fields, or null");
  const target = isDefaults ? value : repos;
  const slot = isDefaults ? "defaults" : key;
  if (next === undefined) delete target[slot]; else target[slot] = next;
  const errors = validate(value, c.scope);
  if (errors.length) throw new Error(`that setting wouldn't work: ${errors.join("; ")}`);
  return { value, summary: [summary], loosens: loosens(raw, value, c.scope) };
}

const REPO = /^[\w.-]{1,100}\/[\w.-]{1,100}$/;
const same = (a: unknown, b: string) => String(typeof a === "string" ? a : (a as Dict)?.repo).toLowerCase() === b.toLowerCase();

/**
 * A repo ship doesn't cover yet: one settings change that lists it for the Maintainer (maintainer_repos, no duty on) and code review
 * (code_review, its defaults) and gives it its ship entry, so the three land or none does. Only the owner's Fleet page calls it.
 */
export function addRepo(d: { raw: Dict; scope: Scope; maintainerRepos: unknown[]; codeReview: Dict }, repo: string, change: unknown) {
  if (!REPO.test(repo)) throw new Error(`${repo.slice(0, 100)} isn't owner/name`);
  const { value, summary } = applyShipChange(d.raw, { repo, change: change ?? "cautious", scope: { ...d.scope, listed: [...d.scope.listed, repo] } });
  const watched = ((d.codeReview.repos as unknown[]) ?? []);
  const changes: Dict[] = [
    { kind: "setting", key: "maintainer_repos", value: [...d.maintainerRepos, { repo, issues: false }] },
    ...(watched.some((x) => same(x, repo)) ? [] : [{ kind: "setting", key: "code_review", value: { ...d.codeReview, repos: [...watched, { repo }] } }]),
    { kind: "setting", key: "ship", value },
  ];
  return { changes, summary: [`${repo}: listed for the Maintainer and code review, then ${summary[0]!.slice(repo.length + 2)}`] };
}

/** Takes a listed repo off ship, the Maintainer and code review in one change: no ship entry is left outside the scope. Only the owner's Fleet page calls it. */
export function removeRepo(d: { raw: Dict; scope: Scope; maintainerRepos: unknown[]; codeReview: Dict }, repo: string) {
  if (!d.scope.listed.some((x) => x.toLowerCase() === repo.toLowerCase())) throw new Error(`${repo} isn't a listed repo (a fleet repo stays covered)`);
  const ship = structuredClone(d.raw), repos = (ship.repos ?? {}) as Dict;
  for (const k of Object.keys(repos)) if (same(k, repo)) delete repos[k];
  const watched = ((d.codeReview.repos as unknown[]) ?? []).filter((x) => !same(x, repo));
  return {
    changes: [
      { kind: "setting", key: "maintainer_repos", value: d.maintainerRepos.filter((x) => !same(x, repo)) },
      { kind: "setting", key: "code_review", value: { ...d.codeReview, repos: watched } },
      { kind: "setting", key: "ship", value: { ...ship, repos } },
    ] as Dict[],
    summary: [`${repo}: removed from ship, the Maintainer and code review`],
  };
}

export function configTools(d: {
  raw: () => Dict; scope: () => Scope; state: State;
  /** maintainer_repos and settings.code_review as compiled (a new repo is added to both). */
  maintainerRepos: () => unknown[]; codeReview: () => Dict;
  /** POST /v1/settings/agent as the calling job (its assertion goes along). */
  file: (changes: Dict[], assertion: string) => Promise<unknown>;
}): Tool[] {
  return [
    {
      name: "ship_config", roles: ["ship-admin"],
      description: "What ship is set to: the raw setting, its problems, the presets, the scope (fleet repos and listed ones) and the effective settings of each listed repo.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      run: async () => {
        const raw = d.raw(), scope = d.scope();
        const repos = Object.keys((raw.repos as Dict) ?? {}).map((r) => [r, effective(raw, r, scope)]);
        return { setting: raw, problems: validate(raw, scope), scope, presets: PRESETS, controls: CONTROLS, defaults: effective(raw, "*/*", { fleet: ["*/*"], listed: [] }), repos: Object.fromEntries(repos) };
      },
    },
    {
      name: "ship_status",
      description: "Ship's status: paused, each listed repo's headline settings and the adoptions on hold with their reasons ({ repo? } narrows to one repo). The Fleet page reads it.",
      inputSchema: { type: "object", properties: { repo: { type: "string" } }, additionalProperties: false },
      run: async (a) => status(d.raw(), d.scope(), d.state, typeof a.repo === "string" ? a.repo : undefined),
    },
    {
      name: "ship_configure", roles: ["ship-admin"],
      description: "Change ship's settings in one reviewed settings change on your task. { repo: owner/name or `defaults`, change: a preset name (cautious | full), a map of the fields to change (enabled, preset, handoff, rebase, generated { globs, command }, fix, protected, caps { … null = unlimited }, approve, safe, merge, stop_label) or null to drop the entry }, or { paused: true | false } for the kill switch, or { repo, remove: true } (the owner's: it takes a listed repo off ship, the Maintainer and code review). A repo ship doesn't cover yet is the owner's to add from the Fleet page. Refused whole when the result wouldn't validate. A change that loosens anything (more handoff, a higher or removed cap, a wider approve or fix, a narrower protected list, clearing paused) is the owner's: it is refused here and the owner makes it from the Fleet page.",
      inputSchema: { type: "object", properties: { repo: { type: "string" }, change: {}, paused: { type: "boolean" }, remove: { type: "boolean" } }, additionalProperties: false },
      run: async (a, caller) => {
        const raw = d.raw(), scope = d.scope();
        let changes: Dict[], summary: string[], l: string[];
        if (typeof a.paused === "boolean") {
          const value = { ...raw, paused: a.paused };
          const errors = validate(value, scope);
          if (errors.length) throw new Error(`that setting wouldn't work: ${errors.join("; ")}`);
          changes = [{ kind: "setting", key: "ship", value }]; summary = [a.paused ? "ship paused" : "ship resumed"]; l = loosens(raw, value, scope);
        } else if (a.remove === true && typeof a.repo === "string") {
          if (caller.kind !== "owner") throw new Error("removing a repo is the owner's: ask them to remove it from the Fleet page");
          ({ changes, summary } = removeRepo({ raw, scope, maintainerRepos: d.maintainerRepos(), codeReview: d.codeReview() }, a.repo)); l = [];
        } else if (typeof a.repo === "string" && a.repo !== "defaults" && !covers(a.repo, scope)) {
          ({ changes, summary } = addRepo({ raw, scope, maintainerRepos: d.maintainerRepos(), codeReview: d.codeReview() }, a.repo, a.change)); l = [];
          // One change across the github, code-review and ship settings: the board saves it for the owner; an agent's filing is per module.
          if (caller.kind !== "owner") throw new Error(`${a.repo} isn't covered yet: adding a repo (its maintainer_repos, code_review and ship entries together) is the owner's: ask them to add it from the Fleet page`);
        } else {
          const r = applyShipChange(raw, { repo: String(a.repo), change: a.change, scope });
          changes = [{ kind: "setting", key: "ship", value: r.value }]; summary = r.summary; l = r.loosens;
        }
        // The owner's own call (the Fleet page) only proposes: the board shows it and files it on his Save.
        if (caller.kind === "owner") return { changes: summary, _aidenhq: { settings_change: changes } };
        if (l.length) throw new Error(`that change loosens ${l.join(", ")}: the owner's to approve; ask them to make it from the Fleet page`);
        return { filed: await d.file(changes, caller.assertion ?? ""), changes: summary };
      },
    },
  ];
}
