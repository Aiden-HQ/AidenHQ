// Release updates (docs/design/release-updates.md). An install from a release (instance.yaml `release:` from the official
// distro repo) moves to the next release itself: at night in the owner's timezone while settings.auto_update is on (unset
// = on), or when the owner presses Update now (the kernel's /updates page). An instance that pins product by hand has no
// `release:` and is never touched.
// - The source is fixed: the official distro, kernel and modules repositories on GitHub, over https. Nothing in a release
//   file or instance.yaml can point the updater elsewhere.
// - Before anything moves, a release is verified: its tag's commit is on the distro's main; its file names the official
//   kernel and marketplace and only ghcr.io/aiden-hq images, and resolves (release.ts) against the instance it would pin;
//   the kernel and marketplace shas are on their repositories' main and descend from what runs now (no downgrade, and the
//   name must be newer); the published asset is the same file with the release workflow's `tested` stamp, and that stamp
//   names a release.yml run on the tag's commit.
// - An install is one instance commit (product:, release: and the aidenhq marketplace sha, as an upgrade by hand is), then
//   ops/apply-config.sh at that commit, under the host's apply lock (ops/update.sh holds it on fd 9 from before the commit
//   until the apply ends). Apply's own health check reverts the host to the last known good; the updater then reverts the
//   commit, so git history and the pin say what runs, and records the release as failed: the night never retries it, only
//   the owner's Update now does.
// - The kernel (createUpdates) reads the state file this writes: it tells the owner each event once (channels' owner line)
//   and serves the /updates page.
//   node kernel/src/updates.ts check     (ops/update.sh) look for a newer release; writes `next` when one installs now
//   node kernel/src/updates.ts install   (ops/update.sh, apply lock held on fd 9) install `next`
//   node kernel/src/updates.ts pin <name> <distro sha>   (ops/setup.sh, the installer run again) move the pin to that release
import { execFileSync, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import type { DatabaseSync } from "node:sqlite";
import YAML, { Scalar } from "yaml";
import { resolveRelease } from "./loader/release.ts";
import { OFFICIAL, repoAt, type Fetch, type Where } from "./loader/sources.ts";

type Dict = Record<string, unknown>;
export const DISTRO = "Aiden-HQ/aidenhq-distro";
export const KERNEL = "Aiden-HQ/AidenHQ";
export const MODULES = "Aiden-HQ/aidenhq-modules";
const GITHUB = "https://github.com";
const NAME = /^\d{4}\.\d{1,2}(\.\d+){0,2}$/;
const SHA = /^[0-9a-f]{40}$/;
/** The night, in the owner's timezone: an automatic install starts at or after FROM and before TO. */
export const NIGHT = { from: 2, to: 5 };
const isMap = (v: unknown): v is Dict => !!v && typeof v === "object" && !Array.isArray(v);

/** A release that failed verification: never installed, and the owner is told once. Anything else (network) is retried. */
export class Refused extends Error {}

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
  /** The updater's own state (state.json, now.json) and the board's display copy (updates.json), when there is one. */
  dir: string;
  board?: string;
  /** apply's record of the product this host last applied in full (data/applied-product). */
  applied: string;
  /** ops/apply-config.sh (args: none for the instance's main, or --recover), the apply lock already held. */
  apply: (args: string[]) => { code: number; out: string };
  now?: () => Date;
};

export type Candidate = {
  name: string; sha: string; kernel: string; marketplace: string; notes: string[]; compare: string; images: number;
  from: { name: string; product: string };
};
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
  /** An install in flight, written before its pin commit is pushed: a run that finds it finishes what a dead one left (reconcile). */
  installing?: { release: string; kernel: string; from: string; commit: string; by: string; notes: string[]; compare: string };
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

/** instance.yaml's text moved to a release: product:, release: and the aidenhq marketplace's sha, comments kept. */
export function pinText(text: string, file: Dict, name: string, sha: string): string {
  const doc = YAML.parseDocument(text);
  const quoted = (s: string) => Object.assign(new Scalar(s), { type: Scalar.QUOTE_DOUBLE });
  doc.set("product", file.kernel);
  if (!doc.has("release")) doc.set("release", doc.createNode({ name, source: { source: "github", repo: DISTRO }, sha }, { flow: true }));
  doc.setIn(["release", "name"], quoted(name));
  doc.setIn(["release", "sha"], sha);
  const ms = doc.get("marketplaces") as YAML.YAMLSeq | undefined;
  for (const m of ms?.items ?? []) if (YAML.isMap(m) && m.get("name") === OFFICIAL) m.set("sha", (file.marketplace as Dict).sha);
  return doc.toString({ lineWidth: 0 });
}

