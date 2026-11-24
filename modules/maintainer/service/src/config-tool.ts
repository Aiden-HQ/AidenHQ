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

/** The list after a change: a repo's duties switched (it is listed when it wasn't), or the repo removed. Throws with the reason. */
export function applyRepoChange(list: Dict[], c: { repo: string; duties?: Dict; remove?: boolean }): { value: Dict[]; summary: string } {
  const at = list.findIndex((e) => String(e.repo).toLowerCase() === c.repo.toLowerCase());
  let value: Dict[], summary: string;
  if (c.remove) {
    if (at < 0) throw new Error(`${c.repo} isn't listed`);
    value = list.filter((_, i) => i !== at); summary = `${c.repo}: removed from the Maintainer`;
  } else {
    const duties = c.duties ?? {};
    for (const [k, v] of Object.entries(duties)) if (!(DUTIES as readonly string[]).includes(k) || typeof v !== "boolean") throw new Error(`duties: ${DUTIES.join(", ")} each true or false`);
    if (at < 0 && !Object.keys(duties).length) duties.issues = true;
    value = at < 0 ? [...list, { repo: c.repo, ...duties }] : list.map((e, i) => (i === at ? { ...e, ...duties } : e));
    summary = `${c.repo}: ${at < 0 ? "listed" : "duties"} ${Object.entries(duties).map(([k, v]) => `${k} ${v ? "on" : "off"}`).join(", ")}`;
  }
  parseRepos(JSON.stringify(value)); // the whole list checked as the github module will read it
  return { value, summary };
}

export function configTools(d: { repos: () => string; externalTriage: () => boolean }): Tool[] {
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
      description: "Propose one change to the Maintainer's setup: { repo, duties: { issues, features, dependabot, contributor_prs: true | false } } (lists the repo if it isn't), { repo, remove: true }, or { external_triage: true | false }. It returns the typed settings change; the owner saves it from the Fleet page.",
      inputSchema: { type: "object", properties: { repo: { type: "string" }, duties: { type: "object" }, remove: { type: "boolean" }, external_triage: { type: "boolean" } }, additionalProperties: false },
      run: async (a, who) => {
        ownerOnly(who.kind);
        if (typeof a.external_triage === "boolean") return { changes: [`external triage ${a.external_triage ? "on" : "off"}`], _aidenhq: { settings_change: [{ kind: "setting", key: "external_triage", value: a.external_triage }] } };
        if (typeof a.repo !== "string" || !/^[\w.-]{1,100}\/[\w.-]{1,100}$/.test(a.repo)) throw new Error("repo is owner/name");
        const { value, summary } = applyRepoChange(rawRepos(d.repos()), { repo: a.repo, duties: a.duties as Dict | undefined, remove: a.remove === true });
        return { changes: [summary], _aidenhq: { settings_change: [{ kind: "setting", key: "maintainer_repos", value }] } };
      },
    },
  ];
}
