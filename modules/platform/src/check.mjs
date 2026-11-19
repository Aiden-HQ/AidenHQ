// The platform check (P5, spec §3.5) at write.filed for the code host's pushes, PRs and merges: what a change to the product
// repo's own files needs, and the owner-approval records in any repo. It raises or denies, never lowers: the gate's own
// core and anything that can bypass or widen it goes to the panel, a role holder's handbook and a compose file to the
// reviewer by content, an unreadable config file is refused, and a change to the owner-approval records is the owner's.
// A product PR Dependabot opened is the reviewer's alone when it is a verified pin-only bump (the supply-chain rule).
// Pure and dependency-free: the verified facts (files, their base and head texts, a compose file's parsed documents, checks,
// Dependabot authorship, the product's half of the gate's core) come with the request as JSON.

const T = (tier, rule, reason) => ({ tier, rule, reason });
const PANEL = (rule, reason) => ({ tier: 1, rule, reason, panel: true });
const REJECT = (rule, reason) => ({ tier: 2, rule, reason, reject: true });
const same = (a, b) => String(a ?? "").toLowerCase() === String(b ?? "").toLowerCase();
const eq = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
/** A change to the owner-approval records: the owner's tap in every repo, so no PR records its own approval. */
const OWNER_APPROVAL = (repo) => T(2, "owner-approval-record", `it changes ${repo}'s ${OWNER_APPROVAL_FILE}, which holds the owner's source approvals: only the owner's own tap makes a record one`);

/**
 * The check: `{ kind, args, facts }` with `args` one branch of a push or PR, or one PR of a merge (repo, files, texts and,
 * for a merge, number, checks, headMatches, dependabot), and `facts` { productRepo, roles, gateCore } → `{ verdict: "ok" }`,
 * `gateCore` is the product's half of the gate's core (its paths, RegExps or their sources: the runner's gate-core.mjs);
 * without it a product change is refused, never judged on this half alone.
 * `texts` maps a config file to { base, head } (its text on each side, absent when it is missing there) and, for a compose
 * file, { baseDoc, headDoc } (each side parsed: an object, null when it doesn't parse, absent when missing); a compose file
 * whose documents aren't given is judged as one that doesn't parse.
 * `{ verdict: "raise", tier, panel?, rule, reason }` or `{ verdict: "deny", rule, reason }`. A change to the owner-approval
 * records is the owner's card only on its own: bundled with any other file it is denied, so one owner tap never also
 * approves gate-core, grant or other authority-expanding changes.
 */
export function check({ kind, args: item, facts = {} }) {
  const parts = productParts(kind, item ?? {}, facts);
  if (!parts.length) return { verdict: "ok" };
  const refused = parts.find((p) => p.reject);
  if (refused) return { verdict: "deny", rule: refused.rule, reason: refused.reason };
  const top = parts.reduce((a, b) => (b.tier * 2 + (b.panel ? 1 : 0) > a.tier * 2 + (a.panel ? 1 : 0) ? b : a));
  return { verdict: "raise", tier: top.tier, ...(top.panel ? { panel: true } : {}), rule: top.rule, reason: top.reason };
}

function productParts(kind, item, facts) {
  const files = Array.isArray(item.files) ? item.files : undefined;
  if (files?.includes(OWNER_APPROVAL_FILE)) return files.length === 1 ? [OWNER_APPROVAL(item.repo)] : [REJECT("owner-approval-alone", `${OWNER_APPROVAL_FILE} changes with other files: file the source approval on its own`)];
  if (!files || !same(item.repo, facts.productRepo)) return [];
  if (!Array.isArray(facts.gateCore) || !facts.gateCore.length) return [REJECT("gate-list-unknown", "the product's gate list (facts.gateCore) wasn't given: the product and the official modules are out of step; update the product")];
  const core = [...facts.gateCore.map((g) => new RegExp(g)), ...GATE_CORE];
  // A Dependabot pin bump: the reviewer's alone when every condition holds; otherwise the file rules below.
  if (kind === "github.merge" && item.dependabot === true) {
    const d = dependabotMergePart(item, `${item.repo}#${item.number ?? "?"}`);
    if (d.tier === 1) return [d];
  }
  return productFileParts(files, item.texts, facts, core);
}

