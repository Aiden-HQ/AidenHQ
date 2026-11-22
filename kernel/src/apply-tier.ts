// kernel.apply's planner (spec §4.4 "Land", §5.7): what an instance change is, read from git by the code host, and its tier on
// its merits. The kernel plans every kernel.apply with these rules (writes.ts `planners`), whoever files it: the release
// train, the updater, an agent's job.
// The plan is the record's args (the commit, its files and the module changes it brings), its card (the diff whole, bound by
// its hash in the targets), the files for the path inventory, and a raise from the rules below; computeTier adds the floor,
// the owner's veto and the caps. A change the rules refuse is refused at filing, saying why.
//
// The rules are each file's own (instance.yaml settings, overrides, pins; apps.yaml; an agent's definition, handbook or
// memory) and the module authority diff (scripts/compiler/authority.ts) a product or modules move brings. Pure, except createApplyPlanner.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { readDigest, strayFiles, untrialedNewAgents, productPin, bumpTitle, type Read, type Source } from "./apply.ts";
import { applyCard, repoKey } from "./kinds.ts";
import { heldRoles } from "./identity.ts";
import { authorityLines, classifyModules, diffAll, forkChanges, grantOverrides, marketplaceChanges, moduleInputs, withGrantOverrides, type ModuleInput } from "../../scripts/compiler/authority.ts";
import { effective } from "../../scripts/compiler/release.ts";
import { hostFetch, officialSides, remoteCodeText, withRemote } from "../../scripts/compiler/sources.ts";
import { REJECT, T, highest, type Part } from "./tier.ts";
import { UPDATER, canonical, type Requester } from "./records.ts";
import { DEFAULT_WEIGHTS, teamProblems } from "./team-routing.ts";

/** The spend settings and their defaults (kernel/settings.json): raising one is the owner's. */
const SPEND_DEFAULTS: Record<string, number> = Object.fromEntries(["spend_day_usd", "spend_month_usd", "task_usd"].map((k) => [k, JSON.parse(readFileSync(new URL("../settings.json", import.meta.url), "utf8"))[k].default]));

export const parse = (text: any) => {
  try {
    return text == null ? undefined : (YAML.parse(String(text)) ?? {});
  } catch {
    return null; // unparseable: unrecognised
  }
};
export const eq = (a: any, b: any) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
export const changedKeys = (a: any = {}, b: any = {}) => [...new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])].filter((k) => !eq(a?.[k], b?.[k]));

/**
 * Grants `head` gives that `base` didn't: a connection added, or a wider grant (read → write, more tools). `conns` is each
 * connection's tags ({ name: { tools: { read, write, destructive } } }, from the compiled config): where `write` was, a list
 * is wider when it names any tool outside the connection's read and write tags (a destructive one: `write` never covers it),
 * and wider whenever the connection's tags aren't known (fail closed).
 */
export function newGrants(base: any = {}, head: any = {}, conns: any = {}) {
  const out = [];
  for (const [conn, g] of Object.entries(head ?? {})) {
    const was = (base ?? {})[conn];
    if (eq(was, g) || (was === "read" && g === "read")) continue;
    if (was === "write" && g === "read") continue;
    const tags = conns?.[String(conn).replace(/\?$/, "")]?.tools;
    if (was === "write" && Array.isArray(g) && tags && g.every((t) => [...(tags.read ?? []), ...(tags.write ?? [])].includes(t))) continue;
    if (Array.isArray(g) && Array.isArray(was) && g.every((t) => was.includes(t))) continue;
    out.push(conn);
  }
  return out;
}

/** Routines whose `autonomy` (their cap on approvals) is set, changed or dropped: always the owner's. */
export const routineAutonomyChanges = (b: any = {}, h: any = {}) => [...new Set([...Object.keys(b ?? {}), ...Object.keys(h ?? {})])].filter((r) => (b?.[r]?.autonomy != null || h?.[r]?.autonomy != null) && !eq(b?.[r]?.autonomy, h?.[r]?.autonomy) && h?.[r]);

const AGENT_SAFE = new Set(["name", "description", "model", "reasoning_effort", "timeout_sec", "routines", "max_parallel", "heartbeat"]);
const OVERRIDE_SAFE: Record<string, Set<string>> = { agents: new Set(["model", "reasoning_effort", "timeout_sec", "heartbeat"]), routines: new Set(["schedules", "status", "model"]) };

export function applyParts(s: any) {
  const parts = [];
  const def = (key: any, side: any) => s[side]?.[`agents/${key}/agent.yaml`];
  for (const f of s.files ?? []) {
    let m: any;
    if (f === "instance.yaml") parts.push(...instanceParts(s));
    else if (f === "apps.yaml") {
      const [b, h] = [parse(s.base?.[f]), parse(s.head?.[f])];
      parts.push(...(b === null || h === null ? [REJECT("unparseable", "apps.yaml doesn't parse")] : appsParts(b?.apps ?? [], h?.apps ?? [], s.moduleApps)));
    } else if ((m = /^agents\/([a-z0-9][a-z0-9-]*)\/agent\.yaml$/.exec(f))) parts.push(agentDefPart(m[1], parse(def(m[1], "base")), parse(def(m[1], "head")), s));
    // A curated memory (the Librarian's proposal; compiled into the agent's handbook as lessons and facts, never authority): the
    // reviewer decides, for a role holder too (owner, 2026-11-14), and flags one that redirects authority.
    else if ((m = /^agents\/([a-z0-9][a-z0-9-]*)\/memory\.md$/.exec(f))) parts.push((s.roles?.[m[1]] ?? []).length ? T(1, "role-memory", `memory of ${m[1]}, which holds a role`) : T(1, "agent-memory", `memory of ${m[1]}, an agent without a role`));
    else if ((m = /^agents\/([a-z0-9][a-z0-9-]*)\/AGENTS\.md$/.exec(f))) {
      const key = m[1];
      const base = parse(def(key, "base"));
      const head = parse(def(key, "head"));
      if ((s.roles?.[key] ?? []).length) parts.push(T(1, "role-handbook", `handbook of ${key}, which holds a role`));
      // A module agent's forked handbook (overrides.agents.<key>.handbook_fork, on either side: made, edited or dropped):
      // a handbook change like its additions; a handbook grants no authority.
      else if (base === undefined && head === undefined && forked(s, key)) parts.push(T(1, "module-handbook", `forked handbook of ${key}, an agent without a role`));
      else if (base === undefined) {
        // A new agent's handbook: only alongside its new agent.yaml, in trial, in this same change; anything else is refused.
        const added = (s.files ?? []).includes(`agents/${key}/agent.yaml`) && head?.trial === true;
        parts.push(!added ? REJECT("handbook-without-agent", `${key}'s handbook, without a new trial agent.yaml in the change`) : s.ownerStarted ? T(0, "trial-agent-new", `${key}'s handbook, with its new trial agent, on a task the owner started`) : T(1, "trial-agent-new-agent-task", `${key}'s handbook, with its new trial agent, on an agent-origin task`));
      } else if (base === null) parts.push(REJECT("unparseable", `agents/${key}/agent.yaml doesn't parse`));
      else if (base.trial === true) parts.push(s.trialNoTap ? T(0, "trial-handbook", `handbook of ${key}, an agent in trial`) : T(1, "trial-handbook-agent-task", `handbook of ${key}, an agent in trial, on an agent-origin task`));
      else parts.push(T(1, "agent-handbook", `handbook of ${key}, a graduated agent without a role`));
    } else if ((m = /^agents\/([\w.-]+)\.md$/.exec(f))) {
      const roles = s.roles?.[m[1]] ?? [];
      parts.push(roles.length ? T(1, "role-handbook", `handbook of ${m[1]}, which holds a role`) : T(1, "module-handbook", `handbook additions for ${m[1]}, an agent without a role`));
    } else parts.push(T(1, "unrecognised-file", `${f} isn't a file apply recognises`));
  }
  return parts;
}

