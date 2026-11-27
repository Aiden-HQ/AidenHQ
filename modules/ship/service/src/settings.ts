// Ship's per-repo settings (the one `ship` setting): presets, the effective settings of a repo, validation, and what a change
// loosens. Every knob is a per-repo setting with no floor in code; `null` caps are unlimited (owner, 2026-11-24).
type Dict = Record<string, unknown>;

export const CAP_KEYS = ["wakes_per_head", "ci_rounds", "same_check_heads", "rounds", "usd", "requeue_on_timeout"] as const;
export type Caps = Record<(typeof CAP_KEYS)[number], number | null>;
export const HANDOFF = ["none", "label", "all"] as const;
export const REBASE = ["conflict", "behind"] as const;
export const APPROVE = ["off", "observe", "on"] as const;
/** The risk tiers code review classifies each PR head into (kernel/sdk/src/tiers.ts): ship's approve and merge are set per tier. */
export const TIERS = ["skip", "trivial", "standard", "sensitive"] as const;
export type Tier = (typeof TIERS)[number];
export const MERGE = ["off", "ready"] as const;
export const FIX = ["conflicts", "ci", "review"] as const;
/** The stages a repo's own workflows run at (actions.ts): before ship's repair of a conflict, before it brings a branch up to
 * date, and before it merges. */
export const STAGES = ["conflict", "behind", "before_merge"] as const;
/** One step of a stage: one of the repo's workflows, dispatched on the PR's base branch; an input value's `{pr}` is the PR's number
 * (how the workflow knows which PR). */
export type ActionStep = { workflow: string; inputs?: Record<string, string> };

export interface ShipSettings {
  /** Whether ship adopts and works this repo's PRs (the Fleet page's Enabled switch). */
  enabled: boolean;
  handoff: (typeof HANDOFF)[number];
  rebase: (typeof REBASE)[number];
  /** `command: null`: the repo's own CI regenerates these paths (the repair takes the base side and runs no generator for them). */
  generated: { globs: string[]; command: string | null } | null;
  fix: (typeof FIX)[number][];
  protected: string[];
  caps: Caps;
  /** Per risk tier: whether the App approves (`skip` has no review to approve on, so its approve is always off) and whether ship merges. */
  by_tier: Record<Tier, { approve: (typeof APPROVE)[number]; merge: (typeof MERGE)[number] }>;
  /** A repo code review doesn't watch has no tier: this is its merge. */
  unwatched: { merge: (typeof MERGE)[number] };
  stop_label: string;
  /** Automation accounts (GitHub logins, any case) whose comments ship never treats as a member's request (member-comments.ts). */
  ignore_authors: string[];
  /** The repo's own commands and workflows per stage (actions.ts). An ordinary setting: they are the repo's own CI. */
  actions: Partial<Record<(typeof STAGES)[number], ActionStep[]>>;
}

// Protected paths bind the model's fixes only: the deterministic repair may regenerate lockfiles.
const PROTECTED = ["**/package-lock.json", "**/pnpm-lock.yaml", "**/yarn.lock", ".github/**", "**/.eslintrc*", "**/eslint.config.*", "**/vitest.config.*", "**/jest.config.*", "**/tsconfig*.json", "**/CODEOWNERS"];

