// The kernel's apply land on this server (kernel/src/apply.ts picks it for the org `local`): the instance repo is a bare repo on
// this host, so the code host's two apply calls are plain git on it, with the codehost-github service's limits and rules.
//   read(s)  what the kernel plans on: the files the commit changes against its merge base with main, the texts its rules read
//            on both sides (each changed file and instance.yaml; absent where the file isn't) and the diff. From git only,
//            never from the requester.
//   land(s)  the commit on main, as a compare-and-swap on main's ref (a commit main already has is a no-op), once.
//   write(w) the owner's typed settings change (kernel/src/settings-change.ts) as a commit on main's head `base`, on `branch`:
//            the texts the kernel computed, nothing else; it lands only through a kernel.apply, like any other.
// The commit is in the bare repo (the release updater's branch), or comes in from the asking job's workspace (`ingest`, git.ts). Repo code never runs: every command carries SAFE_GIT_ARGS, literal pathspecs and no global config.
import { execFile, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { ENV, SAFE_GIT_ARGS, fail } from "./git.ts";
import { APPLY_PATHS } from "../../../kernel/sdk/src/instance-paths.ts";

const run = promisify(execFile);
const MAX_TEXT = 1 << 20, MAX_TOTAL = 8 << 20, MAX_FILES = 200;
const SHA = /^[0-9a-f]{40}$/;
const BRANCH = /^settings\/[a-z0-9][a-z0-9-]{0,80}$/;

type Source = { repo: string; branch: string; sha: string; workspace?: string };
type Pin = { repo: string; sha: string } | null;

/** `bare`: the instance repo's bare git dir on this host; `instanceRepo`: its slug (local/<name>); `ingest`: a job's branch from its workspace. */
export function localApply({ bare, instanceRepo, ingest }: { bare: string; instanceRepo: string; ingest?: (s: Source & { workspace: string }) => Promise<unknown> }) {
  const git = async (args: string[], maxBuffer = 64 * 1024 * 1024) => (await run("git", [...SAFE_GIT_ARGS, "--git-dir", bare, ...args], { env: ENV, maxBuffer })).stdout;
  const g = async (args: string[]) => (await git(args)).trim();

  async function commit(s: Source) {
    if (String(s.repo).toLowerCase() !== instanceRepo.toLowerCase()) throw fail(403, `an apply lands only on the instance repo (${instanceRepo}), not ${s.repo}`);
    if (!SHA.test(String(s.sha))) throw fail(400, "sha is a full commit sha");
    const has = () => g(["cat-file", "-e", `${s.sha}^{commit}`]).then(() => true, () => false);
    if (!(await has()) && s.workspace && ingest) await ingest({ ...s, workspace: s.workspace });
    if (!(await has())) throw fail(404, `${s.sha.slice(0, 12)} isn't in ${instanceRepo}: push its branch there first`);
    const main = await g(["rev-parse", "--verify", "refs/heads/main^{commit}"]);
    const base = await g(["merge-base", s.sha, main]).catch(() => "");
    if (!base) throw fail(409, `${s.sha.slice(0, 12)} shares no history with the instance's main`);
    return { sha: s.sha, main, base };
  }

  /** A file at a commit: undefined only when the path isn't there; anything but a small regular text file is refused. */
  async function fileAt(rev: string, p: string): Promise<string | undefined> {
    const entry = await g(["ls-tree", "-z", rev, "--", p]);
    if (!entry) return undefined;
    const m = /^(\d{6}) (\w+) ([0-9a-f]{40})\t([^\0]*)\0?$/.exec(entry);
    if (!m || m[4] !== p) throw fail(422, `${p.slice(0, 200)} didn't resolve to exactly that path at ${rev.slice(0, 12)}`);
    if (m[1] !== "100644" || m[2] !== "blob") throw fail(422, `${p.slice(0, 200)} isn't a regular file at ${rev.slice(0, 12)}`);
    const size = Number(await g(["cat-file", "-s", m[3]!]));
    if (!(size <= MAX_TEXT)) throw fail(413, `${p.slice(0, 200)} is too large to review (${size} bytes)`);
    const t = await git(["cat-file", "blob", m[3]!], MAX_TEXT + 1);
    if (t.includes("\0")) throw fail(422, `${p.slice(0, 200)} is binary`);
    return t;
  }

  return {
    async read(s: Source) {
      const c = await commit(s);
      const files = (await git(["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--name-only", "-z", c.base, c.sha])).split("\0").filter(Boolean);
      if (files.length > MAX_FILES) throw fail(413, `the commit changes ${files.length} files; an apply reviews at most ${MAX_FILES}`);
      const texts: { base: Record<string, string>; head: Record<string, string> } = { base: {}, head: {} };
      let budget = MAX_TOTAL;
      for (const p of new Set([...files, "instance.yaml"])) {
        for (const [side, rev] of [["base", c.base], ["head", c.sha]] as const) {
          const t = await fileAt(rev, p);
          if (t === undefined) continue;
          if ((budget -= t.length) < 0) throw fail(413, `the commit's files are too large to review together (over ${MAX_TOTAL} bytes)`);
          texts[side][p] = t;
        }
      }
      const diff = await git(["-c", "core.attributesFile=/dev/null", "diff", "--no-ext-diff", "--no-textconv", "--text", "--no-renames", c.base, c.sha], Math.max(budget, 1)).catch((e: Error & { code?: string }) => {
        throw e.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ? fail(413, `the commit's diff is too large to review (over ${MAX_TOTAL} bytes with its files)`) : e;
      });
      // base and main: the merge base and main's head (the kernel reads base === sha as "already on main").
      return { files, texts, diff, base: c.base, main: c.main };
    },
    /** `official`: the official modules' pin on both sides (apply.ts officialMove). No reviewer-eval gate runs here, so a move is refused. */
    async land(s: Source & { official: { from: Pin; to: Pin } }) {
      const c = await commit(s);
      if (c.base === c.sha) return { landed: c.main };
      if (c.base !== c.main) throw fail(409, "the instance's main moved on since this commit's base; it needs a rebase and a new approval");
      if (JSON.stringify(s.official?.from ?? null) !== JSON.stringify(s.official?.to ?? null)) throw fail(422, "it moves the official modules' marketplace pin, which this server has no reviewer-eval gate for");
      // The compare-and-swap: main moves to the commit only from the main read above.
      await g(["update-ref", "-m", "aidenhq apply", "refs/heads/main", c.sha, c.main]);
      return { landed: c.sha };
    },
    async write(w: { repo: string; base: string; branch: string; files: Record<string, string | null>; message: string }) {
      if (String(w.repo).toLowerCase() !== instanceRepo.toLowerCase()) throw fail(403, `a settings change writes only the instance repo (${instanceRepo}), not ${w.repo}`);
      if (!BRANCH.test(String(w.branch))) throw fail(400, "branch is settings/<task>");
      const paths = Object.keys(w.files ?? {});
      if (!paths.length || paths.some((p) => !APPLY_PATHS.test(p) || (w.files[p] !== null && typeof w.files[p] !== "string"))) throw fail(400, "files: instance config paths, each a text or null");
      const head = await g(["rev-parse", "--verify", "refs/heads/main^{commit}"]);
      if (head !== w.base) throw fail(409, "the instance's main moved on since the change was read; try again");
      const date = await g(["log", "-1", "--format=%cI", head]);
      const tmp = mkdtempSync(join(tmpdir(), "aidenhq-settings-"));
      const env = { ...ENV, GIT_INDEX_FILE: join(tmp, "index"), GIT_AUTHOR_NAME: "AidenHQ settings", GIT_AUTHOR_EMAIL: "settings@aidenhq.invalid", GIT_COMMITTER_NAME: "AidenHQ settings", GIT_COMMITTER_EMAIL: "settings@aidenhq.invalid", GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
      const ix = (args: string[], input = "") => new Promise<string>((ok, no) => {
        const p = spawn("git", [...SAFE_GIT_ARGS, "--git-dir", bare, ...args], { env });
        let out = "", err = "";
        p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (err += d));
        p.on("close", (code) => (code === 0 ? ok(out.trim()) : no(new Error(`git ${args[0]}: ${err.trim().slice(0, 300)}`))));
        p.stdin.on("error", () => {}); // git may exit before reading its input (EPIPE): its exit code is the answer
        p.stdin.end(input);
      });
      try {
        await ix(["read-tree", head]);
        for (const p of paths) {
          const text = w.files[p];
          if (text === null) await ix(["update-index", "--index-info"], `0 0000000000000000000000000000000000000000\t${p}\n`);
          else await ix(["update-index", "--add", "--cacheinfo", `100644,${await ix(["hash-object", "-w", "--stdin"], text)},${p}`]);
        }
        const sha = await ix(["commit-tree", await ix(["write-tree"]), "-p", head], String(w.message ?? "settings").slice(0, 2000));
        await g(["update-ref", `refs/heads/${w.branch}`, sha]);
        return { sha };
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    },
  };
}