/** Whether instance.yaml on either side forks this module agent's handbook (overrides.agents.<key>.handbook_fork). */
const forked = (s: any, key: any) => ["base", "head"].some((side) => parse(s[side]?.["instance.yaml"])?.overrides?.agents?.[key]?.handbook_fork != null);

/**
 * A routine's effective status as compile gives it (scripts/modules.ts): the instance override, else the definition's own
 * `status`, else active. Compile's quiet-start pause covers module agents only, never an instance agent's own routines.
 */
const instanceRoutineStatus = (key: any, def: any, rk: any, instance: any) => instance?.overrides?.routines?.[`${key}-${rk}`]?.status ?? def?.routines?.[rk]?.status ?? "active";

/**
 * What an instance agent's definition starts running under quiet start (instance.yaml `settings.quiet_start: on`): a heartbeat
 * turned on, or a scheduled routine whose effective status is active at head and wasn't at base. Empty when quiet start is off.
 */
function quietWakes(key: any, base: any, head: any, instance: any) {
  if (instance?.settings?.quiet_start !== "on" || !head) return [];
  const beats = (d: any) => d?.heartbeat != null && d.heartbeat !== false;
  const active = (d: any, rk: any) => Boolean(d?.routines?.[rk]?.schedules?.length) && instanceRoutineStatus(key, d, rk, instance) === "active";
  return [...(beats(head) && !beats(base) ? ["turns a heartbeat on"] : []), ...Object.keys(head.routines ?? {}).filter((rk) => active(head, rk) && !active(base, rk)).map((rk) => `starts routine ${rk}`)];
}

/** Every gate on one definition change, the highest wins: none returns before the others have run. */
function agentDefPart(key: any, base: any, head: any, s: any) {
  if (base === null || head === null) return REJECT("unparseable", `agents/${key}/agent.yaml doesn't parse`);
  if (head === undefined) return T(1, "agent-removed", `removes agent ${key}`);
  const parts = [agentDefFields(key, base, head, s)];
  const caps = routineAutonomyChanges(base?.routines, head.routines);
  if (caps.length) parts.push(T(1, "routine-autonomy", `${key}: routine autonomy changes (${caps.join(", ")})`));
  const woken = quietWakes(key, base, head, parse(s.head?.["instance.yaml"]));
  if (woken.length) parts.push(T(2, "quiet-start", `${key}: ${woken.join(", ")} under quiet start, the owner's authority`));
  return highest(parts);
}

/** A definition's own fields: new agent, grants, privileged fields, trial, tuning. */
function agentDefFields(key: any, base: any, head: any, s: any) {
  if (base === undefined) {
    if (head.trial !== true) return T(1, "untrialed-agent", `new agent ${key} isn't in trial`);
    // Only the safe fields (no roles, image or other privileges); any write grant goes to the reviewer at least.
    const other = Object.keys(head).filter((k) => k !== "trial" && k !== "connections" && !AGENT_SAFE.has(k));
    if (other.length) return T(1, "new-agent-fields", `new agent ${key} sets ${other.join(", ")}`);
    if (Object.values(head.connections ?? {}).some((g) => g !== "read")) return T(1, "trial-agent-new-writes", `adds ${key} in trial, with write or tool-level grants`);
    return s.ownerStarted ? T(0, "trial-agent-new", `adds ${key} in trial, on a task the owner started`) : T(1, "trial-agent-new-agent-task", `adds ${key} in trial, on an agent-origin task`);
  }
  const keys = changedKeys(base, head);
  const wider = newGrants(base.connections, head.connections, s.connections);
  if (wider.length) return T(1, "new-grants", `${key} gets new grants: ${wider.join(", ")}`);
  const other = keys.filter((k) => k !== "connections" && k !== "trial" && !AGENT_SAFE.has(k));
  if (other.length) return T(1, "agent-fields", `${key} changes ${other.join(", ")}`);
  if (keys.includes("trial")) {
    if (base.trial === true && head.trial !== true) return T(1, "graduation", `${key} graduates, keeping only the tools and connections it had in trial`);
    return T(1, "agent-into-trial", `${key}'s trial flag changes`);
  }
  return T(1, "agent-tuning", `${key}: ${keys.join(", ") || "no field"} changes`);
}

/**
 * The modules a product bump or a `modules:` edit changes (spec §5.7): `s.modules` is each module's def before and after and
 * whether its code changed (the runner read them at both product commits); `s.modulesError` when it couldn't. Every module
 * change is the AI reviewer's; new authority is merit 2 (labelled for it).
 * The instance's third-party marketplace changes are read here from both instance.yaml sides; a new one is the owner's. With a
 * release, `s.effective` is each side with the release's official marketplace (the runner read it at its distro sha).
 */