/**
 * The release `name` at distro commit `sha`, checked as an update of `instance` (its instance.yaml `text`): every check
 * before anything moves. Throws Refused when the release fails one; any other error is the network's, retried next time.
 */
export async function verify(d: Pick<Deps, "base" | "fetch" | "download">, text: string, name: string, sha: string): Promise<Candidate & { text: string }> {
  const instance = (YAML.parse(text) ?? {}) as Dict;
  const cur = followed(instance);
  if (!cur) throw new Refused("this instance doesn't follow a release from the official distro repo");
  if (!NAME.test(name) || !SHA.test(sha)) throw new Refused(`${plain(name, 40)} isn't a release name with a commit`);
  if (compareRelease(name, cur.name) <= 0) throw new Refused(`${name} isn't newer than ${cur.name}: downgrades are refused`);
  const distro = onMain(d, at(d, DISTRO, sha), `${name}'s commit`);
  let file: Dict;
  try { file = JSON.parse(execFileSync("git", ["--git-dir", distro, "show", `${sha}:releases/${name}.json`], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })) as Dict; } catch { throw new Refused(`${name} has no readable releases/${name}.json at ${sha.slice(0, 12)}`); }
  // The fixed sources: a release file can't point the kernel, the modules or the images anywhere else.
  if (file.release !== name) throw new Refused(`releases/${name}.json says it is ${plain(file.release, 40)}`);
  if ((file.kernel_repo ?? KERNEL) !== KERNEL) throw new Refused(`${name} names the kernel ${plain(file.kernel_repo, 100)}, not ${KERNEL}`);
  const m = isMap(file.marketplace) ? file.marketplace : {};
  if (!isMap(m.source) || m.source.source !== "github" || m.source.repo !== MODULES) throw new Refused(`${name}'s marketplace isn't ${MODULES}`);
  const images = isMap(file.images) ? Object.values(file.images) : [];
  if (images.some((i) => typeof i !== "string" || !i.startsWith("ghcr.io/aiden-hq/"))) throw new Refused(`${name} names an image outside ghcr.io/aiden-hq`);
  // What the instance would pin, resolved as the apply will (shapes, shas, product: = kernel, the marketplace agreeing).
  const next = pinText(text, file, name, sha);
  try { resolveRelease(file, (YAML.parse(next) ?? {}) as Dict); } catch (e) { throw new Refused((e as Error).message); }
  const kernel = String(file.kernel), market = String(m.sha);
  const product = String(instance.product ?? "");
  if (!isAncestor(onMain(d, at(d, KERNEL, kernel), `${name}'s kernel`), product, kernel)) throw new Refused(`${name}'s kernel ${kernel.slice(0, 12)} doesn't descend from the running product ${product.slice(0, 12)}`);
  const own = (Array.isArray(instance.marketplaces) ? instance.marketplaces : []).find((x) => isMap(x) && x.name === OFFICIAL) as Dict | undefined;
  const mr = onMain(d, at(d, MODULES, market), `${name}'s marketplace`);
  if (own && typeof own.sha === "string" && !isAncestor(mr, own.sha, market)) throw new Refused(`${name}'s marketplace ${market.slice(0, 12)} doesn't descend from the running ${own.sha.slice(0, 12)}`);
  // As install.sh checks: every module's own sha is on the marketplace's history at the release's sha.
  for (const [mod, ms] of Object.entries(isMap(file.modules) ? file.modules : {})) if (!isAncestor(mr, String(ms), market)) throw new Refused(`${name}'s module ${plain(mod, 60)} at ${String(ms).slice(0, 12)} isn't on the marketplace's history at ${market.slice(0, 12)}`);
  // The release workflow's stamp: the published asset is this file with `tested` written, from a release.yml run on this commit.
  const asset = await d.download(`${GITHUB}/${DISTRO}/releases/download/${name}/${name}.json`);
  const bare = (f: unknown) => { const { tested: _t, todo: _d, ...rest } = isMap(f) ? f : {}; return rest; };
  if (!isDeepStrictEqual(bare(asset), bare(file))) throw new Refused(`${name}'s published release file isn't the one at its tag`);
  const tested = isMap(asset) && isMap(asset.tested) ? asset.tested : {};
  const run = /^https:\/\/github\.com\/Aiden-HQ\/aidenhq-distro\/actions\/runs\/(\d{1,20})$/.exec(String(tested.ci_run ?? ""));
  if (!run || !Array.isArray(tested.suites) || !tested.suites.length) throw new Refused(`${name} has no tested stamp from the release workflow`);
  const r = await d.download(`https://api.github.com/repos/${DISTRO}/actions/runs/${run[1]}`);
  if (!isMap(r) || r.path !== ".github/workflows/release.yml" || r.head_sha !== sha || r.event !== "push" || r.conclusion !== "success") throw new Refused(`${name}'s tested stamp doesn't name a successful release run on its commit`);
  const notes = (Array.isArray(file.notes) ? file.notes : typeof file.notes === "string" ? [file.notes] : []).slice(0, 20).map((n) => plain(n)).filter(Boolean);
  return { name, sha, kernel, marketplace: market, notes, compare: `${GITHUB}/${KERNEL}/compare/${product.slice(0, 12)}...${kernel.slice(0, 12)}`, images: images.length, from: { name: cur.name, product }, text: next };
}