/**
 * The gate's own core in the official modules (owner, 2026-11-14): authority-expanding, so the AI reviewer and a second,
 * independent reviewer on another model family must both approve (`panel`); a split goes to the owner. The product lists
 * its own paths (the runner's gate-core.mjs, passed as `facts.gateCore`), so each repo adds a gate file and its entry in one
 * PR. Here: the engines a job runs, the channels, the AI reviewer (its service, policy, planted cases and eval), the code
 * hosts, this check, the merge queue, the apps platform's and Primer's write kinds and executors, each module's copy of the
 * SDK's caller and executor sides, and graded done. Paths are as the product holds the modules (at its modules/).
 */
export const GATE_CORE = [
  // One entry per file or folder, so a renamed or moved gate file shows up as a dead entry (test/gate-coverage.test.mjs).
  // The engines that run inside a job (engine@1: their argv, env and what they pass on) and the contract and kit they share.
  /^modules\/engine-[^/]+\//,
  // The channels (privileged speaks-as-owner, lean-core 2f): they hold decision tokens and post the owner's words, so their
  // whole process is in the trusted base (channel-slack's executor posts as the bot).
  /^modules\/channel-[^/]+\//,
  // The AI reviewer (privileged reviewer, lean-core 3c): its service, its policy, its planted cases and its eval.
  /^modules\/ai-reviewer\//,
  // The code host (privileged git-credential, lean-core 3d): the GitHub App's tokens and their narrowing, host git with the
  // hardened arguments on agent clones, task workspaces and reviewed refs, the merge gate (its only GitHub writes) and the
  // git rules that tier every push, PR, merge and create_repo. The platform check (this file: the gate's core, the
  // owner-approval records, Dependabot pin-only and supply chain). The whole github module: its connections hold the owner's
  // GitHub sign-in and the official server's refused git writes (github-mcp official.ts DENY).
  /^modules\/github\//,
  // The on-server code host: bare repos, change-request refs, the checks receipt and the compare-and-swap merge.
  /^modules\/codehost-local\//,
  /^modules\/platform\//,
  // The Engineer holds the platform-engineer role: its manifest (the role's declaration), its handbook and the skills that tell it
  // how to change the fleet and the product.
  /^modules\/engineering\/module\.yaml$/,
  /^modules\/engineering\/agents\/engineer\//,
  /^modules\/engineering\/skills\/(fleet-change|dependabot|forks)\//,
  // Each module server's copy of the SDK's caller check and executor side (the product's scripts/sync-shared.mjs).
  /(^|\/)aidenhq-sdk\/caller\.ts$/,
  /(^|\/)aidenhq-sdk\/executor\.ts$/,
  // The apps platform's write kinds (their floors, cards and the tools routed into them) and its executor (which raises a
  // stateful deploy to the reviewer and checks who may change an app). The module's agent, starter and design system are not
  // gate code.
  /^modules\/apps-platform\/module\.yaml$/,
  /^modules\/apps-platform\/schemas\//,
  /^modules\/apps-platform\/apps-mcp\/src\/executor\.ts$/,
  // Primer publishing (primer.publish): its floor, card and routed tools, and the executor that publishes exactly what the
  // record carries.
  /^modules\/primer\/module\.yaml$/,
  /^modules\/primer\/connections\/primer-mcp\/src\/publish\.ts$/,
  // Graded done (lean-core 3h): the whole grading module. Its finish check decides who may close a graded task and holds it;
  // its manifest registers that check with the kernel's finish gate; its service build, the grade loop the runner hosts, and
  // every file added later sit behind the same panel (GATE_DIRS below).
  /^modules\/grading\//,
  // This repository's CI (the checks a modules merge waits on).
  /(^|\/)\.github\//,
];
/** Where gate files live: every tracked file here must match a GATE_CORE entry or be listed in OUTSIDE_GATE. A trailing
 * `/` is a prefix; anything else is an exact path. */
