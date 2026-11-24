// Ship's per-repo settings (the one `ship` setting): presets, the effective settings of a repo, validation, and what a change
// loosens. Every knob is a per-repo setting with no floor in code; `null` caps are unlimited (owner, 2026-11-24).
type Dict = Record<string, unknown>;

export const CAP_KEYS = ["wakes_per_head", "ci_rounds", "same_check_heads", "review_rounds", "rounds", "usd", "requeue_on_timeout"] as const;
export type Caps = Record<(typeof CAP_KEYS)[number], number | null>;
export const HANDOFF = ["none", "label", "all"] as const;
export const REBASE = ["conflict", "behind"] as const;
export const APPROVE = ["off", "observe", "safe", "all"] as const;
export const MERGE = ["off", "ready"] as const;
export const FIX = ["conflicts", "ci", "review"] as const;

export interface ShipSettings {
  /** Whether ship adopts and works this repo's PRs (the Fleet page's Enabled switch). */
  enabled: boolean;
  handoff: (typeof HANDOFF)[number];
  rebase: (typeof REBASE)[number];
  generated: { globs: string[]; command: string } | null;
  fix: (typeof FIX)[number][];
  protected: string[];
  caps: Caps;
  approve: (typeof APPROVE)[number];
  safe: { max_lines: number | null; max_files: number | null; deny: string[] };
  merge: (typeof MERGE)[number];
  stop_label: string;
}

// Protected paths bind the model's fixes only: the deterministic repair may regenerate lockfiles.
const PROTECTED = ["**/package-lock.json", "**/pnpm-lock.yaml", "**/yarn.lock", ".github/**", "**/.eslintrc*", "**/eslint.config.*", "**/vitest.config.*", "**/jest.config.*", "**/tsconfig*.json", "**/CODEOWNERS"];

const CAUTIOUS: ShipSettings = {
  enabled: true, handoff: "label", rebase: "conflict", generated: null, fix: ["conflicts", "ci", "review"], protected: PROTECTED,
  caps: { wakes_per_head: 3, ci_rounds: 3, same_check_heads: 2, review_rounds: 3, rounds: 30, usd: 5, requeue_on_timeout: 1 },
  approve: "observe", safe: { max_lines: 1200, max_files: 50, deny: [...PROTECTED, "**/migrations/**", "**/auth/**", "**/Dockerfile*", "**/docker-compose*", "**/*.tf", "infra/**", "**/.env*", "**/config/**"] }, merge: "ready", stop_label: "ship:stop",
};
const FULL: ShipSettings = {
  // Unguarded at ship's own policy layer. Host rules, human code-owner reviews and kernel authority still apply.
  ...CAUTIOUS, handoff: "all", rebase: "behind", protected: [], approve: "all",
  caps: Object.fromEntries(CAP_KEYS.map((k) => [k, null])) as Caps,
  safe: { max_lines: null, max_files: null, deny: [] },
};
/** The Fleet page's controls (per repo, and the global pause) and the declared setting each one edits (the same fields the English tool and validate use). */
export const CONTROLS = {
  enabled: { setting: "enabled", scope: "repo", values: [true, false], label: "On or off" },
  preset: { setting: "preset", scope: "repo", values: ["cautious", "full"], label: "Preset" },
  handoff: { setting: "handoff", scope: "repo", values: HANDOFF, label: "Which PRs to adopt" },
  approve: { setting: "approve", scope: "repo", values: APPROVE, label: "Approval policy" },
  merge: { setting: "merge", scope: "repo", values: MERGE, label: "Auto-merge" },
  paused: { setting: "paused", scope: "global", values: [true, false], label: "Pause everything" },
} as const;
export const PRESETS: Record<"cautious" | "full", ShipSettings> = { cautious: CAUTIOUS, full: FULL };
const clone = <T>(v: T): T => structuredClone(v);

const isMap = (v: unknown): v is Dict => !!v && typeof v === "object" && !Array.isArray(v);
export const FIELDS = ["preset", "enabled", "handoff", "rebase", "generated", "fix", "protected", "caps", "approve", "safe", "merge", "stop_label"];
const REPO = /^[\w.-]{1,100}\/[\w.-]{1,100}$/;

/** Where ship works: the fleet's own repos (the agents org as `org/*`, the product repo), always; a `maintainer_repos` repo only
 * once it has a ship entry (quiet until enabled). A wildcard owner and name matches all. */
