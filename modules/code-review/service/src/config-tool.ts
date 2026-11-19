// The Reviewer Manager's tools (role reviewer-manager), on the module's MCP connection: the config tool, how it reads and
// changes settings.code_review when the owner asks Aiden in words, plus a one-off review and the runs of a PR. The config tool ("watch acme/payments, deep for anything under src/billing"). Served on the module's MCP connection; a change
// is one typed settings change the kernel writes to instance.yaml and files as a reviewed apply on the agent's own task
// (POST /v1/settings/agent with the call's caller assertion: kernel/src/settings-change.ts asAgent), the same write the board's
// Reviews page makes for the owner. The new value is checked whole here (config.ts) before it is filed: nothing half-valid lands.
import { DEFAULT_REVIEWERS, profile, readConfig } from "./config.ts";

type Dict = Record<string, unknown>;
export interface Tool {
  name: string;
  description: string;
  inputSchema: object;
  /** Roles of which the caller must hold one. */
  roles?: string[];
  run: (args: Dict, caller: { agent: string; roles: string[]; assertion?: string }) => Promise<unknown>;
}

/** The github module's setting listing the orgs owner-identity writes may reach (github-mcp's GITHUB_COMMENT_ORGS). */
export const COMMENT_ORGS = "github_comment_orgs";
const REPO = /^[\w.-]{1,100}\/[\w.-]{1,100}$/;
const ORG = /^[A-Za-z0-9][\w.-]{0,38}$/;

export interface Change {
  /** Repos to watch, or to change (their given fields replace those fields; the rest keep their values or defaults). */
  watch?: Dict[];
  /** Repos to stop watching. */
  unwatch?: string[];
  /** Reviewers to add or replace (a whole profile), or null to remove one (a shipped default is switched off). */
  reviewers?: Record<string, Dict | null>;
  /** The monthly cap across repos, USD. */
  month_usd?: number;
}

/**
 * The setting after a change, from the setting as it is (the raw value in instance.yaml, defaults not merged in), plus the
 * orgs a newly watched repo needs added to settings.github_comment_orgs. Throws with the owner-readable reason when the result
 * wouldn't validate.
 */
export function applyChange(raw: Dict, ch: Change, orgs: string[]): { value: Dict; addOrgs: string[]; summary: string[] } {
  const value: Dict = { reviewers: { ...((raw.reviewers as Dict) ?? {}) }, repos: [...((raw.repos as Dict[]) ?? [])], month_usd: raw.month_usd ?? 200 };
  const reviewers = value.reviewers as Dict;
  let repos = value.repos as Dict[];
  const summary: string[] = [];
  const key = (r: unknown) => String(r).toLowerCase();
  for (const [name, p] of Object.entries(ch.reviewers ?? {})) {
    if (p === null) {
      if (Object.hasOwn(DEFAULT_REVIEWERS, name)) reviewers[name] = null;
      else delete reviewers[name];
      summary.push(`removed reviewer ${name}`);
    } else {
      // Stored whole as it runs (run_usd filled in), so the kernel sees every reviewer's cost (module.yaml settings.code_review.owner).
      const v = profile(p);
      if ("error" in v) throw new Error(`reviewers.${name}: ${v.error}`);
      reviewers[name] = v;
      summary.push(`reviewer ${name} set`);
    }
  }
  for (const r of ch.unwatch ?? []) {
    if (!repos.some((x) => key(x.repo) === key(r))) throw new Error(`${r} isn't watched`);
    repos = repos.filter((x) => key(x.repo) !== key(r));
    summary.push(`stopped watching ${r}`);
  }
  const addOrgs: string[] = [];
  for (const w of ch.watch ?? []) {
    if (typeof w?.repo !== "string" || !REPO.test(w.repo)) throw new Error("each watched repo is { repo: owner/name, … }");
    const i = repos.findIndex((x) => key(x.repo) === key(w.repo));
    if (i >= 0) {
      repos[i] = { ...repos[i], ...w, repo: repos[i]!.repo };
      summary.push(`${w.repo} updated`);
    } else {
      repos.push(w);
      summary.push(`watch ${w.repo}`);
      const org = key(w.repo).split("/")[0]!;
      if (!orgs.includes(org) && !addOrgs.includes(org)) addOrgs.push(org);
    }
  }
  value.repos = repos;
  if (ch.month_usd !== undefined) {
    value.month_usd = ch.month_usd;
    summary.push(`monthly cap $${ch.month_usd}`);
  }
  if (!summary.length) throw new Error("say what to change: watch, unwatch, reviewers or month_usd");
  const checked = readConfig(JSON.stringify(value));
  if (checked.errors.length) throw new Error(`that setting wouldn't work: ${checked.errors.join("; ")}`);
  // A repo whose trigger names a reviewer that is gone isn't silently dropped: readConfig lists it above.
  for (const o of addOrgs) if (!ORG.test(o)) throw new Error(`${o} isn't a GitHub org name`);
  if (addOrgs.length) summary.push(`reviews can post as the owner in ${addOrgs.join(", ")} only once the owner allows that org (the board's Reviews page; or the GitHub App installed there)`);
  return { value, addOrgs, summary };
}

