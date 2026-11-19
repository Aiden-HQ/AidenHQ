// Release updates (docs/design/release-updates.md). An install from a release (instance.yaml `release:` from the official
// distro repo) moves to the next release through the one way every pin moves: a kernel.apply record. This file only finds and
// prepares the release; the kernel files it, tiers it (kernel/src/apply-tier.ts: a move along the same source is the AI
// reviewer's while settings.auto_update is on, the owner's otherwise), the code host lands it and the kernel's apply executor
// runs it, as for any other apply. An instance that pins product by hand has no `release:` and is never touched.
// - The source is fixed: the official distro and kernel repositories on GitHub, over https (the official modules are the
//   kernel commit's own modules/ since 2026-11-18). Nothing in a release file or instance.yaml can point the updater elsewhere.
// - Only graduated releases install: published and not a pre-release (GitHub's Releases API). The distro publishes each cut as a
//   pre-release and graduates it once a test instance upgraded to it and passed its checks (distro graduate.yml). The one
//   exception is that test instance: AIDENHQ_UPDATE_CANDIDATE=<release> on the CLI check (`check <release> <by>`, run by the
//   host's own shell, never by the kernel, which strips it) prepares exactly that pre-release, marked in the state file, and the
//   planner's `verify` accepts it only while the state names that release and commit. Every other check stays.
// - Before anything is filed, a release is verified: its tag's commit is on the distro's main; its file names the official
//   kernel and only ghcr.io/aiden-hq images, and resolves (release.ts) against the instance it would pin; the kernel sha is on
//   its repository's main and descends from what runs now (no downgrade, and the name must be newer); the published asset is
//   the same file with the release workflow's `tested` stamp, and that stamp names a release.yml run on the tag's commit.
// - The check (`node kernel/src/updates.ts check`, which the kernel runs hourly as a child process, and at once on Update now)
//   prepares a release that should go now: auto-updates on and night in the owner's timezone, or the owner's Update now. It
//   puts the verified kernel on the product checkout's origin main (a local mirror gets a fast-forward push: the planner reads
//   the product move there), commits the pin (product: and release:, dropping an obsolete `aidenhq` marketplace entry) on the
//   instance repo's branch release/<name>, and records it as `ready`.
// - The kernel (createUpdates) files `ready` as a kernel.apply on a task of its own and follows the record: installed, or
//   failed (a failed apply leaves the pin landed, as any apply does: apply's own health check put the host back on the last
//   good generation). The night never files a failed release again. Each event is told to the owner once.
//   node kernel/src/updates.ts check [<release> <by>]   (the kernel) find, verify and prepare; with a release: Update now
//     (AIDENHQ_UPDATE_CANDIDATE=<release> on the host's own run: that pre-release, for graduation's test instance)
//   node kernel/src/updates.ts verify <name> <distro sha> < base instance.yaml   (the apply planner) the verified pin, as JSON
//   node kernel/src/updates.ts pin <name> <distro sha>  (ops/setup.sh, the installer run again) move the pin to that release
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import type { DatabaseSync } from "node:sqlite";
import YAML, { Scalar } from "yaml";
import { resolveRelease } from "../../scripts/compiler/release.ts";
import { OFFICIAL, repoAt, type Fetch, type Where } from "../../scripts/compiler/sources.ts";

type Dict = Record<string, unknown>;
export const DISTRO = "Aiden-HQ/aidenhq-distro";
export const KERNEL = "Aiden-HQ/AidenHQ";
const GITHUB = "https://github.com";
const NAME = /^\d{4}\.\d{1,2}(\.\d+){0,2}$/;
const SHA = /^[0-9a-f]{40}$/;
/** The night, in the owner's timezone: an automatic install starts at or after FROM and before TO. */
export const NIGHT = { from: 2, to: 5 };
const isMap = (v: unknown): v is Dict => !!v && typeof v === "object" && !Array.isArray(v);

/** A release that failed verification: never installed, and the owner is told once. Anything else (network) is retried. */
export class Refused extends Error {}

/** The host's candidate exception (graduation's test instance): read only by the CLI's check, from the shell that runs it. */
export const CANDIDATE_ENV = "AIDENHQ_UPDATE_CANDIDATE";

/** Release names in order: 2026.11 < 2026.11.2 < 2026.11.18 (a nightly) < 2026.11.18.1 (its day's second cut) < 2026.11.19. */
export function compareRelease(a: string, b: string): number {
  const [x, y] = [a, b].map((s) => s.split(".").map(Number));
  for (let i = 0; i < 4; i++) { const d = (x![i] ?? 0) - (y![i] ?? 0); if (d) return Math.sign(d); }
  return 0;
}

/** The release an instance follows, when it follows one from the official distro repo; null otherwise (a hand-pinned instance). */
export function followed(instance: Dict): { name: string; sha: string } | null {
  const r = instance.release;
  if (!isMap(r) || !isMap(r.source) || r.source.source !== "github" || r.source.repo !== DISTRO) return null;
  return typeof r.name === "string" && NAME.test(r.name) && typeof r.sha === "string" && SHA.test(r.sha) ? { name: r.name, sha: r.sha } : null;
}