const CAUTIOUS: ShipSettings = {
  enabled: true, handoff: "label", rebase: "conflict", generated: null, fix: ["conflicts", "ci", "review"], protected: PROTECTED,
  caps: { wakes_per_head: 3, ci_rounds: 3, same_check_heads: 2, rounds: 30, usd: 5, requeue_on_timeout: 1 },
  by_tier: { skip: { approve: "off", merge: "ready" }, trivial: { approve: "on", merge: "ready" }, standard: { approve: "observe", merge: "ready" }, sensitive: { approve: "off", merge: "ready" } },
  unwatched: { merge: "ready" }, stop_label: "ship:stop", ignore_authors: [], actions: {},
};
const FULL: ShipSettings = {
  // Unguarded at ship's own policy layer. Host rules, human code-owner reviews and kernel authority still apply.
  ...CAUTIOUS, handoff: "all", protected: [],
  by_tier: { skip: { approve: "off", merge: "ready" }, trivial: { approve: "on", merge: "ready" }, standard: { approve: "on", merge: "ready" }, sensitive: { approve: "on", merge: "ready" } },
  caps: Object.fromEntries(CAP_KEYS.map((k) => [k, null])) as Caps,
};
/** The Fleet page's controls (per repo, and the global pause) and the declared setting each one edits (the same fields the English tool and validate use). */
export const CONTROLS = {
  enabled: { setting: "enabled", scope: "repo", values: [true, false], label: "On or off" },
  preset: { setting: "preset", scope: "repo", values: ["cautious", "full"], label: "Preset" },
  handoff: { setting: "handoff", scope: "repo", values: HANDOFF, label: "Which PRs to adopt" },
  paused: { setting: "paused", scope: "global", values: [true, false], label: "Pause everything" },
} as const;
export const PRESETS: Record<"cautious" | "full", ShipSettings> = { cautious: CAUTIOUS, full: FULL };
const clone = <T>(v: T): T => structuredClone(v);

const isMap = (v: unknown): v is Dict => !!v && typeof v === "object" && !Array.isArray(v);
export const FIELDS = ["preset", "enabled", "handoff", "rebase", "generated", "fix", "protected", "caps", "by_tier", "unwatched", "stop_label", "ignore_authors", "actions"];
const REPO = /^[\w.-]{1,100}\/[\w.-]{1,100}$/;

/** Where ship works: the fleet's own repos (the agents org as `org/*`, the product repo), always; a `maintainer_repos` repo only
 * once it has a ship entry (quiet until enabled). A wildcard owner and name matches all. */
export interface Scope { fleet: string[]; listed: string[] }
const match = (repo: string, list: string[]) => list.some((c) => { const [a, b] = c.toLowerCase().split("/"); const [r, n] = repo.toLowerCase().split("/"); return (a === "*" || a === r) && (b === "*" || b === n); });
const ALL: Scope = { fleet: ["*/*"], listed: [] };
/** Whether ship works the repo: a fleet repo, or a listed one (its ship entry is what turns a listed repo on). */
export const covers = (repo: string, scope: Scope) => match(repo, scope.fleet) || match(repo, scope.listed);
/** Whether removing the repo is allowed (removeRepo's rule, and the Fleet page's Remove button): a listed repo the fleet doesn't cover by itself, or an orphan entry. */
export const removable = (repo: string, scope: Scope, hasEntry: boolean) =>
  (!covers(repo, scope) && hasEntry) || (scope.listed.some((x) => x.toLowerCase() === repo.toLowerCase()) && !covers(repo, { fleet: scope.fleet, listed: [] }));

/** The entry as a preset name plus overrides: `"full"`, `{ preset, ...fields }` or `{ ...fields }` over `base`. */
function entryOf(e: unknown, base: "cautious" | "full"): { preset: "cautious" | "full"; over: Dict } {
  if (typeof e === "string") return { preset: e as "cautious" | "full", over: {} };
  if (isMap(e)) { const { preset, ...over } = e; return { preset: (preset as "cautious" | "full") ?? base, over }; }
  return { preset: base, over: {} };
}
function resolve(preset: "cautious" | "full", over: Dict): ShipSettings {
  const s = clone(PRESETS[preset]) as ShipSettings & Dict;
  for (const [k, v] of Object.entries(over)) {
    if (k === "caps" && isMap(v)) s.caps = { ...s.caps, ...(v as Partial<Caps>) };
    else if (k === "by_tier" && isMap(v)) for (const t of TIERS) s.by_tier[t] = { ...s.by_tier[t], ...(isMap(v[t]) ? v[t] : {}) } as ShipSettings["by_tier"][Tier];
    else if (k === "unwatched" && isMap(v)) s.unwatched = { ...s.unwatched, ...v } as ShipSettings["unwatched"];
    else if (k === "generated") s.generated = isMap(v) ? { globs: (v.globs as string[]) ?? [], command: v.command === null ? null : (v.command as string) ?? "" } : null;
    else s[k] = v;
  }
  return s;
}
const defaultsOf = (raw: Dict) => entryOf(raw.defaults, "cautious");
/** The preset a repo's entry (or the defaults) names. */
export const presetOf = (raw: unknown, repo: string): "cautious" | "full" => {
  const r = isMap(raw) ? raw : {};
  const key = Object.keys(isMap(r.repos) ? r.repos : {}).find((k) => k.toLowerCase() === repo.toLowerCase());
  return entryOf(key ? (r.repos as Dict)[key] : undefined, defaultsOf(r).preset).preset;
};