export const GATE_DIRS = [
  "modules/grading/",
  "modules/ai-reviewer/",
  "modules/github/",
  "modules/codehost-local/",
  "modules/platform/",
  "modules/engineering/module.yaml",
  "modules/engineering/agents/engineer/",
  "modules/engineering/skills/fleet-change/",
  "modules/engineering/skills/dependabot/",
  "modules/engineering/skills/forks/",
  "modules/apps-platform/module.yaml",
  "modules/apps-platform/schemas/",
];
/** Files in a gate dir deliberately outside the core. Adding one here is a gate-core change. */
export const OUTSIDE_GATE = [];
/** `uncovered: <file>` for a file in a gate dir that no entry matches and OUTSIDE_GATE doesn't list; `dead entry: <source>`
 * for an entry that matches no file. */
export function coverageProblems(files, core = GATE_CORE, outside = OUTSIDE_GATE, dirs = GATE_DIRS) {
  const inDir = (f) => dirs.some((d) => (d.endsWith("/") ? f.startsWith(d) : f === d));
  return [
    ...files.filter((f) => inDir(f) && !outside.includes(f) && !core.some((g) => g.test(f))).map((f) => `uncovered: ${f}`),
    ...core.filter((g) => !files.some((f) => g.test(f))).map((g) => `dead entry: ${g.source}`),
  ];
}
/**
 * The owner-approved source exceptions (review-request.mjs reads them from the base). A record says `approved_by: owner`, and code
 * cannot tell an owner's word from an agent's: only the owner's own tap on a change to this file makes a record one, so a
 * panel-approved PR can never record its own approval.
 */
export const OWNER_APPROVAL_FILE = ".github/supply-chain-source-exceptions.yaml";
/**
 * Whether a PR's commits (GitHub REST, oldest first: [{ sha, author, committer, verified }]) are all Dependabot's and end at
 * `head`: author dependabot[bot], signed by GitHub (verified) and committed by web-flow or dependabot[bot]. Any other
 * commit, the runner's own included, leaves the PR to the ordinary product rules.
 */
export function dependabotCommits(commits, head) {
  const D = "dependabot[bot]";
  return commits.length > 0 && commits.at(-1).sha === head && commits.every((c) => c.author === D && c.verified === true && ["web-flow", D].includes(c.committer));
}
/** The supply-chain job in .github/workflows/ci.yml (npm-age and pins): a Dependabot merge needs it by name, green. */
export const SUPPLY_CHAIN_CHECK = "supply-chain";
/**
 * A Dependabot PR's merge on the product repo (owner, 2026-11-13): Tier 1 (`product-dependabot-merge`) only when the runner
 * verified from the GitHub API that the PR and every commit on its head are Dependabot's (`p.dependabot`), the head is the
 * card's, every named check passed on it (none still running) with the supply-chain check among them, and every changed
 * file is a pin-only change by content (`p.texts` holds each file's base and head), no version jumping a major. Gate files
 * and `.github/workflows/` included: there only pins may move. Anything else, or anything unreadable, is Tier 2.
 */