function moduleAuthorityParts(s: any, base: any, head: any, release?: string) {
  if (s.modulesError || !s.modules) return [REJECT("unknown-content", `couldn't read the module changes${s.modulesError ? ` (${s.modulesError})` : ""}; try again`)];
  let markets, forks;
  try { markets = marketplaceChanges(s.effective?.base ?? base, s.effective?.head ?? head); } catch (err: any) { return [REJECT("unparseable", `instance.yaml marketplaces: ${String(err.message ?? err).slice(0, 200)}`)]; }
  // Forks (spec §6.9b): read here from both sides, so entering one is the owner's whatever its code diff reads as.
  try { forks = forkChanges(base, head); } catch (err: any) { return [REJECT("unparseable", `instance.yaml forks: ${String(err.message ?? err).slice(0, 200)}`)]; }
  const diffs = [...markets, ...forks, ...diffAll(s.modules)];
  // A grants override that moved but reached no module's diff was not judged: the owner's.
  const [bo, ho] = [grantOverrides(base), grantOverrides(head)];
  const moved = changedKeys(bo, ho);
  const folded = (key: any) => Object.values(s.modules as Record<string, any>).some((i) => i.base?.agents?.[key] && i.head?.agents?.[key] && !eq(i.base.agents[key].connections, i.head.agents[key].connections));
  const unjudged = moved.filter((k) => !folded(k));
  // Not judged by any module's diff: merit 2, beside (never instead of) what the diffs say.
  const extra = unjudged.length ? [T(2, "grants-unjudged", `the grants override of ${unjudged.join(", ")} changes, and no module's authority diff covers it`)] : [];
  // The official marketplace moving with every module's folder tree id unchanged (the 5b switch): no authority, the reviewer's.
  if (!diffs.length) return [...extra, ...(changedKeys(base, head).includes("marketplaces") ? [T(1, "marketplace-same-trees", "the official marketplace moves; every module's folder tree id is unchanged")] : [])];
  // The owner's auto-updates taking an official release (owner, 2026-11-20: "auto update implies you are accepting new
  // authority and anything else not actively malicious from the official releases"): when every change is an official
  // module's, all of them are accepted, and the AI reviewer judges
  // only whether the update is malicious or compromised, reading every line, never
  // the owner. Anything else (a module that isn't official, a marketplace or fork line, an unjudged grants override) goes
  // as below.
  if (release && !extra.length && diffs.every((d) => d.official && d.changes.every((c) => !c.ownerOnly))) {
    const all = diffs.flatMap((d) => d.changes);
    // Short enough that the record's reason (writes.ts, 300 characters) is never cut: the lines carry the detail.
    const part = T(1, "release-update", `official release ${release}, verified by the updater, under the owner's auto-updates: ${all.length} module changes, ${all.filter((c) => c.owner).length} new authority, every line after the diff; check it is not malicious or compromised`);
    return [part];
  }
  const c = classifyModules(diffs);
  return [...extra, T(c.tier, c.rule, c.reason)];
}

/**
 * A module setting's owner rules (module.yaml settings.<key>.owner): what an agent's change may not do without the owner.
 * `default`: the value the module uses where the field is unset (a new entry's, an unset or removed field's).
 */
export type OwnerRule = { path: string; raise?: true; change?: true; to?: unknown; new?: true; before?: string; default?: unknown };
/** A setting as its module's service reads it: the instance's value over the module's default, maps merged (lists replace). */
const merged = (dflt: unknown, v: unknown): unknown => (isDict(dflt) && isDict(v) ? Object.fromEntries([...new Set([...Object.keys(dflt), ...Object.keys(v)])].map((k) => [k, k in v ? merged(dflt[k], v[k]) : dflt[k]])) : v === undefined ? dflt : v);
/**
 * The values a path pattern reaches (`*`: any map key or list item; a list of maps is keyed by its items' repo, id, name or
 * key), and whether a list along the way holds one key twice (then which entry a rule compares is ambiguous).
 */
function reach(v: unknown, path: string[], at = "", dup = { found: false }): { values: Map<string, unknown>; dup: boolean } {
  const out = new Map<string, unknown>();
  const walk = (x: unknown, rest: string[], here: string) => {
    if (!rest.length) return void out.set(here, x);
    const [seg, ...more] = rest;
    const kids: [string, unknown][] = Array.isArray(x) ? x.map((y, i) => [String(isDict(y) ? y.repo ?? y.id ?? y.name ?? y.key ?? i : i).toLowerCase(), y]) : isDict(x) ? Object.entries(x) : [];
    if (new Set(kids.map(([k]) => k)).size !== kids.length) dup.found = true;
    for (const [k, y] of kids) if (seg === "*" || k === seg) walk(y, more, `${here}.${k}`);
  };
  walk(v, path, at);
  return { values: out, dup: dup.found };
}
/**
 * What an agent's change to a setting does that its module makes the owner's (OwnerRule), each value read as the module runs
 * it (unset or removed: the rule's default; the setting's default under both sides): `raise`, a number above what it was (a
 * new entry: above the default); `change`, any different value; `to`, the value newly set to that (an entry removed holds its
 * default from then: removing one that held another value sets it to the default); `new`, a value (its part before `before`)
 * none had before. A list holding one key twice is the owner's too.
 */
export function ownerRaises(key: string, rules: OwnerRule[], dflt: unknown, base: unknown, head: unknown): string[] {
  // A value of another shape than its default (a string where a list is meant) is one the rules can't read: the owner's.
  const shape = (v: unknown) => (Array.isArray(v) ? "list" : isDict(v) ? "map" : typeof v);
  if (head != null && dflt != null && shape(head) !== shape(dflt)) return [`${key}: a ${shape(head)} where its default is a ${shape(dflt)}`];
  const [b, h] = [merged(dflt, base), merged(dflt, head)];
  const out: string[] = [];
  for (const r of rules) {
    const path = String(r.path).split(".").filter(Boolean);
    if (r.new) {
      const [bv, hv] = [reach(b, path), reach(h, path)];
      if (hv.dup) out.push(`${key}: an entry listed twice`);
      const norm = (x: unknown) => (typeof x === "string" ? (r.before ? x.split(r.before)[0]! : x).toLowerCase() : JSON.stringify(x));
      const had = new Set([...bv.values.values()].map(norm));
      for (const [at, now] of hv.values) if (!had.has(norm(now))) out.push(`${key}${at}: new ${JSON.stringify(norm(now)).slice(0, 60)}`);
      continue;
    }
    // The entries holding the field (the setting itself for a top-level field), and the field's value in each, or its default.
    const leaf = path.at(-1)!;
    const [bv, hv] = [reach(b, path.slice(0, -1)), reach(h, path.slice(0, -1))];
    if (hv.dup) out.push(`${key}: an entry listed twice`);
    const val = (e: unknown) => (isDict(e) && e[leaf] !== undefined ? e[leaf] : r.default);
    for (const [at, entry] of hv.values) {
      if (entry === null) continue; // switched off (a default reviewer set to null): it runs nothing
      const now = val(entry);
      const was = bv.values.has(at) ? val(bv.values.get(at)) : r.default;
      const hit = r.raise ? typeof now === "number" && now > (typeof was === "number" ? was : 0)
        : r.change ? !eq(was, now)
        : "to" in r ? eq(now, r.to) && !eq(was, r.to) : false;
      if (hit) out.push(`${key}${at}.${leaf}: ${r.raise ? "raised" : r.change ? "changed" : "set"} to ${JSON.stringify(now).slice(0, 60)}`);
    }
    if ("to" in r) for (const [at, entry] of bv.values) {
      if (hv.values.has(at) || entry === null || !eq(r.default, r.to) || eq(val(entry), r.to)) continue;
      out.push(`${key}${at}.${leaf}: removed, so ${JSON.stringify(r.to).slice(0, 60)}`);
    }
  }
  return [...new Set(out)];
}

