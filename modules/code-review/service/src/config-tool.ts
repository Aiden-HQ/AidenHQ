// The Reviewer Manager's tools (role reviewer-manager), on the module's MCP connection: the config tool, how it reads and
// changes settings.code_review when the owner asks Aiden in words, plus a one-off review and the runs of a PR. The config tool ("watch acme/payments, and add a Claude Code review when a PR opens"). Served on the module's MCP connection; a change
// is one typed settings change the kernel writes to instance.yaml and files as a reviewed apply on the agent's own task
// (POST /v1/settings/agent with the call's caller assertion: kernel/src/settings-change.ts asAgent), the same write the board's
// Reviews page makes for the owner. The new value is checked whole here (config.ts) before it is filed: nothing half-valid lands.
import { combos, ENGINES, MOMENTS, readConfig, type Combo } from "./config.ts";

type Dict = Record<string, unknown>;
export interface Tool {
  name: string;
  description: string;
  inputSchema: object;
  /** Roles of which the caller must hold one. */
  roles?: string[];
  run: (args: Dict, caller: { agent: string; roles: string[]; assertion?: string; task?: string }) => Promise<unknown>;
}

const REPO = /^[\w.-]{1,100}\/[\w.-]{1,100}$/;

export interface Change {
  /** Repos to watch, or to change (their given fields replace those fields; the rest keep their values or defaults). */
  watch?: Dict[];
  /** Repos to stop watching. */
  unwatch?: string[];
}

/**
 * The setting after a change, from the setting as it is (the raw value in instance.yaml, defaults not merged in). Throws with
 * the owner-readable reason when the result wouldn't validate.
 */
export function applyChange(raw: Dict, ch: Change): { value: Dict; summary: string[] } {
  const value: Dict = { repos: [...((raw.repos as Dict[]) ?? [])] };
  let repos = value.repos as Dict[];
  const summary: string[] = [];
  const key = (r: unknown) => String(r).toLowerCase();
  for (const r of ch.unwatch ?? []) {
    if (!repos.some((x) => key(x.repo) === key(r))) throw new Error(`${r} isn't watched`);
    repos = repos.filter((x) => key(x.repo) !== key(r));
    summary.push(`stopped watching ${r}`);
  }
  for (const w of ch.watch ?? []) {
    if (typeof w?.repo !== "string" || !REPO.test(w.repo)) throw new Error("each watched repo is { repo: owner/name, … }");
    // Combos are stored whole as they run (module.yaml settings.code_review.owner reads them).
    for (const k of MOMENTS) if (w[k] !== undefined) {
      const c = combos(w[k], `${w.repo} ${k}`);
      if ("error" in c) throw new Error(c.error);
      // mandatory is written only where it is on: a combo saved without it stays as the owner wrote it.
      w[k] = c.map(({ mandatory, ...x }) => (mandatory ? { ...x, mandatory } : x));
    }
    const i = repos.findIndex((x) => key(x.repo) === key(w.repo));
    if (i >= 0) {
      repos[i] = { ...repos[i], ...w, repo: repos[i]!.repo };
      summary.push(`${w.repo} updated`);
    } else {
      repos.push(w);
      summary.push(`watch ${w.repo}`);
    }
  }
  value.repos = repos;
  if (!summary.length) throw new Error("say what to change: watch or unwatch");
  const checked = readConfig(JSON.stringify(value));
  if (checked.errors.length) throw new Error(`that setting wouldn't work: ${checked.errors.join("; ")}`);
  return { value, summary };
}

/**
 * The combos an agent may start a one-off with: an engine's offered model, or a combo a watched repo
 * already runs. Any other model is the owner's (as in settings: module.yaml settings.code_review.owner), set on
 * the board, whose one-off keeps full choice.
 */
const watchedCombos = (repos: () => unknown) => ((repos() as { repos?: { on_open?: unknown[]; on_push?: unknown[] }[] })?.repos ?? []).flatMap((r) => [...(r.on_open ?? []), ...(r.on_push ?? [])]) as Combo[];

/** A repo review's model for an agent: one an engine offers or a watched repo's combos already run; any other is the owner's, from the board. */
export function agentRepoModel(combo: unknown, repos: () => unknown) {
  const model = (combo as { model?: unknown } | undefined)?.model;
  if (combo === undefined || model === undefined) return;
  const offered = [...Object.values(ENGINES).flatMap((e) => e.models as readonly string[]), ...watchedCombos(repos).map((c) => c.model)];
  if (!offered.includes(String(model))) throw new Error(`${String(model).slice(0, 100)} is the owner's to choose: they start it from the board's Reviews page, or ask for a model an engine offers`);
}