/** settings.auto_update: on unless the owner turned it off. */
export const autoOn = (instance: Dict) => (isMap(instance.settings) ? instance.settings.auto_update : undefined) !== "off";

/** Whether `at` is in the night of `timezone` (an unknown zone reads as UTC). */
export function atNight(at: Date, timezone: unknown): boolean {
  let hour: number;
  try { hour = Number(new Intl.DateTimeFormat("en-GB", { hour: "numeric", hourCycle: "h23", timeZone: String(timezone || "UTC") }).format(at)); } catch { hour = at.getUTCHours(); }
  return hour >= NIGHT.from && hour < NIGHT.to;
}


export type Deps = {
  /** Where the official repositories are: https://github.com (a test passes a local folder holding Aiden-HQ/<repo>.git). */
  base: string;
  /** A JSON document over https (the release's published asset, its workflow run). */
  download: (url: string) => Promise<unknown>;
  /** The sources cache (no credentials: every official repository is public). */
  fetch: Fetch;
  /** The instance checkout (AIDENHQ_INSTANCE_DIR) and the product checkout. */
  inst: string;
  product: string;
  /** The updater's state (state.json) and the board's display copy (updates.json), when there is one. */
  dir: string;
  board?: string;
  now?: () => Date;
};

export type Candidate = {
  name: string; sha: string; kernel: string; notes: string[]; compare: string; images: number;
  from: { name: string; product: string };
};
/** A release prepared for filing: its pin commit on the instance repo's branch; `candidate`: the distro commit of a pre-release the host asked for. */
export type Ready = { release: string; kernel: string; from: string; branch: string; sha: string; by: string; notes: string[]; compare: string; candidate?: string };
type Last = { release: string; outcome: "installed" | "failed"; why?: string; at: string; by: string };
export type State = {
  current?: { name: string; product: string } | null;
  auto?: boolean;
  timezone?: string;
  checkedAt?: string;
  available?: Candidate | null;
  error?: string;
  last?: Last;
  failed?: string[];
  /** Prepared by the check, filed by the kernel. */
  ready?: Ready;
  /** Filed: its kernel.apply record and task, followed by the kernel until the record ends. */
  flight?: Ready & { record: string; task: string };
  /** What the kernel tells the owner, each once (by id); the newest 20. */
  events?: { id: string; text: string }[];
};

const url = (d: Pick<Deps, "base">, repo: string) => `${d.base}/${repo}.git`;
const at = (d: Pick<Deps, "base">, repo: string, sha: string): Where => ({ url: url(d, repo), path: "", sha, owned: true });
const git = (cwd: string, args: string[], input?: string) =>
  execFileSync("git", ["-c", "protocol.allow=never", "-c", "protocol.https.allow=always", "-c", "protocol.file.allow=always", "-c", "credential.helper=", ...args], {
    cwd, encoding: "utf8", input, timeout: 120_000, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_DIR: undefined, GIT_WORK_TREE: undefined },
  });
/** Whether commit a is an ancestor of b in repo: false when it isn't (or a isn't there at all); any other git failure throws. */
function isAncestor(repo: string, a: string, b: string): boolean {
  if (spawnSync("git", ["--git-dir", repo, "cat-file", "-e", `${a}^{commit}`]).status !== 0) return false;
  const r = spawnSync("git", ["--git-dir", repo, "merge-base", "--is-ancestor", a, b], { encoding: "utf8" });
  if (r.status === 0 || r.status === 1) return r.status === 0;
  throw new Error(`git merge-base: ${String(r.stderr).trim().slice(0, 200)}`);
}
/**
 * The cache repository holding `w.sha`, with the repository's main fetched, and whether the sha is on it. A sha the repository
 * doesn't have is a refusal; a fetch that fails (the network, GitHub) throws a plain error, retried at the next run.
 */
function onMain(d: Pick<Deps, "fetch">, w: Where, what: string): string {
  let repo: string;
  try { repo = repoAt(w, d.fetch); } catch (e) { if (/has no commit/.test(String((e as Error).message))) throw new Refused(`${what} ${w.sha.slice(0, 12)} isn't in ${w.url}`); throw e; }
  git(tmpdir(), ["--git-dir", repo, "fetch", "-q", "--no-tags", "--no-recurse-submodules", "--", w.url, "+refs/heads/main:refs/remotes/official/main"]);
  if (!isAncestor(repo, w.sha, "refs/remotes/official/main")) throw new Refused(`${what} ${w.sha.slice(0, 12)} isn't on ${w.url.replace(/^.*\/([^/]+\/[^/]+?)(\.git)?$/, "$1")}'s main`);
  return repo;
}
/** Plain text from a release file or an apply's output: one line, no control or format characters, never an HTML comment, bounded. */
const plain = (v: unknown, n = 300) => String(v ?? "").replace(/[\p{Cc}\p{Cf}]+/gu, " ").replace(/<!/g, "‹!").replace(/-->/g, "--›").trim().slice(0, n);