/**
 * The release the owner's standing authority asks for: the kernel's updater moving the pin along the same source, forward,
 * while auto-updates are on (both sides; unset is on), to exactly the instance.yaml it verified itself for this base
 * (`verified`: the planner checked it, never the requester's say-so). Its name, else undefined. The record carries it
 * (args.release), so the reviewer reads the owner's request for that release, its official modules' authority included.
 */
export function standingRelease(base: any, head: any, verified: boolean, back: boolean): string | undefined {
  const auto = (i: any) => i?.settings?.auto_update !== "off";
  const ok = verified && base?.release != null && head?.release != null && eq(base.release?.source, head.release?.source) && auto(base) && auto(head) && !back;
  return ok && typeof head.release.name === "string" ? head.release.name : undefined;
}

function instanceParts(s: any) {
  const base = parse(s.base?.["instance.yaml"]);
  const head = parse(s.head?.["instance.yaml"]);
  if (!base || !head) return [REJECT("unparseable", "instance.yaml doesn't parse")];
  const parts = [];
  const keys = changedKeys(base, head);
  // Module authority: what the modules hand out moves with the pins and lists, and with an agent's grants override
  // (overrides.agents.<key>.connections, folded into its module's def, so the authority diff judges it like a module grant).
  const release = standingRelease(base, head, s.releaseVerified === true, Boolean(s.pin?.back));
  if (["product", "modules", "marketplaces", "release", "product_fork"].some((k) => keys.includes(k)) || !eq(grantOverrides(base), grantOverrides(head))) parts.push(...moduleAuthorityParts(s, base, head, release));
  // Following a release is the owner's (docs/design/release-updates.md). The one exception: the kernel's release updater moving
  // the pin along the same source, forward, while auto-updates are on (both sides; unset is on), to exactly the instance.yaml
  // it verified itself for this base (`s.releaseVerified`: the planner checked it, never the requester's say-so). That is the
  // owner's standing authority, so the reviewer's. Any other add or move is the owner's after the reviewer; the module parts
  // above still raise new authority to the owner. Dropping the pin leaves the module parts above to judge.
  if (keys.includes("release") && head.release != null) {
    parts.push(release
      ? T(1, "release-pin", "the release updater moves this instance to the next release it verified, while auto-updates are on: the owner's standing authority")
      : T(2, "release-pin", "adds or moves the release this instance follows: the owner's authority, unless it is the updater's verified move while auto-updates are on"));
  }
  else if (keys.includes("release") && !parts.length) parts.push(T(1, "release-pin", "the release pin is removed; what it resolved to is unchanged"));
  for (const k of keys) {
    if (k === "modules" || k === "marketplaces" || k === "release" || k === "product_fork") continue; // the module parts above (a release by what it resolves to)
    // A rollback can undo a security fix: the reviewer reads it. A pin off product main is refused.
    if (k === "product") parts.push(s.pin?.forward ? T(1, "pin-forward", "the product pin moves forward along product main") : s.pin?.back ? T(1, "pin-backwards", "the product pin moves backwards (a rollback)") : REJECT("pin-unknown", "the product pin moves, and not along product main"));
    else if (k === "settings") {
      // Every setting is the reviewer's. (Slack channels agents post to are no special case since 2f: a post to a channel off
      // slack_post_channels is itself a Tier 2 slack.post record.)
      for (const sk of changedKeys(base.settings, head.settings)) {
        parts.push(T(1, "settings", `changes the setting ${sk}`));
        // An agent's change (never the owner's own, nor the kernel's) that does what the setting's module makes the owner's:
        // more spend, a wider reach (settings.<key>.owner, compiled into the catalog).
        const def = s.settingDefs?.[sk];
        const raised = s.byAgent && Array.isArray(def?.owner) ? ownerRaises(sk, def.owner, def.default, base.settings?.[sk], head.settings?.[sk]) : [];
        if (raised.length) parts.push(T(2, "setting-owner", `an agent's change the owner decides: ${raised.join("; ")}`.slice(0, 600)));
      }
      // Spend is the owner's authority under every autonomy: raising the install's limits or the task cap. Only a finite positive
      // number at or under the old value tightens it; unset is the default (SPEND_DEFAULTS, kernel/settings.json).
      for (const [sk, dflt] of Object.entries(SPEND_DEFAULTS)) {
        const [was, now] = [base.settings?.[sk] ?? dflt, head.settings?.[sk] ?? dflt];
        const tighter = typeof now === "number" && Number.isFinite(now) && now > 0 && now <= Number(was);
        if (!eq(was, now) && !tighter) parts.push(T(2, "spend-cap", `raises ${sk} (${JSON.stringify(was).slice(0, 40)} → ${JSON.stringify(now).slice(0, 40)}): spend is the owner's authority`));
      }
      if (base.settings?.quiet_start === "on" && head.settings?.quiet_start !== "on") parts.push(T(2, "quiet-start", "turns quiet start off, so every module schedule and heartbeat starts: the owner's authority"));
      // Release updates (docs/design/release-updates.md): auto-updates on is the owner's standing authority to install releases.
      if (base.settings?.auto_update === "off" && head.settings?.auto_update !== "off") parts.push(T(2, "auto-update", "turns release auto-updates back on, so each new release installs itself at night: the owner's authority"));
      // Autonomy is the owner's authority: any loosening (off → tier0 or full, tier0 → full; unset is off) is theirs to tap.
      const rank = (v: unknown) => ({ tier0: 1, full: 2 } as Record<string, number>)[String(v)] ?? 0;
      if (rank(head.settings?.autonomy) > rank(base.settings?.autonomy)) parts.push(T(2, "autonomy", `loosens autonomy (${base.settings?.autonomy ?? "off"} → ${String(head.settings?.autonomy).slice(0, 20)}): the owner's authority`));
    } else if (k === "overrides") {
      for (const kind of changedKeys(base.overrides, head.overrides)) {
        const safe = OVERRIDE_SAFE[kind];
        for (const name of changedKeys(base.overrides?.[kind], head.overrides?.[kind])) {
          const all = changedKeys(base.overrides?.[kind]?.[name], head.overrides?.[kind]?.[name]);
          // An agent's grants are the module parts' (above); its handbook fork is a handbook change like its additions.
          const fields = kind === "agents" ? all.filter((x) => x !== "connections" && x !== "handbook_fork") : all;
          if (kind === "agents" && all.includes("handbook_fork")) parts.push((s.roles?.[name] ?? []).length ? T(1, "role-handbook", `handbook fork of ${name}, which holds a role`) : T(1, "module-handbook", `handbook fork of ${name}, an agent without a role`));
          if (!fields.length) continue;
          // Under quiet start, what the owner hasn't turned on stays off until they tap: a routine to active, a heartbeat on.
          const [b, h] = [base.overrides?.[kind]?.[name] ?? {}, head.overrides?.[kind]?.[name] ?? {}];
          if (head.settings?.quiet_start === "on" && (kind === "routines" ? fields.includes("status") && h.status === "active" && b.status !== "active" : kind === "agents" && fields.includes("heartbeat") && h.heartbeat != null && h.heartbeat !== false))
            parts.push(T(2, "quiet-start", `overrides ${kind} ${name}: turns on scheduled work under quiet start, the owner's authority`));
          parts.push(safe && fields.every((x) => safe.has(x)) ? T(1, kind === "agents" ? "model-change" : "routine-schedule", `${kind} ${name}: ${fields.join(", ")}`) : T(1, "overrides", `overrides ${kind} ${name}: ${fields.join(", ")}`));
        }
      }
    } else if (k === "teams") {
      // The routing learning loop's own commit (the kernel wrote it: `s.routingTune`), proven by the one routing gate to move
      // only members' repos and routing weights: routing data, the reviewer's; anything more is refused. Any other change:
      // members, repos, weights and the rest: the reviewer's.
      const routing = s.routingTune ? routingDiff(s.base?.["instance.yaml"], s.head?.["instance.yaml"]) : undefined;
      if (routing) parts.push("leaves" in routing ? T(1, "routing-only", `team routing only: ${routing.leaves.map((l) => l.path.slice(1).join(".")).join(", ")}`.slice(0, 300)) : REJECT("routing-scope", `a routing change moves only members' repos and routing weights: ${routing.problem}`));
      else for (const t of changedKeys(base.teams, head.teams)) parts.push(T(1, "teams", `changes team ${t}`));
    } else parts.push(T(1, "instance-key", `changes ${k} in instance.yaml`));
  }
  return parts;
}

