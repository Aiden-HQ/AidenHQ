// An agent's Handbook tab reads (web/src/AgentHandbook.tsx): its main handbook (the module's, a local module's or the
// owner's fork), the owner's rules, the compiled text the agent really gets, and the git history of the instance's files.
// Where the board reads from: the board container mounts neither the module sources nor the instance repo by default, so
// BOARD_MODULES_DIR (product modules/) and BOARD_INSTANCE_DIR (the instance checkout) are read-only mounts the compose file
// adds. Without them the compiled text (Paperclip's instructions-bundle GET) is split at "## Instance rules"; without a
// `git` binary in the image the history is empty and says so.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { parse as parseYaml } from "yaml";

const run = promisify(execFile);
const RULES_HEADING = "\n\n## Instance rules\n\n";

export interface Handbook {
  kind: "module" | "local";
  main: { text: string; source: "module" | "fork" | "local"; module?: string; revision?: string };
  rules: string | null;
  compiled: string | null;
  /** `moduleText`: the module's current handbook, set when it moved on (what Update would restore). */
  fork: { base: string; moduleMovedOn: boolean; moduleText?: string } | null;
}
export interface HistoryRow {
  sha: string;
  at: string;
  subject: string;
  files: string[];
  source: "instance" | "module";
  /** Which text the commit changed, and that file's content after it and before it (a revert files `before`). */
  kind?: "rules" | "handbook";
  after?: string | null;
  before?: string | null;
}
export interface HandbookDirs { modules?: string; instance?: string }
export interface HandbookInput {
  key: string;
  /** The agent's module (metadata.module), and whether it is a local one (metadata.tier: the instance's modules/<module>/). */
  module: string;
  local: boolean;
  revision?: string | null;
  compiled: string | null;
  dirs: HandbookDirs;
}

const read = (path: string): string | null => (existsSync(path) ? readFileSync(path, "utf8") : null);
const stripFrontmatter = (s: string) => s.replace(/^---\n[\s\S]*?\n---\n?/, "").trim();
/** git's blob id of a file, so the fork's base compares without git. */
const blobSha = (path: string) => {
  const b = readFileSync(path);
  return createHash("sha1").update(`blob ${b.length}\0`).update(b).digest("hex");
};

/** `overrides.agents.<key>.handbook_fork` from the instance's instance.yaml. */
function forkBase(instance: string, key: string): string | null {
  const text = read(join(instance, "instance.yaml"));
  if (!text) return null;
  const v = (parseYaml(text) as { overrides?: { agents?: Record<string, { handbook_fork?: unknown }> } } | null)?.overrides?.agents?.[key]?.handbook_fork;
  return typeof v === "string" && v ? v : null;
}

export function handbook({ key, module, local, revision, compiled, dirs }: HandbookInput): Handbook {
  const { modules, instance } = dirs;
  if (local) {
    const own = instance ? read(join(instance, localHandbook(module, key))) : null;
    const text = own ?? (compiled ?? "");
    return { kind: "local", main: { text, source: "local", module }, rules: text, compiled, fork: null };
  }
  const rules = instance ? read(join(instance, "agents", `${key}.md`)) : null;
  const moduleFile = modules ? join(modules, module, "agents", key, "AGENTS.md") : "";
  const base = instance ? forkBase(instance, key) : null;
  const fork = instance && base ? read(join(instance, "agents", key, "AGENTS.md")) : null;
  const upstream = moduleFile && existsSync(moduleFile) ? stripFrontmatter(readFileSync(moduleFile, "utf8")) : null;
  const moved = Boolean(moduleFile && existsSync(moduleFile) && blobSha(moduleFile) !== base);
  const split = compiled?.split(RULES_HEADING);
  const main = fork ?? upstream ?? (split ? split[0]! : "");
  return {
    kind: "module",
    main: { text: main, source: fork !== null ? "fork" : "module", module, ...(revision ? { revision } : {}) },
    rules: instance ? rules : (split && split.length > 1 ? split.slice(1).join(RULES_HEADING).trim() : null),
    compiled,
    fork: base && fork !== null ? { base, moduleMovedOn: moved, ...(moved && upstream !== null ? { moduleText: upstream } : {}) } : null,
  };
}

/** A local agent's handbook in the instance repo. */
const localHandbook = (module: string, key: string) => `modules/${module}/agents/${key}/AGENTS.md`;

/**
 * Commits touching the agent's handbook files in the instance repo, newest first; empty when git or the checkout isn't there.
 * `localModule`: a local agent's module, whose one file is its handbook (its rules).
 */
export async function history(key: string, instance: string | undefined, localModule?: string): Promise<{ rows: HistoryRow[]; note?: string }> {
  if (!instance || !existsSync(join(instance, ".git"))) return { rows: [], note: "The instance repo isn't readable from the board, so there is no history here." };
  const files = localModule ? [localHandbook(localModule, key)] : [`agents/${key}.md`, `agents/${key}/AGENTS.md`];
  const git = (...a: string[]) => run("git", ["-c", "safe.directory=*", "-C", instance, ...a], { maxBuffer: 4_000_000 }).then((r) => r.stdout);
  try {
    const log = (await git("log", "-n", "30", "--format=%x1e%H%x1f%aI%x1f%s", "--name-only", "--", ...files)).split("\x1e").filter(Boolean);
    const rows: HistoryRow[] = [];
    for (const entry of log) {
      const [head, ...names] = entry.split("\n");
      const [sha, at, subject] = head!.split("\x1f");
      const touched = names.map((n) => n.trim()).filter(Boolean);
      const file = touched.includes(files[1]!) ? files[1]! : files[0]!;
      const show = (rev: string) => git("show", `${rev}:${file}`).catch(() => null);
      rows.push({ sha: sha!, at: at!, subject: subject!, files: touched, source: "instance", kind: file === files[1] ? "handbook" : "rules", after: await show(sha!), before: await show(`${sha}^`) });
    }
    return { rows };
  } catch {
    return { rows: [], note: "git isn't available to the board, so there is no history here." };
  }
}