const PROFILE = {
  type: "object",
  description: "A whole reviewer profile: engine (codex; claude-code and codegenie are refused until built), model (an OpenRouter id like ~deepseek/deepseek-flash-latest), effort (low|medium|high|xhigh|max), finders (1-8), verify, and optionally verifier (a model), context (repo paths read from the base branch), focus, label, run_usd.",
};
const REPO_ENTRY = {
  type: "object",
  properties: {
    repo: { type: "string", description: "owner/name" },
    on_open: { type: "string", description: "the reviewer when a PR opens (default standard), or off" },
    on_push: { type: "string", description: "the reviewer on each push, incremental (default quick), or off" },
    on_risk: { type: "string", description: "the reviewer a high-risk PR escalates to (default deep), or off" },
    drafts: { type: "boolean" },
    forks: { type: "string", enum: ["manual", "auto"] },
    month_usd: { type: "number" },
    ignore: { type: "array", items: { type: "string" } },
    max_nits: { type: "integer" },
  },
  required: ["repo"],
};

export function configTools(d: {
  /** settings.code_review as instance.yaml holds it (the module's defaults not merged in). */
  raw: () => Dict;
  /** settings.github_comment_orgs, lowercased. */
  orgs: () => string[];
  /** The service's views: watched repos with month spend, reviewers with their average cost per run. */
  repos: () => unknown;
  reviewers: () => unknown;
  /** POST /v1/settings/agent as the calling job (its assertion goes along). */
  file: (changes: Dict[], assertion: string) => Promise<unknown>;
  /** The service's own one-off review (POST /reviews) and its runs (GET /reviews). */
  oneoff: (body: Dict) => Promise<unknown>;
  runs: (q: { repo?: string; limit?: number }) => unknown[];
}): Tool[] {
  return [
    {
      name: "code_review_run",
      roles: ["reviewer-manager"],
      description: "Review one pull request now, posted to it like a watched repo's review: { pr_url, reviewer? (default standard), focus?, full? (the whole PR, not only what changed since the last review) }. Any PR the instance's GitHub sign-in can read; a repo outside the GitHub orgs reviews may post in as the owner is refused with what to do.",
      inputSchema: { type: "object", properties: { pr_url: { type: "string" }, reviewer: { type: "string" }, focus: { type: "string" }, full: { type: "boolean" } }, required: ["pr_url"], additionalProperties: false },
      // The service refuses a PR its review couldn't post on (no App there, and an org the owner hasn't allowed): named back.
      run: async (a) => d.oneoff({ pr_url: a.pr_url, ...(a.reviewer ? { reviewer: a.reviewer } : {}), ...(a.focus ? { focus: a.focus } : {}), ...(a.full ? { full: true } : {}) })
        .catch((e: Error & { extra?: { owner_must_allow_orgs?: string[] } }) => { if (e.extra?.owner_must_allow_orgs) return { refused: e.message, owner_must_allow_orgs: e.extra.owner_must_allow_orgs }; throw e; }),
    },
    {
      name: "code_review_runs",
      roles: ["reviewer-manager"],
      description: "A repo's review runs, newest first ({ repo: owner/name, number? }): reviewer, kind, status and why, findings by severity, cost. Each review's findings are on the board's Reviews page.",
      inputSchema: { type: "object", properties: { repo: { type: "string" }, number: { type: "integer" } }, required: ["repo"], additionalProperties: false },
      run: async (a) => {
        if (typeof a.repo !== "string" || !REPO.test(a.repo)) throw new Error("repo is owner/name");
        const all = d.runs({ repo: a.repo.toLowerCase(), limit: 100 }) as { number?: number }[];
        return { runs: a.number ? all.filter((r) => r.number === a.number) : all.slice(0, 30) };
      },
    },
    {
      name: "code_review_config",
      roles: ["reviewer-manager"],
      description: "What code review is set to: the watched repos (triggers, caps, this month's spend), the reviewers (each profile with its average cost per run), the monthly cap across repos, the GitHub orgs reviews may post in as the owner, and any problem with the setting.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      run: async () => ({ setting: d.raw(), problems: readConfig(JSON.stringify(d.raw())).errors, repos: d.repos(), reviewers: d.reviewers(), comment_orgs: d.orgs() }),
    },
    {
      name: "code_review_configure",
      roles: ["reviewer-manager"],
      description:
        "Change code review's setting in one reviewed settings change on your task (the kernel writes instance.yaml; the AI reviewer approves it; it applies within minutes). watch: repos to watch or change (defaults: standard on open, quick on push, deep on high risk, drafts off, forks when asked, $50 a month); unwatch: repos to stop watching; reviewers: { name: profile } to add or replace, { name: null } to remove; month_usd: the cap across repos. A repo in an org reviews can't yet post in as the owner is named back (owner_must_allow_orgs): tell the owner to allow it on the board's Reviews page. Raising spend, reviewing forks or drafts automatically, a repo in a new org, a reviewer's model, finders, run_usd, focus or context, or a repo's ignore globs is the owner's to approve. Refused whole when the result wouldn't validate.",
      inputSchema: {
        type: "object",
        properties: {
          watch: { type: "array", items: REPO_ENTRY },
          unwatch: { type: "array", items: { type: "string" } },
          reviewers: { type: "object", additionalProperties: { anyOf: [PROFILE, { type: "null" }] } },
          month_usd: { type: "number" },
        },
        additionalProperties: false,
      },
      run: async (a, caller) => {
        // Only code_review: the orgs owner-identity reviews may reach are the github module's setting, the owner's to change.
        const { value, addOrgs, summary } = applyChange(d.raw(), a as Change, d.orgs());
        return { filed: await d.file([{ kind: "setting", key: "code_review", value }], caller.assertion ?? ""), changes: summary, ...(addOrgs.length ? { owner_must_allow_orgs: addOrgs } : {}) };
      },
    },
  ];
}