// ---- Team routing (the learning loop, routing-tune.ts): the one routing gate ----
/** One changed value: its path in instance.yaml and its value before and after (undefined: absent). */
export type Leaf = { path: string[]; before?: unknown; after?: unknown };
const isDict = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
const sameValue = (a: unknown, b: unknown) => canonical(a ?? null) === canonical(b ?? null);

/** A team without the leaves the loop may change (members' repos, routing weights): everything else must stay equal. */
function fixedPart(t: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = { ...t, members: Object.fromEntries(Object.entries(isDict(t.members) ? t.members : {}).map(([k, m]) => [k, isDict(m) ? { ...m, repos: undefined } : m])) };
  if (isDict(t.routing)) { const { weights: _w, ...rest } = t.routing; out.routing = Object.keys(rest).length ? rest : undefined; }
  return out;
}

/** Whether a YAML node holds an alias or a merge key: a value shared with another place, which a leaf-wise check can't see. */
function shares(node: unknown): boolean {
  let found = false;
  if (node) YAML.visit(node as YAML.Node, { Alias: () => ((found = true), YAML.visit.BREAK), Pair: (_k, p) => { if (YAML.isScalar(p.key) && (p.key.value === "<<" || typeof p.key.value === "symbol")) return ((found = true), YAML.visit.BREAK); } });
  return found;
}

/**
 * The routing diff between two instance.yaml texts, or why it isn't one: only members' `repos` and `routing.weights` move, on
 * teams and members both sides have, every value valid by the one team schema (team-routing.ts), and no alias, merge key or
 * duplicate key anywhere under `teams`. Other top-level keys aren't looked at (apply-tier judges each key on its own; the
 * writer checks them equal). The single routing gate: apply-tier.ts and the writer both call it.
 */
export function routingDiff(baseText: string | undefined, headText: string | undefined): { leaves: Leaf[] } | { problem: string } {
  const docs = [baseText, headText].map((t) => YAML.parseDocument(String(t ?? "")));
  if (docs.some((d) => d.errors.length)) return { problem: "instance.yaml doesn't parse (or repeats a key)" };
  if ([baseText, headText].some((t) => /^%YAML/m.test(String(t ?? "")))) return { problem: "instance.yaml carries a %YAML directive" };
  if (docs.some((d) => shares(d.get("teams", true)))) return { problem: "teams: uses an alias or a merge key" };
  const [b, h] = docs.map((d) => (d.toJS() ?? {}).teams);
  if (!isDict(b) || !isDict(h)) return { problem: "teams: must be a map on both sides" };
  if (!sameValue(Object.keys(b).sort(), Object.keys(h).sort())) return { problem: "a team is added or removed" };
  const leaves: Leaf[] = [];
  for (const t of Object.keys(h)) {
    if (sameValue(b[t], h[t])) continue;
    if (!isDict(b[t]) || !isDict(h[t])) return { problem: `teams.${t}: not a map` };
    if (!sameValue(fixedPart(b[t]), fixedPart(h[t]))) return { problem: `teams.${t}: changes more than members' repos and routing weights` };
    const problems = teamProblems(t, h[t]);
    if (problems.length) return { problem: problems[0]! };
    for (const m of Object.keys(h[t].members)) {
      const [x, y] = [b[t].members[m]?.repos, h[t].members[m]?.repos];
      if (!sameValue(x, y)) leaves.push({ path: ["teams", t, "members", m, "repos"], before: x, after: y });
    }
    const [bw, hw] = [b[t].routing?.weights ?? {}, h[t].routing?.weights ?? {}];
    for (const w of Object.keys(DEFAULT_WEIGHTS)) if (!sameValue(bw[w], hw[w])) leaves.push({ path: ["teams", t, "routing", "weights", w], before: bw[w], after: hw[w] });
  }
  return leaves.length ? { leaves } : { problem: "teams: nothing changes" };
}

