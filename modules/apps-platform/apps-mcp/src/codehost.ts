// Repos on this server (codehost-local, product docs/design/codehost-local.md §6): the org `local`'s bare repos, mounted
// read-only at /codehost. apps-mcp only reads them: an app's branch for its deploys, and its change requests (refs
// refs/changes/<n>/{head,base,meta,merged,closed}, written by the kernel alone: codehost-local/src/host.ts) for previews and the board's PR reads.
// GitHub repos go through the kernel's typed code host operations (`codeHostOps`), each run as the owner inside the github module:
// no token ever reaches this service.
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { parse } from "yaml";
import type { GitHub, OpenPr } from "./previews.js";

const run = promisify(execFile);
export const LOCAL_ORG = "local";
const NAME = /^[a-z0-9][a-z0-9._-]{0,99}$/i;

/**
 * The mounted repos' root when the instance enables codehost-local (the compiled catalog, `<repo>/config/modules.json`),
 * else undefined: then no `local/*` repo is ever read.
 */
export function localRoot(repoDir: string, mount = process.env.CODEHOST_DIR ?? "/codehost"): string | undefined {
  try {
    const on = (JSON.parse(readFileSync(`${repoDir}/config/modules.json`, "utf8")) as { name?: string; enabled?: boolean }[]).some((m) => m?.name === "codehost-local" && m.enabled === true);
    return on ? mount : undefined;
  } catch {
    return undefined;
  }
}

export const isLocal = (root: string | undefined, repo: string): boolean => !!root && repo.split("/")[0]!.toLowerCase() === LOCAL_ORG;

/** The bare repo of `local/<name>` under the mount (a name that isn't one is refused). */
export function localRepo(root: string, repo: string): string {
  const [org, name, ...rest] = repo.split("/");
  if (org?.toLowerCase() !== LOCAL_ORG || rest.length || !NAME.test(name ?? "") || name!.endsWith(".git") || /^\.+$/.test(name!)) throw new Error(`not a local repository: ${repo}`);
  return `${root}/${LOCAL_ORG}/${name}.git`;
}