/** The settings a repo runs under, or null where ship doesn't work it: not a fleet repo and no entry of its own. */
export function effective(raw: unknown, repo: string, scope: Scope): ShipSettings | null {
  const r = isMap(raw) ? raw : {};
  const key = Object.keys(isMap(r.repos) ? r.repos : {}).find((k) => k.toLowerCase() === repo.toLowerCase());
  if (!match(repo, scope.fleet) && !(key && match(repo, scope.listed))) return null;
  const d = defaultsOf(r);
  if (!key) return resolve(d.preset, d.over);
  const entry = (r.repos as Dict)[key];
  const e = entryOf(entry, d.preset);
  // An entry spelled with only fields sits over the defaults' preset and overrides.
  const inherits = isMap(entry) && !("preset" in entry);
  return resolve(e.preset, inherits ? { ...d.over, ...e.over, caps: { ...(d.over.caps as Dict), ...(e.over.caps as Dict) }, by_tier: Object.fromEntries(TIERS.map((t) => [t, { ...((d.over.by_tier as Dict)?.[t] as Dict), ...((e.over.by_tier as Dict)?.[t] as Dict) }])), unwatched: { ...(d.over.unwatched as Dict), ...(e.over.unwatched as Dict) } } : e.over);
}

const oneOf = (errors: string[], at: string, v: unknown, list: readonly string[]) => { if (!list.includes(v as string)) errors.push(`${at}: one of ${list.join(", ")}`); };
const strings = (errors: string[], at: string, v: unknown) => { if (!Array.isArray(v) || v.some((x) => typeof x !== "string" || !x || x.length > 300)) errors.push(`${at}: a list of strings`); };
const count = (errors: string[], at: string, v: unknown) => { if (v !== null && !(Number.isInteger(v) && (v as number) >= 0)) errors.push(`${at}: a whole number, or null for unlimited`); };

// A step is one of the repo's workflows, never free text: a file name in .github/workflows (it goes into an API path) with string
// inputs, whose one placeholder is `{pr}` (the PR's number). A workflow reports its run; a comment's bot doesn't, so there are no
// comment steps.
const WORKFLOW = /^[\w.-]{1,100}\.ya?ml$/;
export function stepError(x: unknown): string | undefined {
  if (isMap(x) && "comment" in x) return "comment steps are gone: use the repo's workflow, { workflow: file.yml, inputs? } (an input may say {pr})";
  if (!isMap(x) || !("workflow" in x) || Object.keys(x).some((k) => !["workflow", "inputs"].includes(k))) return "{ workflow, inputs? }";
  if (typeof x.workflow !== "string" || !WORKFLOW.test(x.workflow)) return "workflow: a file name in .github/workflows, e.g. pr-rebase.yml";
  if ("inputs" in x && (!isMap(x.inputs) || Object.keys(x.inputs).length > 10 || Object.entries(x.inputs).some(([k, v]) => !/^[\w-]{1,50}$/.test(k) || typeof v !== "string" || v.length > 200))) return "inputs: up to 10 names with text values";
  if ("inputs" in x && Object.values(x.inputs as Dict).some((v) => /[{}]/.test(String(v).replaceAll("{pr}", "")))) return "inputs: the only placeholder is {pr}";
  // It runs on the base branch: an input naming the PR is the only way it knows which one.
  if (!isMap(x.inputs) || !Object.values(x.inputs).some((v) => String(v).includes("{pr}"))) return "inputs: name the PR with {pr}, e.g. inputs: { pr: \"{pr}\" }";
  return undefined;
}
/** A GitHub login (a user's or a bot's `name[bot]`). */
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(\[bot\])?$/;