/**
 * An app entry as apps-mcp's AppSchema leaves it (modules/apps-platform/apps-mcp/src/registry.ts): defaults, and `database` / `api` adding
 * their network and secrets. Kept in step with it by hand; the tiers test pins the cases.
 */
export function normalizeApp(raw: any) {
  const a = { caps: [], connects: [], secrets: [], stateful: false, untrusted: false, ...(raw ?? {}) };
  if (a.database) a.connects = [...new Set([...a.connects, a.database])];
  a.secrets = [...new Set([...a.secrets, ...(a.database ? ["DATABASE_URL"] : [])])];
  return a;
}

/** apps-mcp's isSensitive, as a list of reasons: access, database, stateful, untrusted, caps, or connects to paperclip or a restricted app. */
export function sensitiveTraits(app: any, all: any) {
  return [
    app.access && "access",
    app.share && "share (people outside the tailnet)",
    app.panel && "panel (owner's nav pin)",
    app.database && "database",
    app.stateful && "stateful",
    app.untrusted && "untrusted",
    app.caps.length && "caps",
    app.connects.some((c: any) => c === "paperclip" || c === "sources" || all.find((x: any) => x.name === c && (x.access || x.share))) && "connects to paperclip, the sources network, or a restricted or shared app",
  ].filter(Boolean);
}

/**
 * The registry change, per app: everything apps-mcp calls sensitive is authority-expanding (labelled for the reviewer), except the spec's
 * one carve-out (an app whose only sensitive trait is `database: warehouse`, ordinary DB provisioning: Tier 1). New secrets
 * (after the schema's additions) and an API write path are labelled too. Removing an app is the reviewer's.
 * `moduleApps`: the module apps, for restricted-app lookups.
 */
export function appsParts(base: any, head: any, moduleApps: any = []) {
  const list = (l: any) => (Array.isArray(l) ? l : []).map(normalizeApp);
  const was = new Map(list(base).map((a) => [a.name, a]));
  const now = new Map(list(head).map((a) => [a.name, a]));
  const all = [...now.values(), ...list(moduleApps)];
  const parts = [];
  for (const name of [...was.keys()].filter((n) => !now.has(n))) parts.push(T(1, "app-removed", `removes app ${name}`));
  for (const [name, a] of now) {
    const b = was.get(name);
    if (eq(a, b)) continue;
    const traits = sensitiveTraits(a, all);
    const secrets = a.secrets.filter((x: any) => !(b?.secrets ?? []).includes(x) && !(x === "DATABASE_URL" && a.database === "warehouse"));
    const warehouseOnly = traits.length === 1 && traits[0] === "database" && a.database === "warehouse";
    const why = [...(warehouseOnly ? [] : traits), a.api && "an API write path", secrets.length && `new secrets ${secrets.join(", ")}`].filter(Boolean);
    if (why.length) parts.push(T(1, "sensitive-app", `app ${name}: ${why.join(", ")}`));
    else parts.push(T(1, warehouseOnly ? "app-warehouse" : "app-registry", `${b ? "changes" : "adds"} app ${name}${warehouseOnly ? " (a warehouse database)" : ""}`));
  }
  return parts;
}

/**
 * The module side of an apply (moduleAuthorityParts, spec §5.7): when the product pin, the `modules:` list, a marketplace, a
 * release, a fork or an agent's grants override moves, each module's manifest on both sides (the loader reads them at the
 * product commits, which `product` must hold) and whether its code changed. { modulesError } when anything can't be read: the
 * tier fails closed.
 */
export function moduleTierState(baseText: string | undefined, headText: string | undefined, product: string) {
  if (baseText === undefined || headText === undefined) return {};
  try {
    const [bi, hi] = [YAML.parse(baseText) ?? {}, YAML.parse(headText) ?? {}];
    if (["product", "modules", "marketplaces", "release", "product_fork"].every((k) => eq(bi[k], hi[k])) && eq(grantOverrides(bi), grantOverrides(hi))) return {};
    const [from, to] = [String(bi.product ?? ""), String(hi.product ?? "")];
    if (![from, to].every((x) => /^[0-9a-f]{40}$/.test(x))) return { modulesError: "the product pin isn't a full commit on both sides" };
    // The official modules by folder tree id; third-party modules (marketplaces:) at their pinned shas. A release supplies
    // the official marketplace, read at its distro sha on both sides; a fork sits on top of what it resolves to.
    const fetch = { ...hostFetch(product), parse: (t: string) => YAML.parse(t) };
    const [eb, eh] = [effective(bi, fetch), effective(hi, fetch)];
    const read = withRemote({ baseInstance: eb, headInstance: eh, ...officialSides(eb, eh, from, to, product, fetch) }, fetch);
    // Each side's agent grants overrides folded into its module defs: the authority diff judges them like module grants.
    const sides = { ...read, baseDefs: withGrantOverrides(read.baseDefs, bi), headDefs: withGrantOverrides(read.headDefs, hi) };
    return { modules: moduleInputs({ ...sides, always: [] }), marketplaces: [...marketplaceChanges(eb, eh), ...forkChanges(bi, hi)], effective: { base: eb, head: eh }, remote: remoteCodeText(eb, eh, fetch, product) };
  } catch (err) {
    return { modulesError: String((err as Error).message ?? err).split("\n")[0]!.slice(0, 200) };
  }
}

/**
 * What code found, after the diff, for the reviewer (policy 09-module-changes.md): the release the owner's auto-updates ask
 * for, and every module authority line. The reason names only the first few; the reviewer judges each line.
 */
export function reviewerFacts(a: { authority?: string[]; release?: string }): string {
  return [
    a.release && `Release update (computed by code): the kernel's updater moves this instance to release ${a.release}, which it verified, while the owner's auto-updates are on: the owner's standing request for this release.`,
    a.authority?.length && `Module changes (the authority diff, computed by code from the module manifests; owner = new authority):\n${a.authority.join("\n")}`,
  ].filter(Boolean).join("\n\n");
}

