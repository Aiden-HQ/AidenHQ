// Ship's config tools (role ship-admin), on the module's MCP connection `ship`: `ship_config` reads the effective settings per
// repo, `ship_configure` changes one repo's entry. Built like code-review's: the change is applied to the raw value, the whole
// result validated, and one typed settings change filed as the calling job (POST /v1/settings/agent).
// A change that loosens anything (loosens()) is the owner's: the tool refuses it and the owner makes it from the board.
import { CAP_KEYS, CONTROLS, covers, effective, FIELDS, loosens, PRESETS, validate, type Scope } from "./settings.ts";
import { status } from "./status.ts";
import type { State } from "./state.ts";
import type { Tool } from "./mcp.ts";

type Dict = Record<string, unknown>;
/** What a change's `reset` may name: a field (not the preset), a cap, or one of safe's three fields. `actions` is allowed ahead of its validation landing. */
const RESETTABLE = new Set([...FIELDS.filter((k) => !["preset", "caps", "safe"].includes(k)), "actions", ...CAP_KEYS.map((k) => `caps.${k}`), "safe.max_lines", "safe.max_files", "safe.deny"]);
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
    const { reset, ...ch } = c.change as Dict;
    // caps and safe merge field by field: lowering one cap keeps the others.
    const entry: Dict = { ...base, ...ch, ...Object.fromEntries(["caps", "safe"].filter((k) => ch[k] && typeof ch[k] === "object").map((k) => [k, { ...((base as Dict)[k] as Dict), ...(ch[k] as Dict) }])) };
    // `reset: ["caps.usd", "approve"]` drops those fields from the entry, so the preset's value applies again.
    if (reset !== undefined && !Array.isArray(reset)) throw new Error("reset is a list of fields, such as [\"caps.usd\", \"approve\"]");
    for (const p of reset ?? []) {
      if (!RESETTABLE.has(String(p))) throw new Error(`can't reset ${String(p).slice(0, 40)} (one of ${[...RESETTABLE].join(", ")})`);
      const [k, sub] = String(p).split(".");
      if (sub && entry[k] && typeof entry[k] === "object") { const m = { ...(entry[k] as Dict) }; delete m[sub]; if (Object.keys(m).length) entry[k] = m; else delete entry[k]; } else if (!sub) delete entry[k];
    }
    next = entry;
    summary = `${c.repo}: ${[...Object.keys(ch), ...(Array.isArray(reset) && reset.length ? [`reset ${reset.join(", ")}`] : [])].join(", ")} changed`;
  } else throw new Error("change is a preset name, a map of fields, or null");
  const target = isDefaults ? value : repos;
  const slot = isDefaults ? "defaults" : key;
  if (next === undefined) delete target[slot]; else target[slot] = next;
  // An entry left outside the scope (its repo was taken off the Maintainer) isn't this change's to fix: only the repo being changed is checked against it.
  const entries = Object.entries((value.repos as Dict) ?? {}).filter(([k]) => covers(k, c.scope) || k.toLowerCase() === c.repo.toLowerCase());
  const errors = validate({ ...value, repos: Object.fromEntries(entries) }, c.scope);
  if (errors.length) throw new Error(`that setting wouldn't work: ${errors.join("; ")}`);
  return { value, summary: [summary], loosens: loosens(raw, value, c.scope) };
}

const REPO = /^[\w.-]{1,100}\/[\w.-]{1,100}$/;
const same = (a: unknown, b: string) => String(typeof a === "string" ? a : (a as Dict)?.repo).toLowerCase() === b.toLowerCase();

/**
 * Adds a repo to ship: one settings change that lists it for the Maintainer (maintainer_repos, no duty on, unless already listed) and
 * code review (code_review, its defaults) and gives it its ship entry, so what is missing lands together or none does. Only the owner's Fleet page calls it.
 */
export function addRepo(d: { raw: Dict; scope: Scope; maintainerRepos: unknown[]; codeReview: Dict }, repo: string, change: unknown) {
  if (!REPO.test(repo)) throw new Error(`${repo.slice(0, 100)} isn't owner/name`);
  const { value, summary } = applyShipChange(d.raw, { repo, change: change ?? "cautious", scope: { ...d.scope, listed: [...d.scope.listed, repo] } });
  // A repo the Maintainer already lists (or the fleet covers) keeps its entry and duties: only what is missing is added.
  const listed = covers(repo, d.scope), watched = ((d.codeReview.repos as unknown[]) ?? []);
  const changes: Dict[] = [
    ...(listed ? [] : [{ kind: "setting", key: "maintainer_repos", value: [...d.maintainerRepos, { repo, issues: false }] }]),
    ...(watched.some((x) => same(x, repo)) ? [] : [{ kind: "setting", key: "code_review", value: { ...d.codeReview, repos: [...watched, { repo }] } }]),
    { kind: "setting", key: "ship", value: (({ paused: _p, ...ship }) => ship)(value) },
  ];
  return { changes, summary: [`${repo}: added to ship (${listed ? "already listed" : "listed for the Maintainer"}, and code review), then ${summary[0]!.slice(repo.length + 2)}`] };
}