/** The per-repo fields risk tiers replaced: refused with a message. */
const OLD = ["approve", "merge", "safe"];
function checkEntry(errors: string[], at: string, e: unknown) {
  if (typeof e === "string") return void (Object.hasOwn(PRESETS, e) || errors.push(`${at}: preset ${e} (cautious or full)`));
  if (!isMap(e)) return void errors.push(`${at}: a preset name or a map of fields`);
  for (const k of Object.keys(e)) if (!FIELDS.includes(k) && !OLD.includes(k)) errors.push(`${at}.${k}: unknown field (known: ${FIELDS.join(", ")})`);
  if ("preset" in e) oneOf(errors, `${at}.preset`, e.preset, ["cautious", "full"]);
  if ("enabled" in e && typeof e.enabled !== "boolean") errors.push(`${at}.enabled: true or false`);
  if ("handoff" in e) oneOf(errors, `${at}.handoff`, e.handoff, HANDOFF);
  if ("rebase" in e) oneOf(errors, `${at}.rebase`, e.rebase, REBASE);
  // The old per-repo shape is refused with its way out, never read (risk tiers spec §11).
  for (const k of OLD) if (k in e) errors.push(`${at}.${k}: approve and merge are per tier now: by_tier.<tier>.approve / merge; safe is gone: code review's tier rules say what is small and safe`);
  if ("by_tier" in e) {
    if (!isMap(e.by_tier)) errors.push(`${at}.by_tier: a map of tier (${TIERS.join(", ")}) to { approve, merge }`);
    else for (const [t, c] of Object.entries(e.by_tier)) {
      if (!TIERS.includes(t as Tier)) { errors.push(`${at}.by_tier.${t.slice(0, 40)}: unknown tier (known: ${TIERS.join(", ")})`); continue; }
      if (!isMap(c) || Object.keys(c).some((k) => !["approve", "merge"].includes(k))) { errors.push(`${at}.by_tier.${t}: { approve, merge }`); continue; }
      if ("approve" in c) { if (t === "skip") errors.push(`${at}.by_tier.skip.approve: skip has no review to approve on`); else oneOf(errors, `${at}.by_tier.${t}.approve`, c.approve, APPROVE); }
      if ("merge" in c) oneOf(errors, `${at}.by_tier.${t}.merge`, c.merge, MERGE);
    }
  }
  if ("unwatched" in e) {
    if (!isMap(e.unwatched) || Object.keys(e.unwatched).some((k) => k !== "merge")) errors.push(`${at}.unwatched: { merge }`);
    else if ("merge" in e.unwatched) oneOf(errors, `${at}.unwatched.merge`, e.unwatched.merge, MERGE);
  }
  if ("fix" in e) { strings(errors, `${at}.fix`, e.fix); if (Array.isArray(e.fix)) for (const f of e.fix) if (!FIX.includes(f)) errors.push(`${at}.fix: ${String(f).slice(0, 40)} (known: ${FIX.join(", ")})`); }
  if ("protected" in e) strings(errors, `${at}.protected`, e.protected);
  if ("ignore_authors" in e && (!Array.isArray(e.ignore_authors) || e.ignore_authors.length > 50 || e.ignore_authors.some((x) => typeof x !== "string" || !LOGIN.test(x)))) errors.push(`${at}.ignore_authors: a list of up to 50 GitHub logins`);
  if ("stop_label" in e && (typeof e.stop_label !== "string" || !e.stop_label || e.stop_label.length > 50)) errors.push(`${at}.stop_label: a label name`);
  if ("generated" in e && e.generated !== null) {
    const g = e.generated;
    if (!isMap(g) || Object.keys(g).some((k) => !["globs", "command"].includes(k))) errors.push(`${at}.generated: { globs, command }`);
    else { strings(errors, `${at}.generated.globs`, g.globs ?? []); if (g.command !== undefined && g.command !== null && (typeof g.command !== "string" || g.command.length > 500)) errors.push(`${at}.generated.command: text, or null when the repo's CI regenerates these paths`); }
  }
  if ("actions" in e) {
    if (!isMap(e.actions)) errors.push(`${at}.actions: a map of stage to steps`);
    else for (const [stage, steps] of Object.entries(e.actions)) {
      if (!STAGES.includes(stage as never)) { errors.push(`${at}.actions.${stage.slice(0, 40)}: unknown stage (known: ${STAGES.join(", ")})`); continue; }
      if (!Array.isArray(steps) || steps.length > 5) { errors.push(`${at}.actions.${stage}: a list of up to 5 steps`); continue; }
      steps.forEach((x, i) => { const m = stepError(x); if (m) errors.push(`${at}.actions.${stage}[${i}]: ${m}`); });
    }
  }
  if ("caps" in e) {
    if (!isMap(e.caps)) errors.push(`${at}.caps: a map`);
    else for (const [k, v] of Object.entries(e.caps)) CAP_KEYS.includes(k as never) ? count(errors, `${at}.caps.${k}`, v) : errors.push(`${at}.caps.${k}: unknown cap (known: ${CAP_KEYS.join(", ")})`);
  }
}

