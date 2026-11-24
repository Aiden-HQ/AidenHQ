// The Maintainer's settings tools, on the module's MCP connection `maintainer` (the Fleet page's, the owner's alone):
// `maintainer_config` reads the maintained repos with their duties and the triage switch, `maintainer_configure` proposes one change.
// The change is the owner's own call: it comes back as a typed settings change for the board to show and file on his Save
// (structuredContent._aidenhq.settings_change), the same as ship's. Nothing is filed here.
import { parseRepos } from "./aidenhq-sdk/maintained-repos.ts";
import type { Tool } from "./mcp.ts";

type Dict = Record<string, unknown>;
export const DUTIES = ["issues", "features", "dependabot", "contributor_prs"] as const;

/** maintainer_repos as the instance holds it: its entries, a bare "owner/name" or a map. */
export function rawRepos(text: string): Dict[] {
  const t = text.trim();
  const list: unknown = !t ? [] : t.startsWith("[") ? JSON.parse(t) : t.split(",").map((x) => x.trim());
  if (!Array.isArray(list)) throw new Error("maintainer_repos is not a list");
  return list.map((e) => (typeof e === "string" ? { repo: e } : { ...(e as Dict) }));
}

/** The list after duty changes ({ repo: { duty: true | false } }), or a repo removed. Only a listed repo changes: adding is the Ship page's one change. Throws with the reason. */
export function applyRepoChange(list: Dict[], c: { duties?: Record<string, Dict>; remove?: string }): { value: Dict[]; summary: string[] } {
  const at = (repo: string) => list.findIndex((e) => String(e.repo).toLowerCase() === repo.toLowerCase());
  let value = list;
  const summary: string[] = [];
  if (c.remove) {
    if (at(c.remove) < 0) throw new Error(`${c.remove} isn't listed`);
    value = list.filter((_, i) => i !== at(c.remove!)); summary.push(`${c.remove}: removed from the Maintainer`);
  }
  for (const [repo, duties] of Object.entries(c.duties ?? {})) {
    for (const [k, v] of Object.entries(duties)) if (!(DUTIES as readonly string[]).includes(k) || typeof v !== "boolean") throw new Error(`duties: ${DUTIES.join(", ")} each true or false`);
    if (at(repo) < 0) throw new Error(`${repo} isn't listed: add it from the Ship page`);
    value = value.map((e) => (String(e.repo).toLowerCase() === repo.toLowerCase() ? { ...e, ...duties } : e));
    summary.push(`${repo}: ${Object.entries(duties).map(([k, v]) => `${k} ${v ? "on" : "off"}`).join(", ")}`);
  }
  if (!summary.length) throw new Error("say what to change: duties, or a repo to remove");
  parseRepos(JSON.stringify(value)); // the whole list checked as the github module will read it
  return { value, summary };
}

export function configTools(d: { repos: () => string; ship: () => boolean; externalTriage: () => boolean }): Tool[] {
  const ownerOnly = (kind?: string) => { if (kind !== "owner") throw new Error("the Maintainer's repos and duties are the owner's: they set them from the Fleet page"); };
  return [
    {
      name: "maintainer_config",
      description: "What the Maintainer watches: each repo in maintainer_repos with its duties (issues, features, dependabot, contributor_prs), label, trusted roles and quiet days, and whether unlabelled issues are triaged (external_triage).",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      run: async (_a, who) => { ownerOnly(who.kind); return { repos: parseRepos(d.repos()).map(({ owner: _o, name: _n, ...r }) => r), external_triage: d.externalTriage() }; },
    },
    {
      name: "maintainer_configure",
      description: "Propose changes to the Maintainer's setup, as one typed settings change: { edits: { repos: { <repo>: { issues, features, dependabot, contributor_prs: true | false } }, external_triage?: true | false } }, or { remove: <repo> } (a repo Ship also covers is removed from the Ship page, which clears both). Only listed repos change: adding one is the Ship page's. The owner saves the change from the Fleet page.",
      inputSchema: { type: "object", properties: { edits: { type: "object" }, remove: { type: "string" } }, additionalProperties: false },
      run: async (a, who) => {
        ownerOnly(who.kind);
        const edits = (a.edits ?? {}) as { repos?: Record<string, Dict>; external_triage?: boolean };
        const changes: Dict[] = [];
        const summary: string[] = [];
        if (typeof edits.external_triage === "boolean") { changes.push({ kind: "setting", key: "external_triage", value: edits.external_triage }); summary.push(`external triage ${edits.external_triage ? "on" : "off"}`); }
        if (typeof a.remove === "string" && d.ship()) throw new Error(`${a.remove}: with Ship on, remove a repo from the Ship page: it clears the Maintainer, code review and ship entries together`);
        if (edits.repos || typeof a.remove === "string") {
          const r = applyRepoChange(rawRepos(d.repos()), { duties: edits.repos, remove: typeof a.remove === "string" ? a.remove : undefined });
          changes.push({ kind: "setting", key: "maintainer_repos", value: r.value }); summary.push(...r.summary);
        }
        if (!changes.length) throw new Error("say what to change");
        return { changes: summary, _aidenhq: { settings_change: changes } };
      },
    },
  ];
}