export function agentCombos(raw: unknown, repos: () => unknown) {
  if (raw === undefined) return;
  const list = combos(raw, "combos");
  if ("error" in list) throw new Error(list.error);
  const watched = watchedCombos(repos);
  const same = (a: Combo, b: Combo) => a.engine === b.engine && a.model === b.model && a.effort === b.effort;
  for (const c of list) {
    const e = ENGINES[c.engine];
    if ((e.models as readonly string[]).includes(c.model) || watched.some((w) => same(w, c))) continue;
    throw new Error(`${c.engine} with ${c.model} is the owner's to choose: they start it from the board's Reviews page (Review again), or ask for one of ${c.engine}'s offered models (${e.models.join(", ")})`);
  }
}

const COMBOS = {
  type: "array", maxItems: 4,
  description: `Combos, each its own review run and post: { engine, model, effort, mandatory? (its review gates the repo's merges; keep it as it is) }. Engines: ${Object.entries(ENGINES).map(([e, v]) => `${e} (efforts ${v.efforts.join("|")}; models such as ${v.models.join(", ")})`).join("; ")}. Any model id OpenRouter lists may be typed. [] runs none.`,
  items: { type: "object", properties: { engine: { type: "string", enum: Object.keys(ENGINES) }, model: { type: "string" }, effort: { type: "string" }, mandatory: { type: "boolean" } }, required: ["engine", "model", "effort"], additionalProperties: false },
};
const REPO_ENTRY = {
  type: "object",
  properties: {
    repo: { type: "string", description: "owner/name" },
    on_open: { ...COMBOS, description: `when a PR opens (default codex, ~deepseek/deepseek-flash-latest, medium). ${COMBOS.description}` },
    on_push: { ...COMBOS, description: `on each push, only the new changes (default codex, ~deepseek/deepseek-flash-latest, low). ${COMBOS.description}` },
    drafts: { type: "boolean" },
    forks: { type: "string", enum: ["manual", "auto"] },
    ignore: { type: "array", items: { type: "string" } },
    max_nits: { type: "integer" },
  },
  required: ["repo"],
};