/** The old per-repo fields (`defaults.safe`, `owner/name.merge`) a raw `ship` value still holds. The compile refuses them whole. */
export function oldShape(raw: unknown): string[] {
  const r = isMap(raw) ? raw : {};
  const entries: [string, unknown][] = [["defaults", r.defaults], ...Object.entries(isMap(r.repos) ? r.repos : {})];
  return entries.flatMap(([at, e]) => (isMap(e) ? OLD.filter((k) => k in e).map((k) => `${at}.${k}`) : []));
}

/** The errors in a raw `ship` value (none: valid). */
export function validate(raw: unknown, scope: Scope): string[] {
  const errors: string[] = [];
  if (!isMap(raw)) return ["ship: a map { defaults, repos, paused }"];
  for (const k of Object.keys(raw)) if (!["defaults", "repos", "paused"].includes(k)) errors.push(`ship.${k}: unknown (defaults, repos, paused)`);
  if ("paused" in raw && typeof raw.paused !== "boolean") errors.push("ship.paused: true or false");
  if ("defaults" in raw) checkEntry(errors, "defaults", raw.defaults);
  const repos = raw.repos ?? {};
  if (!isMap(repos)) return [...errors, "ship.repos: a map of owner/name to a preset or fields"];
  for (const [repo, e] of Object.entries(repos)) {
    if (!REPO.test(repo)) { errors.push(`${repo.slice(0, 100)} isn't owner/name`); continue; }
    if (!match(repo, scope.fleet) && !match(repo, scope.listed)) { errors.push(`${repo} isn't a repo ship covers (agents org, product repo or maintainer_repos)`); continue; }
    checkEntry(errors, repo, e);
  }
  return errors;
}