/** The distro repo's release tags newer than `than`, newest first, each with the commit it names. */
export function newerTags(d: Pick<Deps, "base">, than: string): { name: string; sha: string }[] {
  const tags = new Map<string, string>();
  for (const line of git(tmpdir(), ["ls-remote", "--tags", "--", url(d, DISTRO)]).split("\n")) {
    const m = /^([0-9a-f]{40})\trefs\/tags\/([^\s^]+)(\^\{\})?$/.exec(line);
    if (m && NAME.test(m[2]!) && (m[3] || !tags.has(m[2]!))) tags.set(m[2]!, m[1]!);
  }
  return [...tags.keys()].filter((n) => compareRelease(n, than) > 0).sort(compareRelease).reverse().map((name) => ({ name, sha: tags.get(name)! }));
}

/** The distro's graduated releases: published and not pre-releases, every page of GitHub's Releases API. A failed call throws a plain error (retried). */
export async function stableReleases(d: Pick<Deps, "download">): Promise<Set<string>> {
  const out = new Set<string>();
  for (let page = 1; ; page++) {
    const rows = await d.download(`https://api.github.com/repos/${DISTRO}/releases?per_page=100&page=${page}`);
    if (!Array.isArray(rows)) throw new Error(`the releases API's page ${page} isn't a list`);
    for (const r of rows) if (isMap(r) && r.draft === false && r.prerelease === false && typeof r.tag_name === "string") out.add(r.tag_name);
    if (rows.length < 100) return out;
  }
}

/** The state's own mark that the host asked for pre-release `name` at distro commit `sha` (ready or filed): the planner's exception. */
export const candidateMarked = (s: State, name: string, sha: string) => [s.ready, s.flight].some((r) => r?.release === name && r.candidate === sha);

/**
 * instance.yaml's text moved to a release: product: and release:, comments kept. The `aidenhq` marketplace entry an instance
 * from before 2026-11-18 carries is dropped (the official modules are the kernel's own modules/), and `marketplaces:` with it
 * when that was its only entry.
 */
export function pinText(text: string, file: Dict, name: string, sha: string): string {
  const doc = YAML.parseDocument(text);
  const quoted = (s: string) => Object.assign(new Scalar(s), { type: Scalar.QUOTE_DOUBLE });
  doc.set("product", file.kernel);
  if (!doc.has("release")) doc.set("release", doc.createNode({ name, source: { source: "github", repo: DISTRO }, sha }, { flow: true }));
  doc.setIn(["release", "name"], quoted(name));
  doc.setIn(["release", "sha"], sha);
  return dropOfficial(doc);
}

/** The document without an `aidenhq` marketplace entry (nor an emptied `marketplaces:`), as text. */
function dropOfficial(doc: YAML.Document): string {
  const ms = doc.get("marketplaces") as YAML.YAMLSeq | undefined;
  if (YAML.isSeq(ms)) {
    ms.items = ms.items.filter((m) => !(YAML.isMap(m) && m.get("name") === OFFICIAL));
    if (!ms.items.length) doc.delete("marketplaces");
  }
  return doc.toString({ lineWidth: 0 });
}

/**
 * The release `name` at distro commit `sha`, checked as an update of `instance` (its instance.yaml `text`): every check
 * before anything moves. Throws Refused when the release fails one; any other error is the network's, retried next time.
 * `candidate`: the host asked for this pre-release (graduation's test instance); it waives only the graduated check.
 */