/** Takes a listed repo off ship, the Maintainer and code review in one change: no ship entry is left outside the scope. Only the owner's Fleet page calls it. */
export function removeRepo(d: { raw: Dict; scope: Scope; maintainerRepos: unknown[]; codeReview: Dict }, repo: string) {
  if (!covers(repo, d.scope) && Object.keys((d.raw.repos as Dict) ?? {}).some((k) => same(k, repo))) {
    // An orphan entry (its repo left the Maintainer): only the ship entry goes.
    const { paused: _p, ...ship } = structuredClone(d.raw);
    ship.repos = Object.fromEntries(Object.entries((ship.repos ?? {}) as Dict).filter(([k]) => !same(k, repo)));
    return { changes: [{ kind: "setting", key: "ship", value: ship }] as Dict[], summary: [`${repo}: its ship entry removed`] };
  }
  if (!d.scope.listed.some((x) => x.toLowerCase() === repo.toLowerCase()) || covers(repo, { fleet: d.scope.fleet, listed: [] })) throw new Error(`${repo} isn't a listed repo (a fleet repo stays covered)`);
  const { paused: _p, ...ship } = structuredClone(d.raw);
  const repos = (ship.repos ?? {}) as Dict;
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
      description: "Change ship's settings in one reviewed settings change on your task. { repo: owner/name or `defaults`, change: a preset name (cautious | full), a map of the fields to change (reset: [field or caps.x or safe.x to drop back to the preset], enabled, preset, handoff, rebase, generated { globs, command }, fix, protected, caps { … null = unlimited }, approve, safe, merge, stop_label, actions { conflict | behind | before_merge: [ { comment: /rebase } | { workflow: pr-rebase.yml, inputs? } ] }: the repo's own commands and workflows, before_merge workflows only, an ordinary change) or null to drop the entry } and/or { paused: true | false } for the kill switch (its own setting, ship_paused: it works whatever state the repo entries are in); { edits: { repos: { <repo>: change, … }, paused? } } applies several together (the Fleet page's pending edits); or { repo, add: true } (the owner's: lists a new repo for the Maintainer and code review and gives it its ship entry), or { repo, remove: true } (the owner's: it takes a listed repo off ship, the Maintainer and code review). A repo ship doesn't cover yet is the owner's to add from the Fleet page. Refused whole when the result wouldn't validate. A change that loosens anything (more handoff, a higher or removed cap, a wider approve or fix, a narrower protected list, clearing paused) is the owner's: it is refused here and the owner makes it from the Fleet page.",
      inputSchema: { type: "object", properties: { repo: { type: "string" }, change: {}, paused: { type: "boolean" }, add: { type: "boolean" }, remove: { type: "boolean" }, edits: { type: "object" } }, additionalProperties: false },
      run: async (a, caller) => {
        const raw = d.raw(), scope = d.scope(), owner = caller.kind === "owner";
        const repo = typeof a.repo === "string" ? a.repo : undefined;
        const hasEntry = (r: string) => Object.keys((raw.repos as Dict) ?? {}).some((k) => same(k, r));
        const notYours = (r: string) => `${r} isn't covered yet: adding a repo (its maintainer_repos, code_review and ship entries together) is the owner's: ask them to add it from the Fleet page`;
        let changes: Dict[], summary: string[], l: string[] = [];
        if (a.remove === true && repo) {
          if (!owner) throw new Error("removing a repo is the owner's: ask them to remove it from the Fleet page");
          ({ changes, summary } = removeRepo({ raw, scope, maintainerRepos: d.maintainerRepos(), codeReview: d.codeReview() }, repo));
        } else if (a.add === true && repo) {
          // One change across the github, code-review and ship settings: the board saves it for the owner; an agent's filing is per module, so an agent is refused.
          if (!owner) throw new Error(notYours(repo));
          if (typeof a.paused === "boolean") throw new Error("adding a repo is its own change: pause separately");
          if (hasEntry(repo)) throw new Error(`${repo} is already on ship: change it in the table`);
          ({ changes, summary } = addRepo({ raw, scope, maintainerRepos: d.maintainerRepos(), codeReview: d.codeReview() }, repo, a.change));
        } else {
          const edits = (a.edits as { repos?: Dict; paused?: boolean } | undefined) ?? { repos: repo ? { [repo]: a.change } : {}, paused: typeof a.paused === "boolean" ? a.paused : undefined };
          let value: Dict = raw;
          summary = [];
          for (const [r, change] of Object.entries(edits.repos ?? {})) {
            if (r !== "defaults" && change !== null && !hasEntry(r) && !covers(r, scope)) throw new Error(notYours(r));
            const x = applyShipChange(value, { repo: r, change, scope }); value = x.value; summary.push(...x.summary);
          }
          changes = [];
          // The repos' settings and the kill switch are separate settings: a repo proposal built before a pause can't clear it.
          if (summary.length) { const { paused: _p, ...ship } = value; changes.push({ kind: "setting", key: "ship", value: ship }); l = loosens(raw, value, scope); }
          if (typeof edits.paused === "boolean") {
            changes.push({ kind: "setting", key: "ship_paused", value: edits.paused }); summary.push(edits.paused ? "ship paused" : "ship resumed");
            if (!edits.paused) l.push("paused"); // resuming is the owner's, whatever state this service last saw
          }
          if (!changes.length) throw new Error("say what to change: a repo and its change, or paused");
        }
        // The owner's own call (the Fleet page) only proposes: the board shows it and files it on his Save.
        if (owner) return { changes: summary, _aidenhq: { settings_change: changes } };
        if (l.length) throw new Error(`that change loosens ${l.join(", ")}: the owner's to approve; ask them to make it from the Fleet page`);
        return { filed: await d.file(changes, caller.assertion ?? ""), changes: summary };
      },
    },
  ];
}
