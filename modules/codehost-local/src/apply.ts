// The kernel's apply land on this server (kernel/src/apply.ts picks it for the org `local`): the instance repo is a bare repo on
// this host, so the code host's two apply calls are plain git on it, with the codehost-github service's limits and rules.
//   read(s)  what the kernel plans on: the files the commit changes against its merge base with main, the texts its rules read
//            on both sides (each changed file, the agent.yaml of each agent it touches, instance.yaml; absent where the file
//            isn't), the diff, and the graduation card's trial edits. From git only, never from the requester.
//   land(s)  the commit on main, as a compare-and-swap on main's ref (a commit main already has is a no-op), once.
// The commit must already be in the bare repo (a branch pushed there: the release updater's, a change request's): nothing is
// fetched from elsewhere. Repo code never runs: every command carries SAFE_GIT_ARGS, literal pathspecs and no global config.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const SAFE_GIT_ARGS = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=", "-c", "protocol.ext.allow=never", "-c", "safe.bareRepository=explicit"];
const ENV = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: "/nonexistent", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", GIT_NO_REPLACE_OBJECTS: "1", GIT_GRAFT_FILE: "/dev/null", GIT_SHALLOW_FILE: "/dev/null", GIT_ATTR_NOSYSTEM: "1", GIT_LITERAL_PATHSPECS: "1" };
const MAX_TEXT = 1 << 20, MAX_TOTAL = 8 << 20, MAX_FILES = 200;
const SHA = /^[0-9a-f]{40}$/;
const AGENT = /^agents\/([a-z0-9][a-z0-9-]*)\/(agent\.yaml|AGENTS\.md|memory\.md)$/;

type Source = { repo: string; branch: string; sha: string; workspace?: string };
type Pin = { repo: string; sha: string } | null;
const fail = (status: number, message: string) => Object.assign(new Error(message), { status });

/** `bare`: the instance repo's bare git dir on this host; `instanceRepo`: its slug (local/<name>). */
export function localApply({ bare, instanceRepo }: { bare: string; instanceRepo: string }) {
  const git = async (args: string[], maxBuffer = 64 * 1024 * 1024) => (await run("git", [...SAFE_GIT_ARGS, "--git-dir", bare, ...args], { env: ENV, maxBuffer })).stdout;
  const g = async (args: string[]) => (await git(args)).trim();

  async function commit(s: Source) {
    if (String(s.repo).toLowerCase() !== instanceRepo.toLowerCase()) throw fail(403, `an apply lands only on the instance repo (${instanceRepo}), not ${s.repo}`);
    if (!SHA.test(String(s.sha))) throw fail(400, "sha is a full commit sha");
    if (!(await g(["cat-file", "-e", `${s.sha}^{commit}`]).then(() => true, () => false))) throw fail(404, `${s.sha.slice(0, 12)} isn't in ${instanceRepo}: push its branch there first`);
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

  /** The graduation card's handbook-only commits since each agent's trial began (codehost-github's trialEdits, here). */
  async function trialEdits(base: string, agents: string[], texts: { base: Record<string, string>; head: Record<string, string> }) {
    const isTrial = (t: string | undefined) => t !== undefined && /^trial:[ \t]*true[ \t]*(#.*)?$/m.test(t);
    const out: string[] = [];
    for (const key of agents) {
      const def = `agents/${key}/agent.yaml`, book = `agents/${key}/AGENTS.md`;
      if (!isTrial(texts.base[def]) || texts.head[def] === undefined || isTrial(texts.head[def])) continue;
      const added = (await g(["log", "--diff-filter=A", "--format=%H", base, "--", def])).split("\n").filter(Boolean).pop();
      if (!added) continue;
      const edits: string[] = [];
      for (const sha of (await g(["log", "--first-parent", "--format=%H", `${added}..${base}`, "--", book])).split("\n").filter(Boolean)) {
        const [date, short, ...subject] = (await g(["log", "-1", "--format=%as%x09%h%x09%s", sha])).split("\t");
        const [num] = (await g(["diff", "--no-renames", "--numstat", `${sha}^1`, sha, "--", book])).split("\n").map((l) => l.split("\t"));
        const others = (await g(["diff", "--no-renames", "--name-only", "-z", `${sha}^1`, sha])).split("\0").filter((f) => f && f !== book).length;
        edits.push(`${short}  ${date}  ${subject.join(" ").replace(/[\x00-\x1f\x7f]/g, "").slice(0, 100)}  (+${num?.[0] ?? 0} -${num?.[1] ?? 0})${others ? `  also changed: ${others} other file${others === 1 ? "" : "s"}` : ""}`);
      }
      out.push(`${key}: ${edits.length ? `${edits.length} handbook change${edits.length === 1 ? "" : "s"} since the trial began (those not marked "also changed" landed without a tap):\n${edits.join("\n")}` : "no handbook changes since the trial began."}`);
    }
    return out.length ? `Trial edits that landed without a tap:\n${out.join("\n")}` : "";
  }

  return {
    async read(s: Source) {
      const c = await commit(s);
      const files = (await git(["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--name-only", "-z", c.base, c.sha])).split("\0").filter(Boolean);
      if (files.length > MAX_FILES) throw fail(413, `the commit changes ${files.length} files; an apply reviews at most ${MAX_FILES}`);
      const agents = [...new Set(files.map((f) => AGENT.exec(f)?.[1]).filter(Boolean))] as string[];
      const texts: { base: Record<string, string>; head: Record<string, string> } = { base: {}, head: {} };
      let budget = MAX_TOTAL;
      for (const p of new Set([...files, ...agents.map((k) => `agents/${k}/agent.yaml`), "instance.yaml"])) {
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
      return { files, texts, diff, trial: await trialEdits(c.base, agents, texts) };
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
  };
}