export async function verify(d: Pick<Deps, "base" | "fetch" | "download">, text: string, name: string, sha: string, candidate = false): Promise<Candidate & { text: string }> {
  const instance = (YAML.parse(text) ?? {}) as Dict;
  const cur = followed(instance);
  if (!cur) throw new Refused("this instance doesn't follow a release from the official distro repo");
  if (!NAME.test(name) || !SHA.test(sha)) throw new Refused(`${plain(name, 40)} isn't a release name with a commit`);
  if (compareRelease(name, cur.name) <= 0) throw new Refused(`${name} isn't newer than ${cur.name}: downgrades are refused`);
  // Graduated: published and not a pre-release (a missing release is the API's 404, a plain error: retried).
  const rel = await d.download(`https://api.github.com/repos/${DISTRO}/releases/tags/${name}`);
  if (!isMap(rel) || rel.tag_name !== name || rel.draft !== false) throw new Refused(`${name} isn't a published release`);
  if (rel.prerelease !== false && !candidate) throw new Refused(`${name} is a pre-release: it hasn't graduated yet`);
  const distro = onMain(d, at(d, DISTRO, sha), `${name}'s commit`);
  let file: Dict;
  try { file = JSON.parse(execFileSync("git", ["--git-dir", distro, "show", `${sha}:releases/${name}.json`], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })) as Dict; } catch { throw new Refused(`${name} has no readable releases/${name}.json at ${sha.slice(0, 12)}`); }
  // The fixed sources: a release file can't point the kernel or the images anywhere else (a `marketplace` or `modules` key, from
  // a release before 2026-11-18, is not read).
  if (file.release !== name) throw new Refused(`releases/${name}.json says it is ${plain(file.release, 40)}`);
  if ((file.kernel_repo ?? KERNEL) !== KERNEL) throw new Refused(`${name} names the kernel ${plain(file.kernel_repo, 100)}, not ${KERNEL}`);
  const images = isMap(file.images) ? Object.values(file.images) : [];
  if (images.some((i) => typeof i !== "string" || !i.startsWith("ghcr.io/aiden-hq/"))) throw new Refused(`${name} names an image outside ghcr.io/aiden-hq`);
  // What the instance would pin, resolved as the apply will (shapes, shas, product: = kernel).
  try { resolveRelease(file, (YAML.parse(pinText(text, file, name, sha)) ?? {}) as Dict); } catch (e) { throw new Refused((e as Error).message); }
  const kernel = String(file.kernel);
  const product = String(instance.product ?? "");
  const kernelRepo = onMain(d, at(d, KERNEL, kernel), `${name}'s kernel`);
  if (!isAncestor(kernelRepo, product, kernel)) throw new Refused(`${name}'s kernel ${kernel.slice(0, 12)} doesn't descend from the running product ${product.slice(0, 12)}`);
  const next = pinText(text, file, name, sha);
  // The release workflow's stamp: the published asset is this file with `tested` written, from a release.yml run on this commit.
  const asset = await d.download(`${GITHUB}/${DISTRO}/releases/download/${name}/${name}.json`);
  const bare = (f: unknown) => { const { tested: _t, todo: _d, ...rest } = isMap(f) ? f : {}; return rest; };
  if (!isDeepStrictEqual(bare(asset), bare(file))) throw new Refused(`${name}'s published release file isn't the one at its tag`);
  const tested = isMap(asset) && isMap(asset.tested) ? asset.tested : {};
  const run = /^https:\/\/github\.com\/Aiden-HQ\/aidenhq-distro\/actions\/runs\/(\d{1,20})$/.exec(String(tested.ci_run ?? ""));
  if (!run || !Array.isArray(tested.suites) || !tested.suites.length) throw new Refused(`${name} has no tested stamp from the release workflow`);
  const r = await d.download(`https://api.github.com/repos/${DISTRO}/actions/runs/${run[1]}`);
  // A run still going (publish is one of its jobs) is checked again next time. The run is the tag's own: a push of the tag, or a
  // dispatch on the tag (the nightly's: a tag pushed with GITHUB_TOKEN starts no workflow), never a branch run on that commit.
  if (isMap(r) && r.status !== "completed") throw new Error(`${name}'s release run is still running`);
  const onTag = isMap(r) && (r.event === "push" || (r.event === "workflow_dispatch" && r.head_branch === name));
  if (!isMap(r) || r.path !== ".github/workflows/release.yml" || r.head_sha !== sha || !onTag || r.conclusion !== "success") throw new Refused(`${name}'s tested stamp doesn't name a successful release run on its commit`);
  const notes = (Array.isArray(file.notes) ? file.notes : typeof file.notes === "string" ? [file.notes] : []).slice(0, 20).map((n) => plain(n)).filter(Boolean);
  return { name, sha, kernel, notes, compare: `${GITHUB}/${KERNEL}/compare/${product.slice(0, 12)}...${kernel.slice(0, 12)}`, images: images.length, from: { name: cur.name, product }, text: next };
}

// ------------------------------------------------------------------------------------------------ state

export const readState = (dir: string): State => { try { return JSON.parse(readFileSync(join(dir, "state.json"), "utf8")) as State; } catch { return {}; } };
export function writeState(d: Pick<Deps, "dir" | "board">, s: State) {
  const put = (f: string, v: unknown) => { mkdirSync(join(f, ".."), { recursive: true }); writeFileSync(`${f}.tmp`, `${JSON.stringify(v, null, 2)}\n`); renameSync(`${f}.tmp`, f); };
  put(join(d.dir, "state.json"), s);
  // The board's copy: what it shows, nothing it could act on.
  if (d.board) put(d.board, { current: s.current ?? null, auto: s.auto ?? null, timezone: s.timezone ?? null, checkedAt: s.checkedAt ?? null, available: s.available ? { name: s.available.name, notes: s.available.notes, compare: s.available.compare } : null, error: s.error ?? null, last: s.last ?? null });
}
const event = (s: State, id: string, text: string) => { s.events = [...(s.events ?? []).filter((e) => e.id !== id), { id, text }].slice(-20); };

/** instance.yaml on the instance's main, as text (fetched first). */
function instanceText(inst: string) {
  git(inst, ["fetch", "-q", "origin", "main"]);
  return git(inst, ["show", "origin/main:instance.yaml"]);
}