export interface Scope { fleet: string[]; listed: string[] }
const match = (repo: string, list: string[]) => list.some((c) => { const [a, b] = c.toLowerCase().split("/"); const [r, n] = repo.toLowerCase().split("/"); return (a === "*" || a === r) && (b === "*" || b === n); });
const ALL: Scope = { fleet: ["*/*"], listed: [] };
/** Whether ship works the repo: a fleet repo, or a listed one (its ship entry is what turns a listed repo on). */
export const covers = (repo: string, scope: Scope) => match(repo, scope.fleet) || match(repo, scope.listed);

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
    else if (k === "safe" && isMap(v)) s.safe = { ...s.safe, ...v } as ShipSettings["safe"];
    else if (k === "generated") s.generated = isMap(v) ? { globs: (v.globs as string[]) ?? [], command: (v.command as string) ?? "" } : null;
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
  return resolve(e.preset, inherits ? { ...d.over, ...e.over, caps: { ...(d.over.caps as Dict), ...(e.over.caps as Dict) }, safe: { ...(d.over.safe as Dict), ...(e.over.safe as Dict) } } : e.over);
}

const oneOf = (errors: string[], at: string, v: unknown, list: readonly string[]) => { if (!list.includes(v as string)) errors.push(`${at}: one of ${list.join(", ")}`); };
const strings = (errors: string[], at: string, v: unknown) => { if (!Array.isArray(v) || v.some((x) => typeof x !== "string" || !x || x.length > 300)) errors.push(`${at}: a list of strings`); };
const count = (errors: string[], at: string, v: unknown) => { if (v !== null && !(Number.isInteger(v) && (v as number) >= 0)) errors.push(`${at}: a whole number, or null for unlimited`); };

function checkEntry(errors: string[], at: string, e: unknown) {
  if (typeof e === "string") return void (Object.hasOwn(PRESETS, e) || errors.push(`${at}: preset ${e} (cautious or full)`));
  if (!isMap(e)) return void errors.push(`${at}: a preset name or a map of fields`);
  for (const k of Object.keys(e)) if (!FIELDS.includes(k)) errors.push(`${at}.${k}: unknown field (known: ${FIELDS.join(", ")})`);
  if ("preset" in e) oneOf(errors, `${at}.preset`, e.preset, ["cautious", "full"]);
  if ("enabled" in e && typeof e.enabled !== "boolean") errors.push(`${at}.enabled: true or false`);
  if ("handoff" in e) oneOf(errors, `${at}.handoff`, e.handoff, HANDOFF);
  if ("rebase" in e) oneOf(errors, `${at}.rebase`, e.rebase, REBASE);
  if ("approve" in e) oneOf(errors, `${at}.approve`, e.approve, APPROVE);
  if ("merge" in e) oneOf(errors, `${at}.merge`, e.merge, MERGE);
  if ("fix" in e) { strings(errors, `${at}.fix`, e.fix); if (Array.isArray(e.fix)) for (const f of e.fix) if (!FIX.includes(f)) errors.push(`${at}.fix: ${String(f).slice(0, 40)} (known: ${FIX.join(", ")})`); }
  if ("protected" in e) strings(errors, `${at}.protected`, e.protected);
  if ("stop_label" in e && (typeof e.stop_label !== "string" || !e.stop_label || e.stop_label.length > 50)) errors.push(`${at}.stop_label: a label name`);
  if ("generated" in e && e.generated !== null) {
    const g = e.generated;
    if (!isMap(g) || Object.keys(g).some((k) => !["globs", "command"].includes(k))) errors.push(`${at}.generated: { globs, command }`);
    else { strings(errors, `${at}.generated.globs`, g.globs ?? []); if (g.command !== undefined && (typeof g.command !== "string" || g.command.length > 500)) errors.push(`${at}.generated.command: text`); }
  }
  if ("caps" in e) {
    if (!isMap(e.caps)) errors.push(`${at}.caps: a map`);
    else for (const [k, v] of Object.entries(e.caps)) CAP_KEYS.includes(k as never) ? count(errors, `${at}.caps.${k}`, v) : errors.push(`${at}.caps.${k}: unknown cap (known: ${CAP_KEYS.join(", ")})`);
  }
  if ("safe" in e) {
    if (!isMap(e.safe)) errors.push(`${at}.safe: a map`);
    else for (const [k, v] of Object.entries(e.safe)) k === "deny" ? strings(errors, `${at}.safe.deny`, v) : ["max_lines", "max_files"].includes(k) ? count(errors, `${at}.safe.${k}`, v) : errors.push(`${at}.safe.${k}: unknown field`);
  }
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
    if (y.approve !== x.approve && rank(APPROVE, y.approve) > rank(APPROVE, x.approve)) add("approve");
    if (y.merge === "ready" && x.merge !== "ready") add("merge");
    if (y.fix.some((f) => !x.fix.includes(f))) add("fix");
    if (x.protected.some((p) => !y.protected.includes(p))) add("protected");
    for (const k of CAP_KEYS) if (raised(x.caps[k], y.caps[k])) add(`caps.${k}`);
    if (raised(x.safe.max_lines, y.safe.max_lines)) add("safe.max_lines");
    if (raised(x.safe.max_files, y.safe.max_files)) add("safe.max_files");
    if (x.safe.deny.some((p) => !y.safe.deny.includes(p))) add("safe.deny");
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