function dependabotMergePart(p, ref) {
  const no = (rule, reason) => T(2, rule, `${ref} (Dependabot): ${reason}`);
  if (!p.headMatches) return no("head-moved", "moved since the card");
  const checks = p.checks ?? [];
  if (!checks.length) return no("no-checks", "no named checks");
  const notGreen = checks.filter((c) => !c.ok || c.pending);
  if (notGreen.length) return no("dependabot-checks", `${notGreen.map((c) => c.name).join(", ")} not green (still running counts here)`);
  if (!checks.some((c) => c.name === SUPPLY_CHAIN_CHECK)) return no("dependabot-supply-chain", `no \`${SUPPLY_CHAIN_CHECK}\` check`);
  if (!p.files.length) return no("unknown-files", "changes no files");
  for (const f of p.files) {
    const why = pinOnly(f, p.texts?.[f]);
    if (why) return no("dependabot-not-pin-only", `${f}: ${why}`);
  }
  return T(1, "product-dependabot-merge", `${ref}: a Dependabot PR (author and every commit verified), pin-only changes in ${p.files.length} file${p.files.length === 1 ? "" : "s"}, no major jump, every named check green on the exact head (${SUPPLY_CHAIN_CHECK} included)`);
}
const LOCKFILE = /(^|\/)package-lock\.json$/;
const PACKAGE_JSON = /(^|\/)package\.json$/;
const DOCKERFILE = /(^|\/)(Dockerfile[^/]*|[^/]+\.Dockerfile)$/;
const WORKFLOW = /^\.github\/workflows\/[^/]+\.ya?ml$/;
/** Why `f` is not a pin-only change (a string), or undefined when it is. `t`: { base, head } texts; missing or one-sided fails. */
export function pinOnly(f, t) {
  const kind = LOCKFILE.test(f) ? lockfileWhy : PACKAGE_JSON.test(f) ? packageJsonWhy : DOCKERFILE.test(f) ? dockerfileWhy : WORKFLOW.test(f) ? workflowWhy : COMPOSE.test(f) ? composeWhy : undefined;
  if (!kind) return "not a lockfile, package.json, Dockerfile, compose file or workflow";
  if (typeof t?.base !== "string" || typeof t?.head !== "string") return "couldn't read it on both sides (added, removed or unread)";
  try {
    return kind === composeWhy ? composeWhy(t.baseDoc, t.headDoc) : kind(t.base, t.head);
  } catch {
    return "doesn't parse";
  }
}
/**
 * The major of a version or tag, for "no major jump": its first number, or `0.<minor>` below 1 (semver: 0.x minors break).
 * Undefined without a number (a tag such as `latest`): a change from such a tag fails closed.
 */
export function majorOf(v) {
  const m = /(\d+)(?:\.(\d+))?/.exec(String(v ?? ""));
  if (!m) return undefined;
  return Number(m[1]) === 0 ? `0.${m[2] ?? ""}` : String(Number(m[1]));
}
const majorJump = (a, b) => a !== b && (majorOf(a) === undefined || majorOf(a) !== majorOf(b));
/** A plain version (exact, or a ^/~ range on one version): no npm: alias, git, URL, file: or dist-tag. */
const PLAIN_VERSION = /^[\^~]?\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;
const DEP_MAPS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];
const withoutDeps = (o) => Object.fromEntries(Object.entries(o ?? {}).filter(([k]) => !DEP_MAPS.includes(k)));
/** Dependency maps: the same names on both sides, only plain versions changing, no major jump. */
function depMapsWhy(b, h) {
  for (const k of DEP_MAPS) {
    const [bm, hm] = [b?.[k] ?? {}, h?.[k] ?? {}];
    if (!eq(Object.keys(bm).sort(), Object.keys(hm).sort())) return `${k}: a dependency added or removed`;
    for (const name of Object.keys(hm)) {
      if (bm[name] === hm[name]) continue;
      if (!PLAIN_VERSION.test(String(bm[name])) || !PLAIN_VERSION.test(String(hm[name]))) return `${k}.${name}: not a plain version (${hm[name]})`;
      if (majorJump(bm[name], hm[name])) return `${k}.${name}: major jump ${bm[name]} → ${hm[name]}`;
    }
  }
  return undefined;
}
function packageJsonWhy(base, head) {
  const [b, h] = [JSON.parse(base), JSON.parse(head)];
  if (!eq(withoutDeps(b), withoutDeps(h))) return "changes more than dependency versions (scripts, overrides or another field)";
  return depMapsWhy(b, h);
}
/**
 * package-lock.json (v2/v3): only `packages` changes; its root entry as package.json; every new or changed entry resolves
 * from registry.npmjs.org with an integrity hash (bundled entries excepted), gains no install script and is no link; a
 * version on both sides never jumps a major (transitive entries included).
 */