/** git on a mounted bare repo: read-only commands, its owner (the host user) trusted for this one repo only. */
const git = (bare: string, args: string[]) =>
  run("git", ["-c", `safe.directory=${bare}`, "--git-dir", bare, ...args], { env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" }, maxBuffer: 8e6 }).then((o) => o.stdout.trim());

export type LocalChange = { repo: string; number: number; state: "open" | "merged" | "closed"; head: string; base: string; into: string; branch: string; draft: boolean; opened_at: string; closed_at: string | null };

/** Every change request of `local/<name>`, newest first; none when the repo isn't there. */
export async function localChanges(root: string, repo: string): Promise<LocalChange[]> {
  const bare = localRepo(root, repo);
  if (!existsSync(bare)) return [];
  const refs = new Map<number, Record<string, string>>();
  for (const line of (await git(bare, ["for-each-ref", "--format=%(objectname) %(refname)", "refs/changes/"])).split("\n").filter(Boolean)) {
    const m = /^([0-9a-f]{40}) refs\/changes\/(\d+)\/(head|base|meta|merged|closed)$/.exec(line);
    if (m) refs.set(Number(m[2]), { ...refs.get(Number(m[2])), [m[3]!]: m[1]! });
  }
  const out: LocalChange[] = [];
  for (const [number, r] of [...refs].sort((a, b) => b[0] - a[0])) {
    if (!r.head) continue;
    const meta = r.meta ? JSON.parse((await git(bare, ["cat-file", "blob", r.meta]).catch(() => "")) || "{}") : {};
    const state = r.merged ? "merged" : r.closed ? "closed" : "open";
    const closedAt = state === "open" ? null : await git(bare, ["log", "-1", "--format=%cI", r.merged ?? r.head]).catch(() => null);
    out.push({ repo, number, state, head: r.head, base: r.base ?? "", into: String(meta.base ?? ""), branch: String(meta.branch ?? ""), draft: meta.draft === true, opened_at: String(meta.opened_at ?? ""), closed_at: closedAt });
  }
  return out;
}

/** The `local/*` repos under the mount. */
export function localRepos(root: string, list: (dir: string) => string[]): string[] {
  try {
    return list(`${root}/${LOCAL_ORG}`).filter((f) => f.endsWith(".git")).map((f) => `${LOCAL_ORG}/${f.slice(0, -4)}`).filter((r) => NAME.test(r.split("/")[1]!));
  } catch {
    return [];
  }
}

/**
 * Previews' source for local apps (previews.ts's GitHub interface): the open change requests, and no comment at all (the
 * preview's URL and status stay on its row; the board shows them). Every other repo goes to `other`.
 */
export function withLocal(root: string | undefined, other: GitHub | undefined): GitHub {
  return {
    openPrs: async (repo) => {
      if (isLocal(root, repo)) return (await localChanges(root!, repo)).filter((c) => c.state === "open").map((c): OpenPr => ({ number: c.number, sha: c.head, base: c.into, head_repo: repo }));
      if (!other) throw new Error(`no code host reads ${repo}`);
      return other.openPrs(repo);
    },
    comment: async (repo, pr, body, id) => {
      if (isLocal(root, repo)) return id ?? 0;
      if (!other) throw new Error(`no code host reads ${repo}`);
      return other.comment(repo, pr, body, id);
    },
  };
}

function readSettings(instanceDir: string): Record<string, unknown> | undefined {
  const f = join(instanceDir, "instance.yaml");
  return existsSync(f) ? (parse(readFileSync(f, "utf8")) as { settings?: Record<string, unknown> } | null)?.settings : undefined;
}

/** The fleet org: settings.github_fleet_org; unset means none. */
export function readFleetOrg(instanceDir: string): string | undefined {
  return (readSettings(instanceDir)?.github_fleet_org as string) || undefined;
}

/** settings.github_orgs: the GitHub orgs/users apps may be built from, besides the fleet org. */
export function readOrgs(instanceDir: string): string[] {
  const v = readSettings(instanceDir)?.github_orgs;
  return Array.isArray(v) ? v.map(String) : [];
}

/** The kernel's typed GitHub operations under this module's `codehost:` grant (POST /v1/codehost/:op, owner authority). */
export interface CodeHostOps {
  /** The sha a branch points at. */
  head: (repo: string, branch: string) => Promise<string>;
  /** Fetches `ref` (refs/heads/*, refs/heads/<b> or refs/pull/<n>/head) into the bare/regular repo at `gitDir`: branches land in refs/remotes/origin/*, a pull head in refs/remotes/pr/head. */
  fetch: (repo: string, ref: string, gitDir: string) => Promise<void>;
  read: (repo: string, body: { kind: "prs" }) => Promise<{ number: number; sha: string; base: string; head_repo: string | null }[]>;
  /** Posts a comment, or edits comment `id`; the comment's id. */
  comment: (repo: string, number: number, body: string, id?: number) => Promise<number>;
  /** One file committed to `branch` on top of `parent` (409 when the branch moved); the new commit's sha. */
  commit: (a: { repo: string; branch: string; path: string; content: string; parent: string; message: string }) => Promise<string>;
}

export function codeHostOps(kernelUrl: string, key: string, fetchImpl: typeof fetch = fetch): CodeHostOps {
  const call = async (op: string, body: object): Promise<Response> => {
    const r = await fetchImpl(`${kernelUrl}/v1/codehost/${op}`, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(10 * 60_000) });
    if (!r.ok) {
      const b = (await r.json().catch(() => ({}))) as any;
      throw Object.assign(new Error(`the kernel said ${r.status} to ${op}: ${String(b?.error?.message ?? b?.error ?? "").slice(0, 300)}`.trim()), { status: r.status });
    }
    return r;
  };
  const json = async (op: string, body: object): Promise<any> => (await call(op, body)).json();
  return {
    head: async (repo, ref) => String((await json("head", { repo, ref })).sha),
    fetch: async (repo, ref, gitDir) => {
      const pull = ref.startsWith("refs/pull/");
      const dest = pull ? "refs/remotes/pr/head" : ref === "refs/heads/*" ? "refs/remotes/origin/*" : `refs/remotes/origin/${ref.slice("refs/heads/".length)}`;
      const dir = mkdtempSync(join(tmpdir(), "bundle-"));
      try {
        const file = join(dir, "repo.bundle");
        writeFileSync(file, Buffer.from(await (await call("fetch", { repo, ref })).arrayBuffer()));
        await run("git", ["-c", "core.hooksPath=/dev/null", `--git-dir=${gitDir}`, "fetch", ...(ref === "refs/heads/*" ? ["--prune"] : []), file, `+${ref}:${dest}`], { env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" }, maxBuffer: 20e6, timeout: 300_000 });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    read: async (repo, b) => json("read", { repo, ...b }),
    comment: async (repo, number, body, id) => Number((await json("comment", { repo, number, body, ...(id ? { id } : {}) })).id),
    commit: async (a) => String((await json("commit", a)).sha),
  };
}