/**
 * The authority lines an apply's args carry (so its card lists them, the reviewer reads every one and its digest covers them),
 * owner changes first, each whole: never cut (a change too large to review is refused by the details cap instead). Each
 * module's `code changes` line folds into one. `release`: the release the owner's auto-updates take (standingRelease): when
 * every change is an official module's, it needs no owner tap.
 */
export function authorityArgs(st: { modules?: Record<string, ModuleInput>; marketplaces?: ReturnType<typeof marketplaceChanges> }, release?: string): { authority?: string[] } {
  const diffs = st.modules ? [...(st.marketplaces ?? []), ...diffAll(st.modules)] : [];
  const code = diffs.filter((d) => d.changes.some((c) => c.what === "code changes" && !c.owner)).map((d) => d.module);
  const all = authorityLines(diffs.map((d) => ({ ...d, changes: d.changes.filter((c) => !(c.what === "code changes" && !c.owner)) })));
  const isOwner = (l: string) => l.endsWith("(owner)");
  const lines = [...all.filter(isOwner), ...all.filter((l) => !isOwner(l)), ...(code.length ? [`code changes in ${code.join(", ")} (review)`] : [])];
  return lines.length ? { authority: lines } : {};
}

/** The product pin's move, as the product's git reads it on its main: the commits it adds or removes. */
export type Bump = { from?: string; to: string; title: string; forward: boolean; back: boolean; log: string };
export type ProductGit = {
  /** Fetches the product's main and says whether `sha` is on it. */
  onMain(sha: string): Promise<boolean>;
  isAncestor(a: string, b: string): Promise<boolean>;
  /** `git log --oneline` of a range. */
  log(range: string): Promise<string>;
};
/** The move a change's `product:` pin makes, null when it doesn't move it, { error } when it can't be applied. */
export async function productBump(from: string | undefined, to: string | undefined, g: ProductGit): Promise<Bump | null | { error: string }> {
  if (!to || from === to) return null;
  if (!(await g.onMain(to))) return { error: `product \`${to.slice(0, 9)}\` is not on the product's main` };
  const forward = !from || (await g.isAncestor(from, to));
  const back = !forward && (await g.isAncestor(to, from!));
  const title = bumpTitle({ from, to, forward, back });
  if (!title) return { error: `product pins \`${from!.slice(0, 9)}\` and \`${to.slice(0, 9)}\` have diverged (neither contains the other)` };
  const log = !from ? "" : await g.log(forward ? `${from}..${to}` : `${to}..${from}`);
  return { from, to, title, forward, back, log: log || "(no commits)" };
}

/** What an apply plan returns to writes.ts (its executor@1 plan's shape, planned by the kernel itself). */
export type ApplyPlan = {
  args: { repo: string; branch: string; sha: string; files: string[]; authority?: string[]; release?: string };
  targets: { diff: string; content: string }; card: Record<string, string>; paths: { repo: string; files: { path: string }[] }[];
  raise?: { tier: 1 | 2; reason?: string; rule?: string };
};
export class Refused extends Error {
  status = 422;
  type = "refused";
}
/** The largest diff a card shows: a bigger change is split, never shown in part. */
export const DIFF_MAX = 60_000;
/** The largest card details (the diff, the product commits, third-party code, trial edits): the reviewer reads them whole. */
export const DETAILS_MAX = 80_000;

/**
 * kernel.apply's planner. The requester names the commit (repo, branch, sha); the code host reads it from git (its own copy,
 * or a job's task workspace) and everything else comes from that read, the product's git and the compiled config, never from
 * the requester's words.
 */
