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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import type { DatabaseSync } from "node:sqlite";
import YAML, { Scalar } from "yaml";
import { resolveRelease } from "./loader/release.ts";
import { OFFICIAL, onOfficialMain, repoAt, type Fetch, type Where } from "./loader/sources.ts";

type Dict = Record<string, unknown>;
export const DISTRO = "Aiden-HQ/aidenhq-distro";
export const KERNEL = "Aiden-HQ/AidenHQ";
export const MODULES = "Aiden-HQ/aidenhq-modules";
const GITHUB = "https://github.com";
const NAME = /^\d{4}\.\d{1,2}(\.\d+)?$/;
const SHA = /^[0-9a-f]{40}$/;
/** The night, in the owner's timezone: an automatic install starts at or after FROM and before TO. */
export const NIGHT = { from: 2, to: 5 };
const isMap = (v: unknown): v is Dict => !!v && typeof v === "object" && !Array.isArray(v);

/** A release that failed verification: never installed, and the owner is told once. Anything else (network) is retried. */
export class Refused extends Error {}

/** Release names in order: 2026.11 < 2026.11.1 < 2026.12. */
export function compareRelease(a: string, b: string): number {
  const [x, y] = [a, b].map((s) => s.split(".").map(Number));
  for (let i = 0; i < 3; i++) { const d = (x![i] ?? 0) - (y![i] ?? 0); if (d) return Math.sign(d); }
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
  /** The updater's own state (state.json, next, now.json) and the board's display copy (updates.json), when there is one. */
  dir: string;
  board?: string;
  /** ops/apply-config.sh at an instance commit, the apply lock already held. */
  apply: (instanceSha: string) => { code: number; out: string };
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
  /** What the kernel tells the owner, each once (by id); the newest 20. */
  events?: { id: string; text: string }[];
};

const url = (d: Pick<Deps, "base">, repo: string) => `${d.base}/${repo}.git`;
const at = (d: Pick<Deps, "base">, repo: string, sha: string): Where => ({ url: url(d, repo), path: "", sha, owned: true });
const git = (cwd: string, args: string[], input?: string) =>
  execFileSync("git", ["-c", "protocol.allow=never", "-c", "protocol.https.allow=always", "-c", "protocol.file.allow=always", "-c", "credential.helper=", ...args], {
    cwd, encoding: "utf8", input, timeout: 120_000, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_DIR: undefined, GIT_WORK_TREE: undefined },
  });
const isAncestor = (repo: string, a: string, b: string) => spawnSync("git", ["--git-dir", repo, "merge-base", "--is-ancestor", a, b]).status === 0;
/** Plain text from a release file or an apply's output: one line, no control or format characters, never an HTML comment, bounded. */
const plain = (v: unknown, n = 300) => String(v ?? "").replace(/[\p{Cc}\p{Cf}]+/gu, " ").replace(/<!/g, "‹!").replace(/-->/g, "--›").trim().slice(0, n);