const rank = (list: readonly string[], v: string) => list.indexOf(v);
const raised = (a: number | null, b: number | null) => (b === null ? a !== null : a !== null && b > a);
/** Every field a change loosens, by repo (`owner/name.field`, or `defaults.field`): the owner's to approve. */
export function loosens(before: unknown, after: unknown, scope: Scope = ALL): string[] {
  const b = isMap(before) ? before : {}, a = isMap(after) ? after : {};
  const repos = new Set([...Object.keys(isMap(b.repos) ? b.repos : {}), ...Object.keys(isMap(a.repos) ? a.repos : {})].map((r) => r.toLowerCase()));
  const out: string[] = [];
  const diff = (name: string, x: ShipSettings, y: ShipSettings) => {
    const add = (f: string) => out.push(`${name}.${f}`);
    if (y.enabled && !x.enabled) add("enabled");
    if (rank(HANDOFF, y.handoff) > rank(HANDOFF, x.handoff)) add("handoff");
    if (y.rebase === "behind" && x.rebase !== "behind") add("rebase");
    for (const t of TIERS) {
      if (rank(APPROVE, y.by_tier[t].approve) > rank(APPROVE, x.by_tier[t].approve)) add(`by_tier.${t}.approve`);
      if (y.by_tier[t].merge === "ready" && x.by_tier[t].merge !== "ready") add(`by_tier.${t}.merge`);
    }
    if (y.unwatched.merge === "ready" && x.unwatched.merge !== "ready") add("unwatched.merge");
    if (y.fix.some((f) => !x.fix.includes(f))) add("fix");
    if (x.protected.some((p) => !y.protected.includes(p))) add("protected");
    for (const k of CAP_KEYS) if (raised(x.caps[k], y.caps[k])) add(`caps.${k}`);
    // The repair writes the generators' output on these paths: a new glob widens what an untrusted box may change. The command
    // stays an ordinary setting (it runs only in the credential-free box).
    if ((y.generated?.globs ?? []).some((g) => !(x.generated?.globs ?? []).includes(g))) add("generated.globs");
    // Back from an explicit list to discovery: the discovered paths may reach past the list, so that is a loosening too.
    if (x.generated && !y.generated) add("generated");
    // `command: null` (the repo's CI regenerates) is no loosening: the repair then runs nothing and writes only the base's own
    // blobs on those paths, which the globs already bound.
    // A new ignored account: its comments no longer gate a merge (an agent could name a person), so it is the owner's. Dropping
    // one is free.
    const ignored = (l: string[]) => new Set(l.map((x) => x.toLowerCase()));
    if ([...ignored(y.ignore_authors)].some((l) => !ignored(x.ignore_authors).has(l))) add("ignore_authors");
    // A new step of the repo's own (a workflow it dispatches with the owner's credentials) is the owner's.
    const count = (l: ActionStep[] | undefined, v: string) => (l ?? []).filter((u) => JSON.stringify(u) === v).length;
    for (const st of STAGES) if ((y.actions[st] ?? []).some((v) => count(y.actions[st], JSON.stringify(v)) > count(x.actions[st], JSON.stringify(v)))) add(`actions.${st}`);
  };
  const dx = resolve(defaultsOf(b).preset, defaultsOf(b).over), dy = resolve(defaultsOf(a).preset, defaultsOf(a).over);
  diff("defaults", dx, dy);
  for (const r of [...repos].sort()) {
    const x = effective(b, r, scope), y = effective(a, r, scope);
    if (!x && y) out.push(`${r}.enabled`); // bringing a listed repo into scope is the owner's
    else if (x && y) diff(r, x, y);
  }
  if (b.paused === true && a.paused !== true) out.push("paused");
  return out;
}

/** The scope from the environment: the fleet org and the product repo, and maintainer_repos (JSON entries, or a comma list). */
export function scopeFrom(e: Record<string, string | undefined>): Scope {
  const m = (() => { try { return JSON.parse(e.SHIP_MAINTAINER_REPOS || "null"); } catch { return null; } })();
  const listed = Array.isArray(m) ? m.map((x) => (typeof x === "string" ? x : x?.repo)) : String(e.SHIP_MAINTAINER_REPOS ?? "").split(",");
  const ok = (l: unknown[]) => l.map((x) => String(x ?? "").trim()).filter((x) => /^[\w.-]+\/[\w.*-]+$/.test(x));
  return { fleet: ok([e.SHIP_FLEET_ORG ? `${e.SHIP_FLEET_ORG}/*` : "", e.SHIP_PRODUCT_REPO]), listed: ok(listed) };
}