// ------------------------------------------------------------------------------------------------ state

const stateFile = (d: Pick<Deps, "dir">) => join(d.dir, "state.json");
export const readState = (dir: string): State => { try { return JSON.parse(readFileSync(join(dir, "state.json"), "utf8")) as State; } catch { return {}; } };
function writeState(d: Pick<Deps, "dir" | "board">, s: State) {
  const put = (f: string, v: unknown) => { mkdirSync(join(f, ".."), { recursive: true }); writeFileSync(`${f}.tmp`, `${JSON.stringify(v, null, 2)}\n`); renameSync(`${f}.tmp`, f); };
  put(stateFile(d), s);
  // The board's copy: what it shows, nothing it could act on.
  if (d.board) put(d.board, { current: s.current ?? null, auto: s.auto ?? null, timezone: s.timezone ?? null, checkedAt: s.checkedAt ?? null, available: s.available ? { name: s.available.name, notes: s.available.notes, compare: s.available.compare } : null, error: s.error ?? null, last: s.last ?? null });
}
const event = (s: State, id: string, text: string) => { s.events = [...(s.events ?? []).filter((e) => e.id !== id), { id, text }].slice(-20); };

/** instance.yaml on the instance's main, as text (fetched first). */
function instanceText(inst: string) {
  git(inst, ["fetch", "-q", "origin", "main"]);
  return git(inst, ["show", "origin/main:instance.yaml"]);
}

type Asked = { release?: string; by?: string } | null;

/**
 * The check: the newest release newer than the one followed that passes every check (a refused one is said once and the next
 * older is tried; a network error stops the check, retried at the next run). Records it, and says whether it installs now:
 * the owner asked for it (Update now), or auto-updates are on, it is night and it never failed here.
 */