/** The newest release tag on the distro repo, with the commit it names. */
export function latestTag(d: Pick<Deps, "base">): { name: string; sha: string } | null {
  const tags = new Map<string, string>();
  for (const line of git(tmpdir(), ["ls-remote", "--tags", "--", url(d, DISTRO)]).split("\n")) {
    const m = /^([0-9a-f]{40})\trefs\/tags\/([^\s^]+)(\^\{\})?$/.exec(line);
    if (m && NAME.test(m[2]!) && (m[3] || !tags.has(m[2]!))) tags.set(m[2]!, m[1]!);
  }
  const name = [...tags.keys()].sort(compareRelease).at(-1);
  return name ? { name, sha: tags.get(name)! } : null;
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
  const distro = repoAt(at(d, DISTRO, sha), d.fetch);
  if (!onOfficialMain(at(d, DISTRO, sha), d.fetch)) throw new Refused(`${name}'s commit ${sha.slice(0, 12)} isn't on the distro repo's main`);
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
  const kw = at(d, KERNEL, kernel);
  if (!onOfficialMain(kw, d.fetch)) throw new Refused(`${name}'s kernel ${kernel.slice(0, 12)} isn't on ${KERNEL}'s main`);
  if (!isAncestor(repoAt(kw, d.fetch), product, kernel)) throw new Refused(`${name}'s kernel ${kernel.slice(0, 12)} doesn't descend from the running product ${product.slice(0, 12)}`);
  const own = (Array.isArray(instance.marketplaces) ? instance.marketplaces : []).find((x) => isMap(x) && x.name === OFFICIAL) as Dict | undefined;
  const mw = at(d, MODULES, market);
  if (!onOfficialMain(mw, d.fetch)) throw new Refused(`${name}'s marketplace ${market.slice(0, 12)} isn't on ${MODULES}'s main`);
  const mr = repoAt(mw, d.fetch);
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
  if (!isMap(r) || r.path !== ".github/workflows/release.yml" || r.head_sha !== sha || r.event !== "push") throw new Refused(`${name}'s tested stamp doesn't name a release run on its commit`);
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

/**
 * The hourly check (and the start of Update now): finds the newest release, verifies it, records it, and writes `next` when it
 * should install now: the owner asked for it (now.json), or auto-updates are on, it is night and it never failed here.
 */
export async function check(d: Deps): Promise<State> {
  const now = (d.now ?? (() => new Date()))();
  const s = readState(d.dir);
  mkdirSync(d.dir, { recursive: true });
  rmSync(join(d.dir, "next"), { force: true });
  let asked: { release?: string; by?: string } | null = null;
  const nowFile = join(d.dir, "now.json");
  if (existsSync(nowFile)) { try { asked = JSON.parse(readFileSync(nowFile, "utf8")); } catch { asked = null; } rmSync(nowFile, { force: true }); }
  const text = instanceText(d.inst);
  const instance = (YAML.parse(text) ?? {}) as Dict;
  const cur = followed(instance);
  s.checkedAt = now.toISOString();
  s.current = cur ? { name: cur.name, product: String(instance.product ?? "") } : null;
  s.auto = autoOn(instance);
  s.timezone = String((isMap(instance.settings) && instance.settings.timezone) || "UTC");
  delete s.error;
  if (!cur) { s.available = null; writeState(d, s); return s; }
  let tag: { name: string; sha: string } | null = null;
  try {
    tag = latestTag(d);
    if (!tag || compareRelease(tag.name, cur.name) <= 0) s.available = null;
    else {
      const { text: _t, ...c } = await verify(d, text, tag.name, tag.sha);
      if (s.available?.name !== c.name) event(s, `available:${c.name}`, s.auto
        ? `AidenHQ ${c.name} is available. It installs tonight between ${NIGHT.from}:00 and ${NIGHT.to}:00 (${s.timezone}); to install it now or see what changed, open Settings > Instance.`
        : `AidenHQ ${c.name} is available. Auto-updates are off: install it from Settings > Instance (Update now), where what changed is listed.`);
      s.available = c;
    }
  } catch (e) {
    s.available = null;
    if (!(e instanceof Refused)) s.error = plain((e as Error).message);
    else {
      const name = tag?.name ?? "?";
      s.error = `${name} was refused: ${plain(e.message)}`;
      event(s, `refused:${name}`, `AidenHQ ${name} was published but failed this server's checks (${plain(e.message, 200)}), so it won't be installed. Nothing changed here.`);
    }
  }
  const install = s.available && ((asked?.release === s.available.name) || (s.auto && atNight(now, s.timezone) && !(s.failed ?? []).includes(s.available.name)));
  // An Update now that can't go ahead is said, not dropped.
  if (asked && asked.release !== s.available?.name) event(s, `now:${now.toISOString()}`, `Update now didn't start: ${s.error ?? `${plain(asked.release, 40)} isn't the release available any more`}. Nothing changed.`);
  if (install) writeFileSync(join(d.dir, "next"), `${JSON.stringify({ release: s.available!.name, by: asked?.release === s.available!.name ? String(asked.by ?? "owner").slice(0, 100) : "auto-update" })}\n`);
  writeState(d, s);
  return s;
}

/** Text changes to the instance's main, made in a temporary clone and pushed (never in the checkout apply moves). */
function onInstanceMain(inst: string, change: (clone: string) => void): string {
  const origin = git(inst, ["remote", "get-url", "origin"]).trim();
  const tmp = mkdtempSync(join(tmpdir(), "aidenhq-update-"));
  try {
    git(tmp, ["clone", "-q", "--", origin, "c"]);
    const c = join(tmp, "c");
    change(c);
    git(c, ["push", "-q", "origin", "HEAD:main"]);
    return git(c, ["rev-parse", "HEAD"]).trim();
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

/** Moves the instance's pin to a verified release: one commit, pushed to the instance's main. Returns its sha. */
function pinCommit(d: Pick<Deps, "inst">, c: Candidate & { text: string }, base: string, by: string) {
  return onInstanceMain(d.inst, (clone) => {
    if (readFileSync(join(clone, "instance.yaml"), "utf8") !== base) throw new Error("instance.yaml moved while the update was checked; it waits for the next run");
    writeFileSync(join(clone, "instance.yaml"), c.text);
    commit(clone, `update: AidenHQ ${c.name}\n\nFrom ${c.from.name}: product ${c.kernel}, release ${c.name} at distro ${c.sha}, ${OFFICIAL} marketplace ${c.marketplace}.\nBy ${by}. What changed: ${c.compare}`);
  });
}

/** The apply's own words for why it failed: its alert, else its refusal, else the exit code. */
const why = (out: string, code: number) => plain([...out.matchAll(/^(?:apply alert|refusing): (.*)$/gm)].at(-1)?.[1] ?? `the apply exited ${code}`, 400);

/** Installs `next` (the apply lock held by ops/update.sh): verified again, the kernel landed, the pin committed, applied. */
export async function install(d: Deps): Promise<State> {
  const now = (d.now ?? (() => new Date()))();
  const nextFile = join(d.dir, "next");
  const next = JSON.parse(readFileSync(nextFile, "utf8")) as { release: string; by: string };
  rmSync(nextFile, { force: true });
  const s = readState(d.dir);
  const tag = latestTag(d);
  if (!tag || tag.name !== next.release) throw new Error(`${next.release} is no longer the newest release; the next check picks again`);
  const text = instanceText(d.inst);
  const c = await verify(d, text, tag.name, tag.sha);
  landKernel(d, c.kernel);
  const sha = pinCommit(d, c, text, next.by);
  const r = d.apply(sha);
  const { text: _t, ...cand } = c;
  if (r.code === 0) {
    s.last = { release: c.name, outcome: "installed", at: now.toISOString(), by: next.by };
    s.current = { name: c.name, product: c.kernel };
    s.available = null;
    s.failed = (s.failed ?? []).filter((n) => n !== c.name);
    event(s, `installed:${c.name}`, `AidenHQ is updated to ${c.name} (from ${c.from.name}).${c.notes.length ? ` What changed: ${c.notes.slice(0, 5).join("; ")}.` : ""} Every change: ${c.compare}`);
  } else {
    // The apply has put the host back on its last known good (or refused before switching anything); the pin follows.
    let reverted = true;
    try { onInstanceMain(d.inst, (clone) => { git(clone, ["revert", "--no-commit", sha]); commit(clone, `update: back to ${c.from.name} (${c.name} failed to install)\n\nReverts ${sha}.`); }); } catch { reverted = false; }
    const reason = why(r.out, r.code);
    s.last = { release: c.name, outcome: "failed", why: reason, at: now.toISOString(), by: next.by };
    s.available = cand;
    s.failed = [...new Set([...(s.failed ?? []), c.name])];
    event(s, `failed:${c.name}:${now.toISOString()}`, `AidenHQ ${c.name} didn't install: ${reason}. This server is back on ${c.from.name}${reverted ? "" : " (its instance.yaml still pins " + c.name + ": revert the last instance commit)"}. It won't retry on its own; Update now in Settings > Instance tries again.`);
  }
  writeState(d, s);
  return s;
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
  const state = process.env.AIDENHQ_STATE_DIR ?? join(homedir(), ".local/state/aidenhq");
  const d: Deps = {
    base: GITHUB, download, fetch: { cacheDir: process.env.AIDENHQ_SOURCES_DIR ?? join(homedir(), ".cache/aidenhq/sources") },
    inst: process.env.AIDENHQ_INSTANCE_DIR ?? join(homedir(), "aidenhq-instance"), product,
    // The data dir is hidden from every job (kernel/src/sandbox-config.ts): nothing an agent runs can write a request here.
    dir: resolve(product, process.env.AIDENHQ_DATA_DIR ?? "data", "updates"), board: join(state, "board/updates.json"),
    // The lock ops/update.sh holds on fd 9 goes to the apply as its hand-over (ops/lib/apply-lock.sh checks it).
    apply: (sha) => {
      const locked = process.env.AIDENHQ_APPLY_LOCKED === "9";
      const r = spawnSync("bash", ["ops/apply-config.sh", sha], { cwd: product, encoding: "utf8", maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "pipe", ...(locked ? ["ignore", "ignore", "ignore", "ignore", "ignore", "ignore", 9] as const : [])] });
      const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
      process.stdout.write(out);
      return { code: r.status ?? 1, out };
    },
  };
  const [cmd, a, b] = process.argv.slice(2);
  try {
    if (cmd === "check") {
      const s = await check(d);
      console.log(s.available ? `release ${s.available.name} available (running ${s.current?.name})${existsSync(join(d.dir, "next")) ? ": installing now" : ""}` : s.error ? `update check: ${s.error}` : `release: ${s.current?.name ?? "none followed"}, nothing newer`);
    } else if (cmd === "install") {
      const s = await install(d);
      console.log(`update ${s.last?.release}: ${s.last?.outcome}${s.last?.why ? ` (${s.last.why})` : ""}`);
      process.exitCode = s.last?.outcome === "installed" ? 0 : 1;
    } else if (cmd === "pin" && a && b) {
      console.log(pinTo(d, a, b, git(product, ["rev-parse", "HEAD"]).trim()));
    } else {
      console.error("usage: node kernel/src/updates.ts check | install | pin <release> <distro sha>");
      process.exitCode = 2;
    }
  } catch (e) {
    console.error(`update: ${e instanceof Refused ? "refused: " : ""}${(e as Error).message.split("\n")[0]}`);
    process.exitCode = e instanceof Refused ? 3 : 1;
  }
}
