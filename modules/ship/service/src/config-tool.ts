// Ship's config tools (role ship-admin), on the module's MCP connection `ship`: `ship_config` reads the effective settings per
// repo, `ship_configure` changes one repo's entry. Built like code-review's: the change is applied to the raw value, the whole
// result validated, and one typed settings change filed as the calling job (POST /v1/settings/agent).
// A change that loosens anything (loosens()) is the owner's: the tool refuses it and the owner makes it from the board.
import { CAP_KEYS, CONTROLS, effective, inFleet, FIELDS, loosens, PRESETS, removable, TIERS, validate, type Scope } from "./settings.ts";
import { status } from "./status.ts";
import type { State } from "./state.ts";
import type { Tool } from "./mcp.ts";

type Dict = Record<string, unknown>;
/** What a change's `reset` may name: a field (not the preset), a cap, a tier's approve or merge, or the unwatched merge. */
const RESETTABLE = new Set([...FIELDS.filter((k) => !["preset", "caps", "by_tier", "unwatched"].includes(k)), ...CAP_KEYS.map((k) => `caps.${k}`),
  ...TIERS.flatMap((t) => (t === "skip" ? [`by_tier.${t}.merge`] : [`by_tier.${t}.approve`, `by_tier.${t}.merge`])), "unwatched.merge"]);
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
    // caps, unwatched and each tier of by_tier merge field by field: lowering one cap, or one tier's merge, keeps the others.
    const obj = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? (v as Dict) : undefined);
    const entry: Dict = { ...base, ...ch, ...Object.fromEntries(["caps", "unwatched"].filter((k) => obj(ch[k])).map((k) => [k, { ...obj((base as Dict)[k]), ...obj(ch[k]) }])) };
    if (obj(ch.by_tier)) entry.by_tier = Object.fromEntries([...new Set([...Object.keys(obj((base as Dict).by_tier) ?? {}), ...Object.keys(obj(ch.by_tier)!)])].map((t) => [t, (obj(ch.by_tier)![t] !== undefined && !obj(obj(ch.by_tier)![t]) ? obj(ch.by_tier)![t] : { ...obj(obj((base as Dict).by_tier)?.[t]), ...obj(obj(ch.by_tier)![t]) })]));
    // `reset: ["caps.usd", "by_tier.trivial.approve"]` drops those fields from the entry, so the preset's value applies again.
    if (reset !== undefined && !Array.isArray(reset)) throw new Error("reset is a list of fields, such as [\"caps.usd\", \"by_tier.trivial.approve\"]");
    for (const p of reset ?? []) {
      if (!RESETTABLE.has(String(p))) throw new Error(`can't reset ${String(p).slice(0, 40)} (one of ${[...RESETTABLE].join(", ")})`);
      // A path of one to three parts (`caps.usd`, `by_tier.trivial.approve`): the leaf goes, and a map it leaves empty goes with it.
      const drop = (m: Dict, path: string[]): Dict | undefined => {
        const [k, ...rest] = path;
        if (rest.length) { const sub = obj(m[k]); if (!sub) return m; const left = drop({ ...sub }, rest); const out = { ...m }; if (left && Object.keys(left).length) out[k] = left; else delete out[k]; return out; }
        const out = { ...m }; delete out[k]; return out;
      };
      const left = drop(entry, String(p).split(".")) ?? {};
      for (const k of Object.keys(entry)) delete entry[k];
      Object.assign(entry, left);
    }
    next = entry;
    summary = `${c.repo}: ${[...Object.keys(ch), ...(Array.isArray(reset) && reset.length ? [`reset ${reset.join(", ")}`] : [])].join(", ")} changed`;
  } else throw new Error("change is a preset name, a map of fields, or null");
  const target = isDefaults ? value : repos;
  const slot = isDefaults ? "defaults" : key;
  if (next === undefined) delete target[slot]; else target[slot] = next;
  const errors = validate(value);
  if (errors.length) throw new Error(`that setting wouldn't work: ${errors.join("; ")}`);
  return { value, summary: [summary], loosens: loosens(raw, value, c.scope) };
}

const REPO = /^[\w.-]{1,100}\/[\w.-]{1,100}$/;
const same = (a: unknown, b: string) => String(typeof a === "string" ? a : (a as Dict)?.repo).toLowerCase() === b.toLowerCase();

/**
 * Adds a repo to Ship: its entry in ship.repos, Ship's own list, and nothing else (the Maintainer and code review keep their own
 * lists). Only the owner's Fleet page calls it. No `change` is an empty entry: it inherits the defaults and follows their later changes.
 */
export function addRepo(d: { raw: Dict }, repo: string, change: unknown) {
  if (!REPO.test(repo)) throw new Error(`${repo.slice(0, 100)} isn't owner/name`);
  const { value, summary } = applyShipChange(d.raw, { repo, change: change ?? {}, scope: { fleet: [] } });
  return { changes: [{ kind: "setting", key: "ship", value: (({ paused: _p, ...ship }) => ship)(value) }] as Dict[], summary: [`${repo}: added to Ship, then ${summary[0]!.slice(repo.length + 2)}`] };
}

