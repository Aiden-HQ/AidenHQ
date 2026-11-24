// kernel.apply's planner (spec §4.4 "Land", §5.7): what an instance change is, read from git by the code host. The kernel
// plans every kernel.apply with it (writes.ts `planners`), whoever files it: the release train, the updater, an agent's job.
// The plan is the record's args (the commit, its files and the module changes it brings) and its card (the diff whole, bound by
// its hash in the targets). Its tier is the kind's floor (1: the AI reviewer reads every apply) and computeTier's; this file adds
// only code's hard refusals (a file that doesn't parse, a pin off product main, module changes it can't read, a routing commit
// that moves more than routing) and the authority lines the card and the reviewer read. Pure, except createApplyPlanner.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import YAML from "yaml";
import { readDigest, productPin, bumpTitle, type Read, type Source } from "./apply.ts";
import { strayFiles } from "../sdk/src/instance-paths.ts";
import { applyCard, repoKey } from "./kinds.ts";
import { authorityLines, diffAll, forkChanges, grantOverrides, marketplaceChanges, moduleInputs, skillLines, withGrantOverrides, type ModuleInput } from "../../scripts/compiler/authority.ts";
import { effective } from "../../scripts/compiler/release.ts";
import { hostFetch, officialSides, remoteCodeText, withRemote } from "../../scripts/compiler/sources.ts";
import { UPDATER, canonical, type Requester } from "./records.ts";
import { DEFAULT_WEIGHTS, teamProblems } from "./team-routing.ts";
import type { Raise } from "./tier.ts";

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
 * Code's hard refusals on an apply (each a reason; any refuses it at filing) and the authority lines its card carries (the
 * module authority diff, authorityArgs). `s`: the commit's files and both sides' texts, the product pin's move, the module
 * state (moduleTierState), whether it is the routing loop's commit and whether the updater verified its release move.
 */
export function applyParts(s: any): { refusals: string[]; authority: string[] } {
  const refusals: string[] = [];
  for (const f of s.files ?? []) {
    let m: any;
    if (f === "instance.yaml") refusals.push(...instanceRefusals(s));
    else if ((f === "apps.yaml" || /^modules\/[a-z0-9][a-z0-9-]*\/module\.yaml$/.test(f)) && (parse(s.base?.[f]) === null || parse(s.head?.[f]) === null)) refusals.push(`${f} doesn't parse`);
    // agents/<key>/AGENTS.md is a module agent's handbook fork only: a new one comes with its fork in instance.yaml.
    else if ((m = /^agents\/([a-z0-9][a-z0-9-]*)\/AGENTS\.md$/.exec(f)) && s.base?.[f] === undefined && s.head?.[f] !== undefined && !forked(s, m[1])) refusals.push(`${f} is a module agent's handbook fork, without overrides.agents.${m[1]}.handbook_fork in instance.yaml`);
  }
  const release = standingRelease(parse(s.base?.["instance.yaml"]), parse(s.head?.["instance.yaml"]), s.releaseVerified === true, Boolean(s.pin?.back));
  return { refusals, authority: authorityArgs(s, release).authority ?? [] };
}

/** Whether instance.yaml on either side forks this module agent's handbook (overrides.agents.<key>.handbook_fork). */
const forked = (s: any, key: any) => ["base", "head"].some((side) => parse(s[side]?.["instance.yaml"])?.overrides?.agents?.[key]?.handbook_fork != null);