export type Asked = { release: string; by: string } | null;

/**
 * The check: the newest release newer than the one followed that passes every check (a refused one is said once and the next
 * older is tried; a network error stops the check, retried at the next run). Records it, and prepares it for filing when it
 * goes now: the owner asked for it (Update now), or auto-updates are on, it is night and it never failed here. Nothing is
 * prepared while another release is ready or filed.
 */
export async function check(d: Deps, asked: Asked = null, candidate = ""): Promise<State> {
  const now = (d.now ?? (() => new Date()))();
  const s = readState(d.dir);
  const text = instanceText(d.inst);
  const instance = (YAML.parse(text) ?? {}) as Dict;
  const cur = followed(instance);
  s.checkedAt = now.toISOString();
  s.current = cur ? { name: cur.name, product: String(instance.product ?? "") } : null;
  s.auto = autoOn(instance);
  s.timezone = String((isMap(instance.settings) && instance.settings.timezone) || "UTC");
  delete s.error;
  s.available = null;
  let next = "";
  if (cur) {
    try {
      // Graduated releases only, never said to the owner: a pre-release is a cut still being tested (or one that failed it).
      // The host's candidate run looks at that one tag alone.
      const stable = candidate ? null : await stableReleases(d);
      const tags = newerTags(d, cur.name).filter((t) => (stable ? stable.has(t.name) : t.name === candidate));
      if (candidate && !tags.length) s.error = `${plain(candidate, 40)} isn't a release tag newer than ${cur.name}`;
      for (const tag of tags) {
        try {
          const { text: pinned, ...c } = await verify(d, text, tag.name, tag.sha, !!candidate);
          if (!(s.events ?? []).some((e) => e.id === `available:${c.name}`)) event(s, `available:${c.name}`, s.auto
            ? `AidenHQ ${c.name} is available. It is filed for install tonight between ${NIGHT.from}:00 and ${NIGHT.to}:00 (${s.timezone}), for the AI reviewer; to file it now or see what changed, open Settings > Instance.`
            : `AidenHQ ${c.name} is available. Auto-updates are off: file it from Settings > Instance (Update now), where what changed is listed; it installs on your approval.`);
          s.available = c;
          next = pinned;
          break;
        } catch (e) {
          if (!(e instanceof Refused)) throw e;
          s.error = `${tag.name} was refused: ${plain(e.message)}`;
          event(s, `refused:${tag.name}`, `AidenHQ ${tag.name} was published but failed this server's checks (${plain(e.message, 200)}), so it won't be installed. Nothing changed here.`);
        }
      }
    } catch (e) { s.error = plain((e as Error).message); }
  }
  const a = s.available;
  const busy = s.ready ?? s.flight;
  const by = !a || busy ? null : asked?.release === a.name ? String(asked.by).slice(0, 100)
    : s.auto && atNight(now, s.timezone) && !(s.failed ?? []).includes(a.name) ? "auto-update" : null;
  if (asked && !by) event(s, `now:${now.toISOString()}`, `Update now didn't start: ${busy ? `${busy.release} is already being installed` : s.error ?? `${plain(asked.release, 40)} isn't the release available any more`}. Nothing changed.`);
  if (a && by) {
    try {
      s.ready = { ...prepare(d, a, text, next, by), ...(candidate ? { candidate: a.sha } : {}) };
    } catch (e) {
      s.error = plain((e as Error).message);
      if (e instanceof Refused) event(s, `refused:${a.name}`, `AidenHQ ${a.name} failed this server's checks when it was prepared (${plain(e.message, 200)}), so it won't be installed. Nothing changed here.`);
      else if (asked) event(s, `now:${now.toISOString()}`, `Update now didn't start: ${plain((e as Error).message, 200)}. Nothing changed; try again in a while.`);
    }
  }
  writeState(d, s);
  return s;
}

/** The verified kernel commit on the product checkout's origin main, where the planner reads the move: GitHub has it, a local mirror gets it pushed. */
function landKernel(d: Pick<Deps, "base" | "fetch" | "product">, kernel: string) {
  const origin = git(d.product, ["remote", "get-url", "origin"]).trim();
  if (origin.replace(/\.git$/, "") === url(d, KERNEL).replace(/\.git$/, "")) return;
  if (!origin.startsWith("/")) throw new Refused(`the product checkout's origin is ${plain(origin, 200)}, not ${KERNEL} or a local mirror`);
  // A fast-forward only (no force): the mirror's main never moves back or sideways.
  git(d.product, ["--git-dir", repoAt(at(d, KERNEL, kernel), d.fetch), "push", "-q", "--", origin, `${kernel}:refs/heads/main`]);
}

/** A commit of instance.yaml on the instance repo's `branch`, made in a temporary clone of its main and pushed. Returns the commit. */
function commitOn(inst: string, branch: string, message: string, change: (clone: string) => void): string {
  const origin = git(inst, ["remote", "get-url", "origin"]).trim();
  const tmp = mkdtempSync(join(tmpdir(), "aidenhq-update-"));
  try {
    git(tmp, ["clone", "-q", "--", origin, "c"]);
    const c = join(tmp, "c");
    change(c);
    git(c, ["-c", "user.name=AidenHQ updates", "-c", "user.email=updates@aidenhq.invalid", "commit", "-q", "-m", message, "--", "instance.yaml"]);
    // main is only ever fast-forwarded (setup's bootstrap); a release branch is this updater's own, so a new preparation replaces it.
    git(c, ["push", "-q", ...(branch === "main" ? [] : ["--force"]), "origin", `HEAD:refs/heads/${branch}`]);
    return git(c, ["rev-parse", "HEAD"]).trim();
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

/** The release, ready to file: its kernel on the product origin's main, its pin committed on release/<name> from the instance's main. */
function prepare(d: Deps, c: Candidate, text: string, next: string, by: string): Ready {
  landKernel(d, c.kernel);
  const branch = `release/${c.name}`;
  const sha = commitOn(d.inst, branch, `update: AidenHQ ${c.name}\n\nFrom ${c.from.name}: product ${c.kernel}, release ${c.name}.\nBy ${by}. What changed: ${c.compare}`, (clone) => {
    if (readFileSync(join(clone, "instance.yaml"), "utf8") !== text) throw new Error("instance.yaml moved while the release was checked; it waits for the next check");
    writeFileSync(join(clone, "instance.yaml"), next);
  });
  return { release: c.name, kernel: c.kernel, from: c.from.name, branch, sha, by, notes: c.notes, compare: c.compare };
}

/**
 * The installer run again (ops/setup.sh on an existing instance): the pin moves to the release the installer verified (its
 * baked digest), when it is newer than what the instance follows; the same release is nothing to do, an older one refused.
 * Only the release file is read here (the installer checked the rest); setup's own apply follows.
 */
export function pinTo(d: Pick<Deps, "base" | "fetch" | "inst">, name: string, sha: string, product: string): string {
  const text = instanceText(d.inst);
  const instance = (YAML.parse(text) ?? {}) as Dict;
  const cur = followed(instance);
  if (!cur) return "this instance pins its product by hand: left as it is";
  if (compareRelease(name, cur.name) < 0) throw new Refused(`this server runs ${cur.name}, newer than ${name}: downgrades are refused`);
  if (compareRelease(name, cur.name) === 0) {
    // A repair of an instance from before 2026-11-18: its obsolete `aidenhq` marketplace entry goes, alone in its commit.
    if (!(Array.isArray(instance.marketplaces) ? instance.marketplaces : []).some((m) => isMap(m) && m.name === OFFICIAL)) return `already on ${name}`;
    const dropped = dropOfficial(YAML.parseDocument(text));
    commitOn(d.inst, "main", `update: AidenHQ ${name}: the official modules are the product's own (the installer)`, (clone) => writeFileSync(join(clone, "instance.yaml"), dropped));
    return `already on ${name}; instance.yaml now pins it without the obsolete ${OFFICIAL} marketplace entry`;
  }
  const distro = repoAt(at(d, DISTRO, sha), d.fetch);
  const file = JSON.parse(execFileSync("git", ["--git-dir", distro, "show", `${sha}:releases/${name}.json`], { encoding: "utf8" })) as Dict;
  if (file.kernel !== product) throw new Refused(`${name}'s kernel is ${String(file.kernel).slice(0, 12)}, but this checkout is at ${product.slice(0, 12)}`);
  const next = pinText(text, file, name, sha);
  resolveRelease(file, (YAML.parse(next) ?? {}) as Dict);
  commitOn(d.inst, "main", `update: AidenHQ ${name} (the installer, from ${cur.name})`, (clone) => writeFileSync(join(clone, "instance.yaml"), next));
  return `instance.yaml now pins ${name} (from ${cur.name})`;
}

// ------------------------------------------------------------------------------------------------ the kernel's side

/** Records still going; any other state is the end. */
const MOVING = ["review", "owner", "approved", "claimed"];
const HOUR = 3_600_000;

/**
 * The kernel's half: runs the check (hourly, and at once on Update now), files the release it prepared as a kernel.apply and
 * follows that record to its end, tells the owner each event once (kernel.db), and the /updates page reads the state.
 */
export function createUpdates({ db, dir, board, inst, ownerLine, check, file, record, close, log = () => {}, now = Date.now }: {
  db: DatabaseSync; dir: string; board?: string;
  /** The instance checkout: until the first check has run, the page reads the release followed from its instance.yaml. */
  inst?: string;
  ownerLine: (text: string) => void;
  /** Runs `node kernel/src/updates.ts check [release by]` (a child process: its git and network work stays off the kernel's loop). */
  check: (asked: Asked) => Promise<void>;
  /** Files the prepared release: a task of the kernel's and a kernel.apply on it; returns both ids. */
  file: (r: Ready) => Promise<{ record: string; task: string }>;
  /** A record's state and outcome, undefined when there is none. */
  record: (id: string) => { state: string; outcome?: { text?: string } | null } | undefined;
  /** Closes the release's task with one line. */
  close: (task: string, body: string) => Promise<unknown>;
  log?: (msg: string, f?: Record<string, unknown>) => void; now?: () => number;
}) {
  db.exec("CREATE TABLE IF NOT EXISTS update_notices (id TEXT PRIMARY KEY, at TEXT NOT NULL)");
  const d = { dir, board };
  let running: Promise<void> | null = null, checked = 0, asked: Asked = null;

  /** The filed record's end: installed, or failed with its reason (the night doesn't file that release again). */
  async function follow(s: State) {
    const f = s.flight!;
    const r = record(f.record);
    if (r && MOVING.includes(r.state)) return;
    const at = new Date(now()).toISOString();
    if (r?.state === "done") {
      s.last = { release: f.release, outcome: "installed", at, by: f.by };
      s.current = { name: f.release, product: f.kernel };
      s.available = null;
      s.failed = (s.failed ?? []).filter((n) => n !== f.release);
      event(s, `installed:${f.release}`, `AidenHQ is updated to ${f.release} (from ${f.from}).${f.notes.length ? ` What changed: ${f.notes.slice(0, 5).join("; ")}.` : ""} Every change: ${f.compare}`);
    } else if (r?.state === "failed" && /moved on since this commit's base/.test(String(r.outcome?.text ?? ""))) {
      // Another change reached the instance's main first: nothing was tried, so the next check prepares it again on the new main.
      log("release to prepare again: the instance's main moved", { release: f.release });
    } else {
      const why = !r ? "its record is gone" : r.state === "failed" ? plain(String(r.outcome?.text ?? "").split("\n")[0], 400) || "the apply failed" : `the card was ${r.state}`;
      s.last = { release: f.release, outcome: "failed", why, at, by: f.by };
      s.failed = [...new Set([...(s.failed ?? []), f.release])];
      event(s, `failed:${f.release}:${at}`, `AidenHQ ${f.release} didn't install: ${why}. The night won't file it again; Update now in Settings > Instance does.`);
    }
    delete s.flight;
    writeState(d, s);
    const done = s.last?.release === f.release && s.last.at === at;
    await close(f.task, !done ? "Not landed: the instance's main moved first; it is prepared again on the new main." : s.last!.outcome === "installed" ? `Installed: this server runs AidenHQ ${f.release}.` : `**Not installed:** ${s.last!.why}.`).catch((e: Error) => log("update task not closed", { task: f.task, err: e.message }));
  }

  async function pass() {
    let s = readState(dir);
    if (s.flight) await follow(s);
    const ask = asked;
    if (ask || now() - checked >= HOUR) {
      asked = null;
      checked = now();
      await check(ask).catch((e: Error) => log("update check failed", { err: e.message.slice(0, 300) }));
    }
    s = readState(dir);
    if (s.ready && !s.flight) {
      const r = s.ready;
      try {
        s.flight = { ...r, ...(await file(r)) };
        delete s.ready;
        log("release filed", { release: r.release, record: s.flight.record });
      } catch (e) {
        // Said once either way. Refused (the planner's rules, the grant): dropped, and the night doesn't prepare it again; anything
        // else (no agent for its task yet, the network) is filed again next pass.
        const status = (e as { status?: number }).status;
        const refused = status === 403 || status === 404 || status === 422;
        event(s, `notfiled:${r.release}`, `AidenHQ ${r.release} couldn't be filed${refused ? "" : " yet"}: ${plain((e as Error).message, 300)}. Nothing changed.`);
        if (refused) { delete s.ready; s.failed = [...new Set([...(s.failed ?? []), r.release])]; }
        log("release not filed", { release: r.release, err: (e as Error).message.slice(0, 300) });
      }
      writeState(d, s);
    }
    for (const e of readState(dir).events ?? []) {
      if (db.prepare("INSERT OR IGNORE INTO update_notices (id, at) VALUES (?, ?)").run(e.id, new Date(now()).toISOString()).changes === 1) ownerLine(e.text);
    }
  }

  return {
    /** One pass (every few minutes, and after Update now): follow, check when due, file, tell. Passes never overlap: a tick during one is that one. */
    tick(): Promise<void> {
      return (running ??= (async () => { try { do await pass(); while (asked); } finally { running = null; } })());
    },
    view: (): State => {
      const s = readState(dir);
      if (s.current || !inst) return s;
      try {
        const instance = (YAML.parse(readFileSync(join(inst, "instance.yaml"), "utf8")) ?? {}) as Dict;
        const cur = followed(instance);
        return cur ? { ...s, current: { name: cur.name, product: String(instance.product ?? "") }, auto: autoOn(instance) } : s;
      } catch { return s; }
    },
    /** Update now: only the release the page showed, still the one available; it is filed at once (its tier as any release's). */
    requestNow(release: string, by: string): string {
      const s = readState(dir);
      if (!s.available || s.available.name !== release) throw new Error("that release isn't the one available any more; reload the page");
      asked = { release, by };
      this.tick().catch((e: Error) => log("update pass failed", { err: e.message.slice(0, 300) }));
      return `Filing ${release} now. ${s.auto ? "The AI reviewer checks it" : "It installs on your approval (its card)"}; the board and this page restart while it installs, and you'll get a message when it is done.`;
    },
  };
}
export type Updates = ReturnType<typeof createUpdates>;

// ------------------------------------------------------------------------------------------------ CLI (the kernel, ops/setup.sh)

async function download(u: string): Promise<unknown> {
  const r = await fetch(u, { headers: { accept: "application/json", "user-agent": "aidenhq-updater" }, redirect: "follow", signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new Error(`${u} answered ${r.status}`);
  return r.json();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const product = join(import.meta.dirname, "../..");
  const data = resolve(product, process.env.AIDENHQ_DATA_DIR ?? "data");
  const state = process.env.AIDENHQ_STATE_DIR ?? join(homedir(), ".local/state/aidenhq");
  const d: Deps = {
    base: GITHUB, download, fetch: { cacheDir: process.env.AIDENHQ_SOURCES_DIR ?? join(homedir(), ".cache/aidenhq/sources") },
    inst: process.env.AIDENHQ_INSTANCE_DIR ?? join(homedir(), "aidenhq-instance"), product,
    dir: join(data, "updates"), board: join(state, "board/updates.json"),
  };
  const [cmd, a, b] = process.argv.slice(2);
  try {
    if (cmd === "check") {
      // The candidate exception asks for its release by name, so a check can't take a pre-release it wasn't sent for.
      const candidate = process.env[CANDIDATE_ENV] ?? "";
      if (candidate && candidate !== a) throw new Error(`${CANDIDATE_ENV} names ${plain(candidate, 40)}: run check ${plain(candidate, 40)} <by>`);
      const s = await check(d, a && b ? { release: a, by: b } : null, candidate);
      console.log(s.ready ? `release ${s.ready.release} prepared at ${s.ready.sha} (${s.ready.branch})` : s.available ? `release ${s.available.name} available (running ${s.current?.name})` : s.error ? `update check: ${s.error}` : `release: ${s.current?.name ?? "none followed"}, nothing newer`);
    } else if (cmd === "verify" && a && b) {
      // The planner's check of a release move (apply-tier.ts): the instance.yaml this base moves to, every check passed. A
      // pre-release passes only as the candidate the host's check prepared (its mark in the state file, never the environment).
      process.stdout.write(JSON.stringify({ text: (await verify(d, readFileSync(0, "utf8"), a, b, candidateMarked(readState(d.dir), a, b))).text }));
    } else if (cmd === "pin" && a && b) {
      console.log(pinTo(d, a, b, git(product, ["rev-parse", "HEAD"]).trim()));
    } else {
      console.error("usage: node kernel/src/updates.ts check [<release> <by>] | verify <release> <distro sha> < instance.yaml | pin <release> <distro sha>");
      process.exitCode = 2;
    }
  } catch (e) {
    console.error(`update: ${e instanceof Refused ? "refused: " : ""}${(e as Error).message.split("\n")[0]}`);
    process.exitCode = e instanceof Refused ? 3 : 1;
  }
}

/** The kernel's check: this file's CLI as a child process, so the git and network work never blocks the kernel. Never a candidate run. */
export function runCheck(product: string) {
  return (asked: Asked) => new Promise<void>((ok, no) => execFile(process.execPath, ["--disable-warning=ExperimentalWarning", join(product, "kernel/src/updates.ts"), "check", ...(asked ? [asked.release, asked.by] : [])], { cwd: product, env: { ...process.env, [CANDIDATE_ENV]: undefined }, timeout: 15 * 60_000, maxBuffer: 4 * 1024 * 1024 }, (e, _out, err) => (e && (e as { code?: unknown }).code !== 3 ? no(new Error(String(err || e.message).trim().slice(0, 500))) : ok())));
}

/** The planner's verification of a release move: the instance.yaml `verify` writes for this base, or null when it refuses or fails. */
export function runVerify(product: string) {
  return (baseText: string, name: string, sha: string) => new Promise<string | null>((ok) => {
    const c = execFile(process.execPath, ["--disable-warning=ExperimentalWarning", join(product, "kernel/src/updates.ts"), "verify", name, sha], { cwd: product, timeout: 10 * 60_000, maxBuffer: 4 * 1024 * 1024 }, (e, out) => {
      if (e) return ok(null);
      try { const t = (JSON.parse(String(out)) as { text?: unknown }).text; ok(typeof t === "string" ? t : null); } catch { ok(null); }
    });
    c.stdin?.end(baseText);
  });
}