/** Takes a repo off Ship: its entry goes, and nothing else (the Maintainer and code review keep their own lists). Only the owner's Fleet page calls it. */
export function removeRepo(d: { raw: Dict; scope: Scope }, repo: string) {
  const hasEntry = Object.keys((d.raw.repos as Dict) ?? {}).some((k) => same(k, repo));
  if (!removable(repo, d.scope, hasEntry)) throw new Error(`${repo} has no entry of its own to remove (a fleet repo stays covered)`);
  const { paused: _p, ...ship } = structuredClone(d.raw);
  ship.repos = Object.fromEntries(Object.entries((ship.repos ?? {}) as Dict).filter(([k]) => !same(k, repo)));
  return { changes: [{ kind: "setting", key: "ship", value: ship }] as Dict[], summary: [`${repo}: removed from Ship`] };
}

export function configTools(d: {
  raw: () => Dict; scope: () => Scope; state: State;
  /** POST /v1/settings/agent as the calling job (its assertion goes along). */
  file: (changes: Dict[], assertion: string) => Promise<unknown>;
}): Tool[] {
  return [
    {
      name: "ship_config", roles: ["ship-admin"],
      description: "What ship is set to: the raw setting, its problems, the presets, the scope (the fleet's own repos) and the effective settings of each repo with an entry.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      run: async () => {
        const raw = d.raw(), scope = d.scope();
        const repos = Object.keys((raw.repos as Dict) ?? {}).map((r) => [r, effective(raw, r, scope)]);
        return { setting: raw, problems: validate(raw), scope, presets: PRESETS, controls: CONTROLS, defaults: effective(raw, "*/*", { fleet: ["*/*"] }), repos: Object.fromEntries(repos) };
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
      description: "Change ship's settings in one reviewed settings change on your task. { repo: owner/name or `defaults`, change: a preset name (cautious | full), a map of the fields to change (reset: [field, caps.x, by_tier.<tier>.approve or merge, or unwatched.merge to drop back to the preset], enabled, preset, handoff, rebase, generated { globs, command }, fix, protected, caps { … null = unlimited }, approve, safe, merge, stop_label, actions { conflict | behind | before_merge: [ { comment: /rebase } | { workflow: pr-rebase.yml, inputs? } ] }: the repo's own commands and workflows, before_merge workflows only, an ordinary change) or null to drop the entry } and/or { paused: true | false } for the kill switch (its own setting, ship_paused: it works whatever state the repo entries are in); { edits: { repos: { <repo>: change, … }, paused? } } applies several together (the Fleet page's pending edits); or { repo, add: true } (the owner's: gives a new repo its ship entry; the Maintainer and code review keep their own lists), or { repo, remove: true } (the owner's: drops the repo's ship entry, nothing else). A repo ship doesn't cover yet is the owner's to add from the Fleet page. Refused whole when the result wouldn't validate. A change that loosens anything (more handoff, a higher or removed cap, a tier's approve or merge raised, a wider fix, a narrower protected list, clearing paused) is the owner's: it is refused here and the owner makes it from the Fleet page.",
      inputSchema: { type: "object", properties: { repo: { type: "string" }, change: {}, paused: { type: "boolean" }, add: { type: "boolean" }, remove: { type: "boolean" }, edits: { type: "object" } }, additionalProperties: false },
      run: async (a, caller) => {
        const raw = d.raw(), scope = d.scope(), owner = caller.kind === "owner";
        const repo = typeof a.repo === "string" ? a.repo : undefined;
        const hasEntry = (r: string) => Object.keys((raw.repos as Dict) ?? {}).some((k) => same(k, r));
        const notYours = (r: string) => `${r} isn't on Ship yet: adding a repo is the owner's: ask them to add it from the Fleet page`;
        let changes: Dict[], summary: string[], l: string[] = [];
        if (a.remove === true && repo) {
          if (!owner) throw new Error("removing a repo is the owner's: ask them to remove it from the Fleet page");
          ({ changes, summary } = removeRepo({ raw, scope }, repo));
        } else if (a.add === true && repo) {
          if (!owner) throw new Error(notYours(repo));
          if (typeof a.paused === "boolean") throw new Error("adding a repo is its own change: pause separately");
          if (hasEntry(repo)) throw new Error(`${repo} is already on ship: change it in the table`);
          ({ changes, summary } = addRepo({ raw }, repo, a.change));
        } else {
          const edits = (a.edits as { repos?: Dict; paused?: boolean } | undefined) ?? { repos: repo ? { [repo]: a.change } : {}, paused: typeof a.paused === "boolean" ? a.paused : undefined };
          let value: Dict = raw;
          summary = [];
          for (const [r, change] of Object.entries(edits.repos ?? {})) {
            if (r !== "defaults" && change !== null && !hasEntry(r) && !inFleet(r, scope)) throw new Error(notYours(r));
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