/** instance.yaml's refusals: either side unparseable, module changes that can't be read, a pin off product main, a routing commit that moves more. */
function instanceRefusals(s: any): string[] {
  const base = parse(s.base?.["instance.yaml"]);
  const head = parse(s.head?.["instance.yaml"]);
  if (!base || !head) return ["instance.yaml doesn't parse"];
  const out: string[] = [];
  const keys = changedKeys(base, head);
  if (["product", "modules", "marketplaces", "release", "product_fork"].some((k) => keys.includes(k)) || !eq(grantOverrides(base), grantOverrides(head))) {
    if (s.modulesError || !s.modules) out.push(`couldn't read the module changes${s.modulesError ? ` (${s.modulesError})` : ""}; try again`);
    try { marketplaceChanges(s.effective?.base ?? base, s.effective?.head ?? head); } catch (err: any) { out.push(`instance.yaml marketplaces: ${String(err.message ?? err).slice(0, 200)}`); }
    try { forkChanges(base, head); } catch (err: any) { out.push(`instance.yaml forks: ${String(err.message ?? err).slice(0, 200)}`); }
  }
  if (keys.includes("product") && !s.pin?.forward && !s.pin?.back) out.push("the product pin moves, and not along product main");
  // The routing learning loop's own commit (the kernel wrote it: `s.routingTune`) moves only members' repos and routing weights.
  if (keys.includes("teams") && s.routingTune) {
    const routing = routingDiff(s.base?.["instance.yaml"], s.head?.["instance.yaml"]);
    if ("problem" in routing) out.push(`a routing change moves only members' repos and routing weights: ${routing.problem}`);
  }
  return out;
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
 * The module side of an apply (its authority lines, spec §5.7): when the product pin, the `modules:` list, a marketplace, a
 * release, a fork or an agent's grants override moves, each module's manifest on both sides (the loader reads them at the
 * product commits, which `product` must hold) and whether its code changed. { modulesError } when anything can't be read: the
 * apply is refused.
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

/**
 * The apply that names or changes the instance's test-user sign-in identity (settings.edge.test_user): it lets an agent sign
 * in as a named account (docs/design/access.md, "Test-user sign-in"), so the plan carries a Tier 2 raise (merit 2; tier.ts
 * decides who sees it, as for every raise) and the line its card reads. Nothing for an apply that leaves the setting alone,
 * or removes it.
 */
export function testUserIdentity(baseText: string | undefined, headText: string | undefined): { raise?: Raise; line?: string } {
  const after = parse(headText)?.settings?.edge?.test_user;
  if (after === undefined || eq(parse(baseText)?.settings?.edge?.test_user, after)) return {};
  const email = typeof after?.email === "string" && after.email.trim() ? after.email.trim() : undefined;
  const apps = (Array.isArray(after?.apps) ? after.apps : []).filter((x: unknown): x is string => typeof x === "string" && x.length > 0);
  const line = `Adds a test sign-in identity${email ? `: ${email}` : ""}${apps.length ? ` as a member of ${apps.join(", ")}` : ""}; 15-minute sessions; every mint and revoke audited.`;
  return { raise: { tier: 2, rule: "test-user-identity", reason: "adds or changes the instance's agent sign-in identity (settings.edge.test_user)" }, line };
}

/**
 * The product commits a pin move brings, as its own labelled block: code's account of commits already merged on the product's
 * main, never the change under review. It rides in the card's details (the owner reads it) and is handed to the reviewer in
 * the same words as its own field (ReviewContext.productCommits), so the reviewer shows it as PRODUCT_COMMITS, never as the
 * DIFF. The reviewer removes exactly this text from the diff it was sent, so a line of the change can never pass for it.
 */
export const PRODUCT_COMMITS_OPEN = "<<<PRODUCT_COMMITS";
export const PRODUCT_COMMITS_CLOSE = "PRODUCT_COMMITS>>>";
export function productCommits(bump: Bump): string {
  // The same characters the card's render() drops (a commit subject may carry them): the reviewer removes exactly this text
  // from the details, so both copies must be identical or the roll-up would stay in the quotable diff.
  const clean = (t: string) => t.replace(/[\p{Cc}\p{Cf}]/gu, (c) => (c === "\n" || c === "\t" ? c : " "));
  return clean(`${PRODUCT_COMMITS_OPEN}\nProduct commits the pin move brings, already on the product's main (code's account, not the change under review):\n${bump.title.replaceAll("`", "")}:\n${bump.log}\n${PRODUCT_COMMITS_CLOSE}`);
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
  /** A raise above the kind's floor (writes.ts): the owner's own card for the identity an agent signs in as. */
  raise?: Raise;
  targets: { diff: string; content: string }; card: Record<string, string>;
  /** The reviewer's extra input (executor.ts ReviewContext): a pin move's product-commit roll-up. */
  review?: { productCommits: string };
};
export class Refused extends Error {
  status = 422;
  type = "refused";
}
/** The largest diff a card shows: a bigger change is split, never shown in part. */
export const DIFF_MAX = 60_000;
/** The largest card details (the diff, the product commits, third-party code): the reviewer reads them whole. */
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
  /**
   * The instance.yaml the release updater would write for release `name` at distro commit `sha` on this base, after every
   * check it makes (updates.ts verify); null when the release fails one or can't be checked.
   */
  verifyRelease(baseText: string, name: string, sha: string): Promise<string | null>;
  /** What the kernel itself says of this commit, shown and reviewed with its diff: a routing experiment's code-made evidence (routing-tune.ts). */
  notes?(sha: string, requester: Requester | undefined, task: string | undefined): string | undefined;
  /** The compiled effective skill lists at the commit's base and head, and its files with each touched skill folder's (settings-change.ts skillSides). */
  skills?(c: Read): Promise<{ before: Record<string, string[]>; after: Record<string, string[]>; files: string[]; enabledTexts?: Record<string, string> }>;
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
    // The configured instance repo, never the requester's spelling of it: what is read and landed.
    const repo = h.instanceRepo();
    if (!repo || !repoKey(repo)) throw new Refused("the instance repo isn't set here (AIDENHQ_INSTANCE_REPO), so nothing can be applied");
    if (repoKey(a.repo) !== repoKey(repo)) throw new Refused(`an apply lands only on the instance repo (${repo}), not ${a.repo.slice(0, 100)}`);
    // A job's commit is read from its task's workspace (the job's own, never the requester's words); a module's from the code host's copy.
    const src: Source = { repo, branch: a.branch, sha: a.sha, ...(workspace ? { workspace } : {}) };
    const c = await h.read(src);
    if (!c.files.length) throw new Refused("the commit changes nothing against the instance's main");
    const stray = strayFiles(c.files);
    if (stray.length) throw new Refused(`it changes files outside the instance config (${stray.join(", ")}). Only instance.yaml, apps.yaml, owner/profile.md, agents/<key>.md, agents/<key>/AGENTS.md (a handbook fork) and a local module's modules/<name>/{module.yaml,agents/<key>/AGENTS.md,skills/<name>/SKILL.md} can be applied; product code and module handbooks change through an Engineer PR`);
    // The owner's profile is the owner's own save or Aiden's (fleet-admin): never another agent's apply, however filed.
    if (c.files.includes("owner/profile.md") && requester && !(requester.roles ?? []).includes("fleet-admin")) throw new Refused("owner/profile.md changes only through Aiden (fleet-admin) or the owner's own save: ask Aiden");
    if (c.diff.length > DIFF_MAX) throw new Refused(`the diff is too large to review (${c.files.length} files, ${c.diff.length} characters): split the change into smaller ones`);
    const [baseI, headI] = [c.texts.base["instance.yaml"], c.texts.head["instance.yaml"]];
    const bump = await productBump(productPin(baseI), productPin(headI), h.product);
    if (bump && "error" in bump) throw new Refused(bump.error);
    // A product pin move lands alone (the product it moves to compiles the instance on apply; nothing here can compile with it).
    if (bump && (c.files.length !== 1 || changedKeys(parse(baseI), parse(headI)).some((k) => !["product", "release"].includes(k)))) throw new Refused("a product pin move lands alone: file the other changes in their own commit");
    // The module sides and the skill lines: whenever the change touches instance.yaml or any module folder. Skill lines come from
    // both sides compiled with the running product, so a product pin move (judged by the module authority diff) has none.
    const config = c.files.some((f) => f === "instance.yaml" || f === "apps.yaml" || f.startsWith("modules/") || f.startsWith("agents/"));
    const st = { ...(config ? h.modules(baseI, headI) : {}) } as ReturnType<typeof moduleTierState> & { remote?: string };
    // Both sides compiled: a head that doesn't compile is refused here, before it could land on main.
    const sides = config && !bump && h.skills ? await h.skills(c).catch((e: Error) => { throw new Refused(`it doesn't compile: ${String(e.message).split("\n")[0]!.slice(0, 300)}`); }) : undefined;
    const skills = sides ? skillLines(sides) : [];
    // A local skill an agent starts using: its whole text, for the reviewer (the diff carries it only when the skill itself
    // changed); the details' size limit refuses one too large to review.
    const enabledText = Object.entries(sides?.enabledTexts ?? {}).map(([id, t]) => `Skill ${id}, newly enabled (its SKILL.md, data):\n${t}`).join("\n\n");
    const notes = h.notes?.(a.sha, requester, task);
    // The routing learning loop's commit: only instance.yaml's teams may move (the rules refuse anything else).
    if (notes && (c.files.length !== 1 || c.files[0] !== "instance.yaml" || changedKeys(parse(baseI), parse(headI)).some((k) => k !== "teams"))) throw new Refused("a routing change moves only instance.yaml's teams");
    const releaseVerified = !eq(parse(baseI)?.release, parse(headI)?.release) && (await updaterMove(requester, baseI, headI));
    const { refusals, authority: modules } = applyParts({ files: c.files, base: c.texts.base, head: c.texts.head, pin: bump ? { forward: bump.forward, back: bump.back } : null, routingTune: Boolean(notes), releaseVerified, ...st });
    if (refusals.length) throw new Refused(refusals.join("; "));
    const authority = [...modules, ...skills];
    const release = standingRelease(parse(baseI), parse(headI), releaseVerified, Boolean(bump && bump.back));
    const full = { repo, branch: a.branch, sha: a.sha, files: c.files, ...(authority.length ? { authority } : {}), ...(release ? { release } : {}) };
    const commits = bump ? productCommits(bump) : "";
    const details = [notes, c.diff, commits, reviewerFacts(full), st.remote, enabledText].filter(Boolean).join("\n\n");
    if (details.length > DETAILS_MAX) throw new Refused(`the change is too large to review (${details.length} characters with the commits and code it brings): split it into smaller ones`);
    const identity = testUserIdentity(baseI, headI);
    const card = applyCard(full, details, identity.line);
    return {
      args: full, targets: { diff: createHash("sha256").update(details).digest("hex"), content: readDigest(c) }, card: card as unknown as Record<string, string>,
      ...(identity.raise ? { raise: identity.raise } : {}),
      // The reviewer reads the roll-up as its own field, never as part of the change (issue #1639).
      ...(commits ? { review: { productCommits: commits } } : {}),
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

/** The planner on this host: the code host's read and the product checkout. */
export function hostPlanner({ repo, instanceRepo, read, verifyRelease, notes, skills }: {
  repo: string; instanceRepo: () => string | undefined; read: (s: Source) => Promise<Read>;
  verifyRelease: (baseText: string, name: string, sha: string) => Promise<string | null>;
  notes?: (sha: string, requester: Requester | undefined, task: string | undefined) => string | undefined;
  skills?: (c: Read) => Promise<{ before: Record<string, string[]>; after: Record<string, string[]>; files: string[]; enabledTexts?: Record<string, string> }>;
}): ApplyPlanner {
  return createApplyPlanner({ instanceRepo, read, notes, skills, product: hostProduct(repo), modules: (b, h) => moduleTierState(b, h, repo), verifyRelease });
}