export function configTools(d: {
  /** settings.code_review as instance.yaml holds it (the module's defaults not merged in). */
  raw: () => Dict;
  /** The service's view: watched repos with today spend. */
  repos: () => unknown;
  /** POST /v1/settings/agent as the calling job (its assertion goes along). */
  file: (changes: Dict[], assertion: string) => Promise<unknown>;
  /** The service's own one-off review of a PR and repo review (POST /reviews), with the calling agent and its task (verified by the service) so a PR review's one summary reaches them. */
  oneoff: (body: Dict, asker: { requester: string; task?: string }) => Promise<unknown>;
  repoReview: (body: Dict) => Promise<unknown>;
  runs: (q: { repo?: string; limit?: number }) => unknown[];
  /** The engine's record of an agent's answer to a finding (no GitHub write). */
  resolve: (b: Dict) => unknown;
  /** A PR's open gating findings with ids. */
  findings: (repo: string, number: number) => unknown;
}): Tool[] {
  return [
    {
      name: "code_review_findings",
      description: "A pull request's open important findings that hold its merge, each with the id code_review_resolve takes: { repo: owner/name, number }. The merge's wait reason lists ids too, but cuts long lists. A `note` says when the latest recheck called a finding you claimed fixed still there.",
      inputSchema: { type: "object", properties: { repo: { type: "string" }, number: { type: "integer" } }, required: ["repo", "number"], additionalProperties: false },
      run: async (a) => {
        if (typeof a.repo !== "string" || !REPO.test(a.repo) || !Number.isInteger(a.number)) throw new Error("repo is owner/name and number an integer");
        return { findings: d.findings(a.repo, a.number as number) };
      },
    },
    {
      name: "code_review_resolve",
      description: "Close an open code review finding in code review's own store, with no GitHub write: { repo: owner/name, number, id (the finding's id: in the merge's wait reason, or `finding` on Aiden's thread in github_pr_threads), word: fixed | disputed | by design | won't fix, reason }. Say `fixed` only once the fix is published on the PR's branch, with what changed; `disputed` with why the finding is wrong (file:line). The next mandatory review reads your reason and reopens the finding only if it finds the fix or the reason unsafe. No role is needed beyond the grant; the call is recorded with your agent key.",
      inputSchema: { type: "object", properties: { repo: { type: "string" }, number: { type: "integer" }, id: { type: "string" }, word: { type: "string", enum: ["fixed", "disputed", "by design", "won't fix"] }, reason: { type: "string" } }, required: ["repo", "number", "id", "word", "reason"], additionalProperties: false },
      run: async (a, caller) => d.resolve({ ...a, by: `agent:${caller.agent}` }),
    },
    {
      name: "code_review_run",
      roles: ["reviewer-manager"],
      description: `Review now. A pull request: { pr_url, combos? (default the repo's on_open combos; several run side by side), focus?, full? (the whole PR, not only what changed since the last review) }, posted to it like a watched repo's review, one run and post per combo; each combo is an engine's offered model, or a combo a watched repo already runs (any other model is the owner's to start from the board); it posts as the owner, signed by AidenHQ. A whole repository at a commit (a repo review): { repo: owner/name, commit? (default: the default branch's head, resolved when it starts), options? (catalog option ids; default the recommended ones its stack fits), combo? { model, effort } for the model options }: its report lands in Primer, private to the owner, and on the board's Reviews page. Any repo the owner's GitHub sign-in can read.`,
      inputSchema: { type: "object", properties: { pr_url: { type: "string" }, combos: COMBOS, focus: { type: "string" }, full: { type: "boolean" },
        repo: { type: "string" }, commit: { type: "string" }, options: { type: "array", items: { type: "string" }, maxItems: 50 }, combo: { type: "object", properties: { model: { type: "string" }, effort: { type: "string" } }, additionalProperties: false } }, additionalProperties: false },
      run: async (a, caller) => {
        if (a.repo !== undefined) {
          if (a.pr_url !== undefined) throw new Error("give pr_url (a pull request) or repo (a whole repository), not both");
          agentRepoModel(a.combo, d.repos);
          return d.repoReview({ target: { repo: a.repo, ...(a.commit ? { commit: a.commit } : {}) }, ...(a.options ? { options: a.options } : {}), ...(a.combo ? { combo: a.combo } : {}) });
        }
        if (typeof a.pr_url !== "string") throw new Error("give pr_url (a pull request) or repo (a whole repository)");
        agentCombos(a.combos, d.repos);
        return d.oneoff({ pr_url: a.pr_url, ...(a.combos ? { combos: a.combos } : {}), ...(a.focus ? { focus: a.focus } : {}), ...(a.full ? { full: true } : {}) },
          { requester: caller.agent, ...(caller.task ? { task: caller.task } : {}) });
      },
    },
    {
      name: "code_review_runs",
      roles: ["reviewer-manager"],
      description: "A repo's review runs, newest first ({ repo: owner/name, number? }): engine, model, effort, kind, status and why, findings by severity, billed cost, tokens and duration. Each review's findings and their outcomes are on the board's Reviews page.",
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
      description: "What code review is set to: the watched repos (each moment's combos and today's spend), the engines a combo may name (efforts, offered models), and any problem with the setting.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      run: async () => ({ setting: d.raw(), problems: readConfig(JSON.stringify(d.raw())).errors, repos: d.repos(), engines: ENGINES }),
    },
    {
      name: "code_review_configure",
      roles: ["reviewer-manager"],
      description:
        "Change code review's setting in one reviewed settings change on your task (the kernel writes instance.yaml; the AI reviewer approves it; it applies within minutes). watch: repos to watch or change (defaults: on_open codex ~deepseek/deepseek-flash-latest medium, on_push the same at low, drafts off, forks when asked; on_open and on_push are lists of combos, given whole); unwatch: repos to stop watching. A deeper look at one PR is code_review_run with the combos wanted, never a setting. Spend is bounded by the install-wide spend limits in Settings, not by code review: the owner changes those there. Reviewing forks or drafts automatically, a repo in a new org, a change to a moment's combos (engine or model; adding one is more spend), or a repo's ignore globs is the owner's to approve. Refused whole when the result wouldn't validate.",
      inputSchema: {
        type: "object",
        properties: {
          watch: { type: "array", items: REPO_ENTRY },
          unwatch: { type: "array", items: { type: "string" } },
        },
        additionalProperties: false,
      },
      run: async (a, caller) => {
        const { value, summary } = applyChange(d.raw(), a as Change);
        return { filed: await d.file([{ kind: "setting", key: "code_review", value }], caller.assertion ?? ""), changes: summary };
      },
    },
  ];
}