export function createApplyPlanner(h: {
  /** The instance repo (owner/name, AIDENHQ_INSTANCE_REPO): the only repository an apply lands on. */
  instanceRepo(): string | undefined;
  read(s: Source): Promise<Read>;
  product: ProductGit;
  /** The module side of an instance.yaml change (moduleTierState over the product checkout). */
  modules(baseText: string | undefined, headText: string | undefined): ReturnType<typeof moduleTierState>;
  /** Each agent's roles, by its key (the grants table). */
  roles(): Record<string, string[]>;
  /** Each connection's tool tags (config/kernel/connections.json). */
  connections(): Record<string, { tools: { read: string[]; write: string[]; destructive: string[] } }>;
  /** The module apps (config/apps.modules.yaml), for restricted-app lookups. */
  moduleApps(): unknown[];
  /** The enabled modules' setting declarations by key (config/modules.json): each one's default and owner rules. */
  settingDefs?(): Record<string, { default?: unknown; owner?: OwnerRule[] }>;
  /**
   * The instance.yaml the release updater would write for release `name` at distro commit `sha` on this base, after every
   * check it makes (updates.ts verify); null when the release fails one or can't be checked.
   */
  verifyRelease(baseText: string, name: string, sha: string): Promise<string | null>;
  /** What the kernel itself says of this commit, shown and reviewed with its diff: a routing experiment's code-made evidence (routing-tune.ts). */
  notes?(sha: string, requester: Requester | undefined, task: string | undefined): string | undefined;
}) {
  /** Whether this is the updater's own release move, to exactly the instance.yaml its verification of that release writes. */
  async function updaterMove(requester: Requester | undefined, baseText: string | undefined, headText: string | undefined): Promise<boolean> {
    if (requester?.kind !== UPDATER.kind || requester.name !== UPDATER.name || baseText === undefined || headText === undefined) return false;
    const r = parse(headText)?.release;
    if (typeof r?.name !== "string" || typeof r?.sha !== "string") return false;
    return (await h.verifyRelease(baseText, r.name, r.sha).catch(() => null)) === headText;
  }
  return async function plan({ args, requester, task, workspace }: { args: unknown; requester?: Requester; task?: string; workspace?: string }): Promise<ApplyPlan> {
    const a = (args ?? {}) as { repo?: unknown; branch?: unknown; sha?: unknown };
    if (typeof a.repo !== "string" || typeof a.branch !== "string" || typeof a.sha !== "string") throw new Refused("name the commit to apply: {repo, branch, sha}");
    // The configured instance repo, never the requester's spelling of it: what is read, tiered by path and landed.
    const repo = h.instanceRepo();
    if (!repo || !repoKey(repo)) throw new Refused("the instance repo isn't set here (AIDENHQ_INSTANCE_REPO), so nothing can be applied");
    if (repoKey(a.repo) !== repoKey(repo)) throw new Refused(`an apply lands only on the instance repo (${repo}), not ${a.repo.slice(0, 100)}`);
    // A job's commit is read from its task's workspace (the job's own, never the requester's words); a module's from the code host's copy.
    const src: Source = { repo, branch: a.branch, sha: a.sha, ...(workspace ? { workspace } : {}) };
    const c = await h.read(src);
    if (!c.files.length) throw new Refused("the commit changes nothing against the instance's main");
    const stray = strayFiles(c.files);
    if (stray.length) throw new Refused(`it changes files outside the instance config (${stray.join(", ")}). Only instance.yaml, apps.yaml, agents/<key>.md, agents/<key>/{agent.yaml,AGENTS.md} and owner/profile.md can be applied; product code and module handbooks change through an Engineer PR`);
    if (c.diff.length > DIFF_MAX) throw new Refused(`the diff is too large to review (${c.files.length} files, ${c.diff.length} characters): split the change into smaller ones`);
    const untrialed = untrialedNewAgents(c.files, c.texts.base, c.texts.head);
    if (untrialed.length) throw new Refused(`a new agent starts in trial (\`trial: true\` in agents/${untrialed[0]}/agent.yaml, read-only grants, reporting to architect); its write grants come with a second change after the trial`);
    const [baseI, headI] = [c.texts.base["instance.yaml"], c.texts.head["instance.yaml"]];
    const bump = await productBump(productPin(baseI), productPin(headI), h.product);
    if (bump && "error" in bump) throw new Refused(bump.error);
    const st = { ...(c.files.includes("instance.yaml") ? h.modules(baseI, headI) : {}) } as ReturnType<typeof moduleTierState> & { remote?: string };
    const notes = h.notes?.(a.sha, requester, task);
    // The routing learning loop's commit: only instance.yaml's teams may move (the rules refuse anything else).
    if (notes && (c.files.length !== 1 || c.files[0] !== "instance.yaml" || changedKeys(parse(baseI), parse(headI)).some((k) => k !== "teams"))) throw new Refused("a routing change moves only instance.yaml's teams");
    // The kind's floor is 1 (every apply is read by the reviewer), so the rules' Tier 0 trial exceptions (ownerStarted,
    // trialNoTap) never lower anything here.
    // An agent's settings change meets its module's owner rules: only the owner's settings change and the kernel's own (kind
    // kernel) are exempt; no requester counts as an agent (fail closed).
    const releaseVerified = !eq(parse(baseI)?.release, parse(headI)?.release) && (await updaterMove(requester, baseI, headI));
    const t = highest(applyParts({ files: c.files, base: c.texts.base, head: c.texts.head, pin: bump ? { forward: bump.forward, back: bump.back } : null, routingTune: Boolean(notes), roles: h.roles(), connections: h.connections(), moduleApps: h.moduleApps(), settingDefs: h.settingDefs?.() ?? {}, byAgent: requester?.kind !== "kernel", ownerStarted: false, trialNoTap: false, releaseVerified, ...st }));
    if (t.reject) throw new Refused(String(t.reason));
    const release = standingRelease(parse(baseI), parse(headI), releaseVerified, Boolean(bump && bump.back));
    const full = { repo, branch: a.branch, sha: a.sha, files: c.files, ...authorityArgs(st, release), ...(release ? { release } : {}) };
    const details = [notes, c.diff, bump && `${bump.title.replaceAll("`", "")}:\n${bump.log}`, reviewerFacts(full), st.remote, c.trial].filter(Boolean).join("\n\n");
    if (details.length > DETAILS_MAX) throw new Refused(`the change is too large to review (${details.length} characters with the commits and code it brings): split it into smaller ones`);
    const card = applyCard(full, details);
    return {
      args: full, targets: { diff: createHash("sha256").update(details).digest("hex"), content: readDigest(c) }, card: card as unknown as Record<string, string>,
      paths: [{ repo, files: c.files.map((path) => ({ path })) }],
      ...(t.tier >= 1 ? { raise: { tier: t.tier as 1 | 2, ...(t.reason ? { reason: String(t.reason) } : {}), ...(t.rule ? { rule: String(t.rule) } : {}) } } : {}),
    };
  };
}
export type ApplyPlanner = ReturnType<typeof createApplyPlanner>;

const git = (repo: string, args: string[]) =>
  new Promise<string>((resolve, reject) => execFile("git", ["-C", repo, ...args], { maxBuffer: 16 * 1024 * 1024, timeout: 120_000 }, (err, out, errOut) => (err ? reject(new Error(`git ${args[0]}: ${String(errOut || err.message).trim().slice(0, 300)}`)) : resolve(String(out).trim()))));
/** The product checkout's git (the host's, with its own credential helper, as the loader fetches): its main fetched first. */
export const hostProduct = (repo: string): ProductGit => ({
  onMain: async (sha) => {
    await git(repo, ["fetch", "--quiet", "origin", "main"]);
    return git(repo, ["merge-base", "--is-ancestor", sha, "refs/remotes/origin/main"]).then(() => true, () => false);
  },
  isAncestor: (a, b) => git(repo, ["merge-base", "--is-ancestor", a, b]).then(() => true, () => false),
  log: (range) => git(repo, ["log", "--oneline", "--no-decorate", range]),
});

/** The planner on this host: the code host's read, the product checkout, and the compiled grants, connections and apps. */
export function hostPlanner({ repo, instanceRepo, configDir, read, grants, connections, verifyRelease, notes }: {
  repo: string; instanceRepo: () => string | undefined; configDir: string; read: (s: Source) => Promise<Read>;
  verifyRelease: (baseText: string, name: string, sha: string) => Promise<string | null>;
  grants: () => Record<string, { key?: string; roles?: string[] } | undefined>;
  connections: () => Record<string, { tools: { read: string[]; write: string[]; destructive: string[] } }>;
  notes?: (sha: string, requester: Requester | undefined, task: string | undefined) => string | undefined;
}): ApplyPlanner {
  return createApplyPlanner({
    instanceRepo, read, notes, product: hostProduct(repo), modules: (b, h) => moduleTierState(b, h, repo), connections, verifyRelease,
    roles: () => Object.fromEntries(Object.entries(grants()).flatMap(([id, a]) => (a?.key ? [[a.key, heldRoles(grants() as never, id)]] : []))),
    moduleApps: () => { try { return ((YAML.parse(readFileSync(join(configDir, "apps.modules.yaml"), "utf8")) ?? {}).apps ?? []).filter(Boolean); } catch { return []; } },
    settingDefs: () => Object.assign({}, ...(JSON.parse(readFileSync(join(configDir, "modules.json"), "utf8")) as { enabled?: boolean; settings?: Record<string, unknown> }[]).filter((m) => m.enabled).map((m) => m.settings ?? {})),
  });
}
