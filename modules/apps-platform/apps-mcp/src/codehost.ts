// Repos on this server (codehost-local, product docs/design/codehost-local.md §6): the org `local`'s bare repos, mounted
// read-only at /codehost. apps-mcp only reads them: an app's branch for its deploys, and its change requests (refs
// refs/changes/<n>/{head,base,meta,merged,closed}, written by the runner alone) for previews and the board's PR reads.
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { promisify } from "node:util";
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