export async function check(d: Deps, asked: Asked = null): Promise<{ state: State; install: { release: string; by: string } | null }> {
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
  if (cur) {
    try {
      for (const tag of newerTags(d, cur.name)) {
        try {
          const { text: _t, ...c } = await verify(d, text, tag.name, tag.sha);
          if (!(s.events ?? []).some((e) => e.id === `available:${c.name}`)) event(s, `available:${c.name}`, s.auto
            ? `AidenHQ ${c.name} is available. It installs tonight between ${NIGHT.from}:00 and ${NIGHT.to}:00 (${s.timezone}); to install it now or see what changed, open Settings > Instance.`
            : `AidenHQ ${c.name} is available. Auto-updates are off: install it from Settings > Instance (Update now), where what changed is listed.`);
          s.available = c;
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
  const install = a && asked?.release === a.name ? { release: a.name, by: String(asked.by ?? "owner").slice(0, 100) }
    : a && s.auto && atNight(now, s.timezone) && !(s.failed ?? []).includes(a.name) ? { release: a.name, by: "auto-update" } : null;
  if (asked && !install) event(s, `now:${now.toISOString()}`, `Update now didn't start: ${s.error ?? `${plain(asked.release, 40)} isn't the release available any more`}. Nothing changed.`);
  writeState(d, s);
  return { state: s, install };
}

/** Text changes to the instance's main, made in a temporary clone; `committed` runs before the push. Returns the commit. */
function onInstanceMain(inst: string, change: (clone: string) => void, committed: (sha: string) => void = () => {}): string {
  const origin = git(inst, ["remote", "get-url", "origin"]).trim();
  const tmp = mkdtempSync(join(tmpdir(), "aidenhq-update-"));
  try {
    git(tmp, ["clone", "-q", "--", origin, "c"]);
    const c = join(tmp, "c");
    change(c);
    const sha = git(c, ["rev-parse", "HEAD"]).trim();
    committed(sha);
    git(c, ["push", "-q", "origin", "HEAD:main"]);
    return sha;
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}
const commit = (c: string, msg: string) => git(c, ["-c", "user.name=AidenHQ updates", "-c", "user.email=updates@aidenhq.invalid", "commit", "-q", "-m", msg, "--", "instance.yaml"]);

/** The verified kernel commit on the product checkout's origin main, where apply requires it: GitHub has it, a local mirror gets it pushed. */
function landKernel(d: Pick<Deps, "base" | "fetch" | "product">, kernel: string) {
  const origin = git(d.product, ["remote", "get-url", "origin"]).trim();
  if (origin.replace(/\.git$/, "") === url(d, KERNEL).replace(/\.git$/, "")) return;
  if (!origin.startsWith("/")) throw new Refused(`the product checkout's origin is ${plain(origin, 200)}, not ${KERNEL} or a local mirror`);
  // A fast-forward only (no force): the mirror's main never moves back or sideways.
  git(d.product, ["--git-dir", repoAt(at(d, KERNEL, kernel), d.fetch), "push", "-q", "--", origin, `${kernel}:refs/heads/main`]);
}

/** The apply's own words for why it failed: its alert, else its refusal, else the exit code. */
const why = (out: string, code: number) => plain([...out.matchAll(/^(?:apply alert|refusing): (.*)$/gm)].at(-1)?.[1] ?? `the apply exited ${code}`, 400);

/**
 * How an install ended, recorded once: installed, or failed, with its pin commit reverted on the instance's main (when it is
 * there), so git and the pin say what runs. The night never tries a failed release again; Update now does.
 */
function settle(d: Deps, s: State, ok: boolean, reason: string, now: Date) {
  const i = s.installing!;
  delete s.installing;
  if (ok) {
    s.last = { release: i.release, outcome: "installed", at: now.toISOString(), by: i.by };
    s.current = { name: i.release, product: i.kernel };
    s.available = null;
    s.failed = (s.failed ?? []).filter((n) => n !== i.release);
    event(s, `installed:${i.release}`, `AidenHQ is updated to ${i.release} (from ${i.from}).${i.notes.length ? ` What changed: ${i.notes.slice(0, 5).join("; ")}.` : ""} Every change: ${i.compare}`);
  } else {
    let reverted = true;
    try {
      git(d.inst, ["fetch", "-q", "origin", "main"]);
      if (isAncestor(join(d.inst, ".git"), i.commit, "origin/main")) onInstanceMain(d.inst, (clone) => { git(clone, ["revert", "--no-commit", i.commit]); commit(clone, `update: back to ${i.from} (${i.release} failed to install)\n\nReverts ${i.commit}.`); });
    } catch { reverted = false; }
    s.last = { release: i.release, outcome: "failed", why: reason, at: now.toISOString(), by: i.by };
    s.failed = [...new Set([...(s.failed ?? []), i.release])];
    event(s, `failed:${i.release}:${now.toISOString()}`, `AidenHQ ${i.release} didn't install: ${reason}. This server is back on ${i.from}${reverted ? "" : ` (its instance.yaml still pins ${i.release}: revert the last instance commit)`}. It won't retry on its own; Update now in Settings > Instance tries again.`);
  }
  writeState(d, s);
}

/**
 * An install a dead run left (`installing` in the state): apply finishes its own dead generation first (--recover), then
 * what the host applied in full says how it ended. A pin commit that never reached main changed nothing.
 */
export function reconcile(d: Deps) {
  const s = readState(d.dir);
  const i = s.installing;
  if (!i) return;
  git(d.inst, ["fetch", "-q", "origin", "main"]);
  if (!isAncestor(join(d.inst, ".git"), i.commit, "origin/main")) { delete s.installing; writeState(d, s); return; }
  d.apply(["--recover"]);
  let ran = "";
  try { ran = readFileSync(d.applied, "utf8").trim(); } catch {}
  settle(d, s, ran === i.kernel, "the update stopped before it finished (the server restarted or the updater was killed)", (d.now ?? (() => new Date()))());
}

/**
 * Installs a release the check chose (the apply lock held by ops/update.sh): verified again, the kernel landed, `installing`
 * recorded, the pin committed and pushed, the instance's main applied. Throws only before anything moved.
 */
export async function install(d: Deps, next: { release: string; by: string }): Promise<State> {
  const now = (d.now ?? (() => new Date()))();
  const s = readState(d.dir);
  const text = instanceText(d.inst);
  const cur = followed((YAML.parse(text) ?? {}) as Dict);
  const tag = cur ? newerTags(d, cur.name).find((t) => t.name === next.release) : undefined;
  if (!tag) throw new Error(`${next.release} is no longer a release newer than this server's`);
  const c = await verify(d, text, tag.name, tag.sha);
  landKernel(d, c.kernel);
  onInstanceMain(d.inst, (clone) => {
    if (readFileSync(join(clone, "instance.yaml"), "utf8") !== text) throw new Error("instance.yaml moved while the update was checked; it waits for the next run");
    writeFileSync(join(clone, "instance.yaml"), c.text);
    commit(clone, `update: AidenHQ ${c.name}\n\nFrom ${c.from.name}: product ${c.kernel}, release ${c.name} at distro ${c.sha}, ${OFFICIAL} marketplace ${c.marketplace}.\nBy ${next.by}. What changed: ${c.compare}`);
  }, (sha) => { s.installing = { release: c.name, kernel: c.kernel, from: c.from.name, commit: sha, by: next.by, notes: c.notes, compare: c.compare }; writeState(d, s); });
  // The instance's main, not the pin commit alone: another writer's commit landed after it is applied with it, never refused.
  const r = d.apply([]);
  settle(d, s, r.code === 0, why(r.out, r.code), now);
  return s;
}

/**
 * One run of the updater (ops/update.sh, the apply lock held): finish what a dead run left, check, install what the check
 * chose. An owner's Update now (now.json) is kept until its outcome is recorded, and every outcome reaches the owner once.
 */
export async function run(d: Deps): Promise<State> {
  const nowFile = join(d.dir, "now.json");
  mkdirSync(d.dir, { recursive: true });
  let asked: Asked = null;
  try { asked = JSON.parse(readFileSync(nowFile, "utf8")); } catch {}
  const seen = existsSync(nowFile) ? statSync(nowFile).mtimeMs : 0;
  try {
    reconcile(d);
    const { install: next } = await check(d, asked);
    if (next) {
      try { await install(d, next); } catch (e) {
        const s = readState(d.dir);
        if (s.installing) throw e; // past the push: the next run reconciles it
        if (e instanceof Refused) event(s, `refused:${next.release}`, `AidenHQ ${next.release} failed this server's checks at install (${plain(e.message, 200)}), so it won't be installed. Nothing changed here.`);
        else if (next.by !== "auto-update") event(s, `now:${new Date().toISOString()}`, `Update now didn't start: ${plain((e as Error).message, 200)}. Nothing changed; try again in a while.`);
        s.error = plain((e as Error).message);
        writeState(d, s);
      }
    }
  } finally {
    // A request that arrived during this run is kept for the next one.
    if (asked && existsSync(nowFile) && statSync(nowFile).mtimeMs === seen) rmSync(nowFile, { force: true });
  }
  return readState(d.dir);
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
  if (compareRelease(name, cur.name) === 0) return `already on ${name}`;
  const distro = repoAt(at(d, DISTRO, sha), d.fetch);
  const file = JSON.parse(execFileSync("git", ["--git-dir", distro, "show", `${sha}:releases/${name}.json`], { encoding: "utf8" })) as Dict;
  if (file.kernel !== product) throw new Refused(`${name}'s kernel is ${String(file.kernel).slice(0, 12)}, but this checkout is at ${product.slice(0, 12)}`);
  const next = pinText(text, file, name, sha);
  resolveRelease(file, (YAML.parse(next) ?? {}) as Dict);
  onInstanceMain(d.inst, (clone) => { writeFileSync(join(clone, "instance.yaml"), next); commit(clone, `update: AidenHQ ${name} (the installer, from ${cur.name})`); });
  return `instance.yaml now pins ${name} (from ${cur.name})`;
}

// ------------------------------------------------------------------------------------------------ the kernel's side

/**
 * The kernel's half: each event the updater recorded is told to the owner once (kernel.db), the /updates page reads the
 * state, and Update now (an admin's tap on that page) asks the updater's unit to install the release the page showed.
 */
export function createUpdates({ db, dir, ownerLine, start, now = Date.now }: {
  db: DatabaseSync; dir: string; ownerLine: (text: string) => void;
  /** Starts the updater's unit (systemctl --user start --no-block aidenhq-update.service). */
  start: () => void; now?: () => number;
}) {
  db.exec("CREATE TABLE IF NOT EXISTS update_notices (id TEXT PRIMARY KEY, at TEXT NOT NULL)");
  return {
    tick() {
      for (const e of readState(dir).events ?? []) {
        if (db.prepare("INSERT OR IGNORE INTO update_notices (id, at) VALUES (?, ?)").run(e.id, new Date(now()).toISOString()).changes === 1) ownerLine(e.text);
      }
    },
    view: () => readState(dir),
    /** Update now: only the release the page showed, still the one available. */
    requestNow(release: string, by: string): string {
      const s = readState(dir);
      if (!s.available || s.available.name !== release) throw new Error("that release isn't the one available any more; reload the page");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "now.json"), `${JSON.stringify({ release, by, at: new Date(now()).toISOString() })}\n`, { mode: 0o600 });
      start();
      return `Installing ${release} now. The board and this page restart during it; you'll get a message when it is done.`;
    },
  };
}
export type Updates = ReturnType<typeof createUpdates>;

// ------------------------------------------------------------------------------------------------ CLI (ops/update.sh, ops/setup.sh)

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
    // The data dir is hidden from every job (kernel/src/sandbox-config.ts): nothing an agent runs can write a request here.
    dir: join(data, "updates"), board: join(state, "board/updates.json"), applied: join(data, "applied-product"),
    // The lock ops/update.sh holds on fd 9 goes to the apply as its hand-over (ops/lib/apply-lock.sh checks it). Its output goes
    // to a file, not a pipe: a process the apply leaves running can't keep this waiting.
    apply: (args) => {
      const log = join(data, "updates", "apply.log");
      mkdirSync(join(data, "updates"), { recursive: true });
      const fd = openSync(log, "w");
      const locked = process.env.AIDENHQ_APPLY_LOCKED === "9";
      const r = spawnSync("bash", ["ops/apply-config.sh", ...args], { cwd: product, stdio: ["ignore", fd, fd, ...(locked ? ["ignore", "ignore", "ignore", "ignore", "ignore", "ignore", 9] as const : [])] });
      closeSync(fd);
      const out = readFileSync(log, "utf8");
      process.stdout.write(out);
      return { code: r.status ?? 1, out };
    },
  };
  const [cmd, a, b] = process.argv.slice(2);
  try {
    if (cmd === "run") {
      const s = await run(d);
      console.log(s.last ? `update ${s.last.release}: ${s.last.outcome}${s.last.why ? ` (${s.last.why})` : ""}` : "");
      console.log(s.available ? `release ${s.available.name} available (running ${s.current?.name})` : s.error ? `update check: ${s.error}` : `release: ${s.current?.name ?? "none followed"}, nothing newer`);
    } else if (cmd === "pin" && a && b) {
      console.log(pinTo(d, a, b, git(product, ["rev-parse", "HEAD"]).trim()));
    } else {
      console.error("usage: node kernel/src/updates.ts run | pin <release> <distro sha>");
      process.exitCode = 2;
    }
  } catch (e) {
    console.error(`update: ${e instanceof Refused ? "refused: " : ""}${(e as Error).message.split("\n")[0]}`);
    process.exitCode = e instanceof Refused ? 3 : 1;
  }
}