function lockfileWhy(base, head) {
  const [b, h] = [JSON.parse(base), JSON.parse(head)];
  if (!(b.lockfileVersion >= 2) || b.lockfileVersion !== h.lockfileVersion) return "not a v2/v3 lockfile on both sides";
  const { packages: bp = {}, ...bRest } = b;
  const { packages: hp = {}, ...hRest } = h;
  if (!eq(bRest, hRest)) return "changes more than `packages`";
  for (const [path, e] of Object.entries(hp)) {
    const was = bp[path];
    if (eq(was, e)) continue;
    if (path === "") {
      if (!was || !eq(withoutDeps(was), withoutDeps(e))) return "the root entry changes more than dependency versions";
      const why = depMapsWhy(was, e);
      if (why) return `root: ${why}`;
      continue;
    }
    if (e.link || was?.link) return `${path}: a link entry changes`;
    if ("name" in e) return `${path}: an alias (\`name\` ${e.name})`;
    if (Boolean(e.inBundle) !== Boolean(was?.inBundle) || e.inBundle) return `${path}: a bundled entry changes`;
    if (e.hasInstallScript && !was?.hasInstallScript) return `${path}: gains an install script`;
    // The tarball of exactly this package and version (the name from the path key): no other package, host or alias.
    const name = path.split("node_modules/").pop();
    if (!/^(@[\w.-]+\/)?[\w.-]+$/.test(name) || e.resolved !== `https://registry.npmjs.org/${name}/-/${name.split("/").pop()}-${e.version}.tgz` || !e.integrity) return `${path}: not resolved to ${name}@${e.version} on registry.npmjs.org with an integrity hash`;
    if (was && was.version !== e.version && majorJump(was.version, e.version)) return `${path}: major jump ${was.version} → ${e.version}`;
  }
  return undefined;
}
/** Line by line: the same number of lines, and `ok(baseLine, headLine)` (a reason when not) for every changed one. */
function linesWhy(base, head, ok) {
  const [b, h] = [base.replace(/\r\n/g, "\n").split("\n"), head.replace(/\r\n/g, "\n").split("\n")];
  if (b.length !== h.length) return "lines added or removed";
  for (let i = 0; i < b.length; i++) {
    if (b[i] === h[i]) continue;
    const why = ok(b[i], h[i]);
    if (why) return `line ${i + 1}: ${why}`;
  }
  return undefined;
}
const tagOf = (ref) => /:([^/:]+)$/.exec(String(ref ?? "").replace(/@sha256:[0-9a-f]+$/, ""))?.[1] ?? "";
/** The same image repository, and no major jump between the tags. */
const imageWhy = (a, b) => (imageRepo(a) !== imageRepo(b) ? `another image (${imageRepo(a)} → ${imageRepo(b)})` : majorJump(tagOf(a), tagOf(b)) ? `major jump ${tagOf(a)} → ${tagOf(b)}` : undefined);
const FROM = /^(\s*FROM\s+(?:--platform=\S+\s+)?)(\S+)((?:\s+AS\s+\S+)?\s*)$/i;
/** A Dockerfile: only FROM lines change, each on the same image, with the same flags and stage name. */
function dockerfileWhy(base, head) {
  return linesWhy(base, head, (bl, hl) => {
    const [bm, hm] = [FROM.exec(bl), FROM.exec(hl)];
    if (!bm || !hm) return "not a FROM line";
    if (bm[1] !== hm[1] || bm[3] !== hm[3]) return "the FROM line's flags or stage name change";
    return imageWhy(bm[2], hm[2]);
  });
}
const USES = /^(\s*(?:-\s+)?uses:\s+)([\w.-]+\/[\w./-]+)@([0-9a-f]{40})(\s+#\s*)(\S+)\s*$/;
/** A workflow: only `uses: owner/action@<sha> # tag` lines change, each on the same action and step, still SHA-pinned. */
function workflowWhy(base, head) {
  return linesWhy(base, head, (bl, hl) => {
    const [bm, hm] = [USES.exec(bl), USES.exec(hl)];
    if (!bm || !hm) return "not a SHA-pinned `uses:` line";
    if (bm[1] !== hm[1] || bm[2] !== hm[2]) return `another action or step (${bm[2]} → ${hm[2]})`;
    return majorJump(bm[5], hm[5]) ? `major jump ${bm[5]} → ${hm[5]}` : undefined;
  });
}
/** A compose file: the image-bump rule (composeParts), and no major jump in any service's image. */
function composeWhy(b, h) {
  if (composeParts("", b, h)[0].rule !== "product-image-bump") return "changes more than image tags or digests";
  for (const [name, svc] of Object.entries(h.services ?? {})) {
    const was = b.services?.[name]?.image;
    const why = svc?.image === was ? undefined : imageWhy(was, svc?.image);
    if (why) return `${name}: ${why}`;
  }
  return undefined;
}
/**
 * The product files that need more than one reviewer's plain read: the gate's core (panel), a role holder's handbook
 * (Tier 1, named), and a compose file judged by content (a module.yaml is judged by the module rules, tiers.mjs).
 * `texts` maps those config files to { base, head } (text, or undefined when absent on that side); a config file without
 * an entry couldn't be read: refused, to ask again.
 */
function productFileParts(files, texts = {}, s, core) {
  const parts = [];
  for (const f of files) {
    let m;
    if (core.some((g) => g.test(f))) parts.push(PANEL("gate-core", `it changes the gate's own core (${f})`));
    else if ((m = /^modules\/[^/]+\/agents\/([a-z0-9][a-z0-9-]*)\/AGENTS\.md$/.exec(f)) && (s.roles?.[m[1]] ?? []).length) parts.push(T(1, "role-handbook", `handbook of ${m[1]}, which holds a role`));
    else if (COMPOSE.test(f)) {
      const t = texts?.[f];
      parts.push(...(t ? composeParts(f, t.baseDoc, t.headDoc) : [REJECT("unknown-content", `couldn't read ${f} on both sides; try again`)]));
    }
  }
  return parts;
}
/** Any compose file in the product (the root's; modules ship none, so one appearing under modules/ is judged the same way). */
export const COMPOSE = /(^|\/)(docker-)?compose[^/]*\.ya?ml$/;
/** An image reference without its tag and digest: `registry/name`. */
export const imageRepo = (ref) => String(ref ?? "").replace(/@sha256:[0-9a-f]+$/, "").replace(/:[^/:]+$/, "");
/**
 * A compose file: an image bump (only `services.*.image` tags or digests change, same image repository, same services) is
 * the reviewer's; volumes, privileges, networks, capabilities, devices, env, a new service or another image the owner's.
 */
function composeParts(f, b, h) {
  if (!b || !h) return [PANEL("product-compose", `${f} doesn't parse, or is added or removed`)];
  const noImages = (c) => ({ ...c, services: Object.fromEntries(Object.entries(c.services ?? {}).map(([k, v]) => [k, { ...(v ?? {}), image: imageRepo(v?.image) }])) });
  return eq(noImages(b), noImages(h)) ? [T(1, "product-image-bump", `${f}: image tags or digests only`)] : [PANEL("product-compose", `${f} changes more than image tags or digests (volumes, privileges, network, env, services or another image)`)];
}
