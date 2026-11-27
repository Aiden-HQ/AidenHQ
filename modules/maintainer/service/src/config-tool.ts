// The Maintainer's settings tools, on the module's MCP connection `maintainer` (the Fleet page's, the owner's alone):
// `maintainer_config` reads each maintained repo's settings, `maintainer_configure` proposes one change.
// The change is the owner's own call: it comes back as a typed settings change for the board to show and file on his Save
// (structuredContent._aidenhq.settings_change), the same as ship's. Nothing is filed here.
import { ACTIONS, addListed, INACTIVE_GRACE_DAYS, TRIAGE, TRUST_ROLES, parseRepos } from "./aidenhq-sdk/maintained-repos.ts";
import type { Tool } from "./mcp.ts";

type Dict = Record<string, unknown>;
/** The entry fields the page edits (everything but `repo`, which `add` sets); parseRepos checks each value. */
export const FIELDS = ["fixes", "triage", "features", "actions", "no_reply_days", "inactive_issue_days", "fix_label", "trusted", "protected_labels"] as const;

/** maintainer_repos as the instance holds it: its entries, a bare "owner/name" or a map. */
export function rawRepos(text: string): Dict[] {
  const t = text.trim();
  const list: unknown = !t ? [] : t.startsWith("[") ? JSON.parse(t) : t.split(",").map((x) => x.trim());
  if (!Array.isArray(list)) throw new Error("maintainer_repos is not a list");
  return list.map((e) => (typeof e === "string" ? { repo: e } : { ...(e as Dict) }));
}

/** The list after field changes ({ repo: { field: value | null } }, null back to the default), a repo added (every default, addListed), or a repo removed. Only a listed repo changes. Throws with the reason. */
export function applyRepoChange(list: Dict[], c: { fields?: Record<string, Dict>; remove?: string; add?: string[] }): { value: Dict[]; summary: string[] } {
  let value = list;
  const at = (repo: string) => value.findIndex((e) => String(e.repo).toLowerCase() === repo.toLowerCase());
  const summary: string[] = [];
  for (const repo of c.add ?? []) { value = addListed(value, repo) as Dict[]; summary.push(`${repo}: added to the Maintainer`); }
  if (c.remove) {
    if (at(c.remove) < 0) throw new Error(`${c.remove} isn't listed`);
    value = value.filter((_, i) => i !== at(c.remove!)); summary.push(`${c.remove}: removed from the Maintainer`);
  }
  for (const [repo, fields] of Object.entries(c.fields ?? {})) {
    for (const k of Object.keys(fields)) if (!(FIELDS as readonly string[]).includes(k)) throw new Error(`fields: ${FIELDS.join(", ")}`);
    if (at(repo) < 0) throw new Error(`${repo} isn't listed: add it first`);
    value = value.map((e) => { if (String(e.repo).toLowerCase() !== repo.toLowerCase()) return e; const m: Dict = { ...e, ...fields }; for (const k of FIELDS) if (m[k] === null) delete m[k]; return m; });
    if (Object.keys(fields).length) summary.push(`${repo}: ${Object.entries(fields).map(([k, v]) => v === null ? `${k} back to default` : `${k} ${JSON.stringify(v)}`).join(", ")}`);
  }
  if (!c.fields && !c.remove && !c.add?.length) throw new Error("say what to change: fields, a repo to add or a repo to remove");
  if (!summary.length) summary.push("no changes");
  parseRepos(JSON.stringify(value)); // the whole list checked as the github module will read it
  return { value, summary };
}

/** What every field is when an entry says nothing, and the choices the page offers. */
export function defaults() {
  const { repo: _r, owner: _o, name: _n, ...base } = parseRepos("x/y")[0]!;
  return { base, triage: TRIAGE, actions: ACTIONS, roles: TRUST_ROLES, inactive_grace_days: INACTIVE_GRACE_DAYS };
}

export function configTools(d: { repos: () => string }): Tool[] {
  const ownerOnly = (kind?: string) => { if (kind !== "owner") throw new Error("the Maintainer's repos and settings are the owner's: they set them from the Fleet page"); };
  return [
    {
      name: "maintainer_config",
      description: "What the Maintainer does on each repo in maintainer_repos: the entry as the instance sets it (`set`), what applies (`effective`: fixes, triage, features, what each verdict does, no-reply and inactive-issue days, fix label, trusted roles, protected labels), and the defaults (`defaults`).",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      run: async (_a, who) => {
        ownerOnly(who.kind);
        const set = rawRepos(d.repos());
        return { repos: parseRepos(d.repos()).map(({ owner: _o, name: _n, ...effective }, i) => ({ repo: effective.repo, set: Object.fromEntries(Object.entries(set[i]!).filter(([k]) => k !== "repo")), effective })), defaults: defaults() };
      },
    },
    {
      name: "maintainer_configure",
      description: `Propose changes to the Maintainer's setup, as one typed settings change: { edits: { repos: { <repo>: { <field>: <value> | null } } } } (null puts a field back to its default; fields: ${FIELDS.join(", ")}), { add: [<owner/name>, …] } (lists new repos with the Maintainer's defaults), or { remove: <repo> } (off the Maintainer only: Ship and code review keep their own lists). Only listed repos change. The owner saves the change from the Fleet page.`,
      inputSchema: { type: "object", properties: { edits: { type: "object" }, add: { type: "array", items: { type: "string" } }, remove: { type: "string" } }, additionalProperties: false },
      run: async (a, who) => {
        ownerOnly(who.kind);
        const edits = (a.edits ?? {}) as { repos?: Record<string, Dict> };
        if (!edits.repos && typeof a.remove !== "string" && !Array.isArray(a.add)) throw new Error("say what to change");
        const r = applyRepoChange(rawRepos(d.repos()), { fields: edits.repos, remove: typeof a.remove === "string" ? a.remove : undefined, add: Array.isArray(a.add) ? a.add.map((x) => String(x).trim()) : undefined });
        return { changes: r.summary, _aidenhq: { settings_change: [{ kind: "setting", key: "maintainer_repos", value: r.value }] } };
      },
    },
  ];
}
