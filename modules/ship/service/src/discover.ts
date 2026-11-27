// Zero-config discovery for the deterministic repair (spec §3 "Generated files"): which paths are generated and which command
// regenerates them, read from the target branch's own files (never the PR's). Pure: the caller hands it the files it read.
//   globs:     `.gitattributes` `linguist-generated` and the known lockfiles only: the repo declared those, so the repair may write
//              them. Anything wider is a loosening, the owner's `generated` setting.
//   commands:  per package dir, the first of: a CI job that checks generated code is up to date, a command AGENTS.md names, a
//              Makefile `generate` target, a package.json `generate` script, `go:generate` directives (go generate ./...)
//   ambiguous: what discovery couldn't settle (the Engineer proposes the command with ship_configure; the setting wins from then on)
//   suggest:   the repo's own regenerate workflow, as an `actions` step for the report to propose (never enabled here)
export const LOCKFILES = ["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "go.sum", "Cargo.lock", "poetry.lock", "uv.lock"];

// The `github.repair` request's limits (modules/github/schemas/repair.json, plan).
const MAX_GLOBS = 200, MAX_GLOB_LEN = 300, MAX_COMMANDS = 20, MAX_DIR_LEN = 300, MAX_CMD_LEN = 500;

export type Suggestion = { stage: "conflict" | "behind"; step: { workflow: string; inputs: Record<string, string> }; from: string };
export type Discovered = { globs: string[]; commands: { dir: string; cmd: string }[]; ambiguous: string[]; suggest: Suggestion[] };

const dirOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : ".");
const base = (p: string) => p.slice(p.lastIndexOf("/") + 1);
// A CI job that checks generated code (its id or name): "generated code up to date", "check-generated", "codegen", …
const GEN_JOB = /generat|codegen/i;
// A whole snippet that is a generate command and nothing else (AGENTS.md's examples).
const WHOLE = /^(make (generate|gen|codegen)|(npm|pnpm|yarn) (run )?(generate|gen|codegen)|go generate( \.\/\.\.\.)?|buf generate)$/;
const GEN_RUN = /\b(make\s+(generate|gen|codegen)\b|(npm|pnpm|yarn)\s+(run\s+)?(generate|gen|codegen)\b|go\s+generate\b|buf\s+generate\b)/;

/** `files`: path → text, from the target branch (`.gitattributes`, `.github/workflows/*`, Makefiles, package.json, go files, …). */
export function discover(files: Record<string, string>): Discovered {
  // The lockfiles first: they stay when the list is capped below.
  const globs = new Set<string>(LOCKFILES.map((l) => `**/${l}`));
  const ambiguous: string[] = [];
  for (const [path, text] of Object.entries(files)) {
    if (base(path) === ".gitattributes") {
      const at = dirOf(path);
      for (const line of text.split("\n")) {
        const [pattern, ...attrs] = line.trim().split(/\s+/);
        if (!pattern || pattern.startsWith("#")) continue;
        if (!attrs.some((a) => a === "linguist-generated" || a === "linguist-generated=true")) continue;
        const p = pattern.replace(/^\//, "");
        // A pattern with no slash matches at any depth under its .gitattributes (git's rule), a nested one's too.
        const rel = pattern.startsWith("/") || p.includes("/") ? p : `**/${p}`;
        globs.add(at === "." ? rel : `${at}/${rel}`);
      }
    }
  }

  const byDir = new Map<string, string>();
  const put = (dir: string, cmd: string) => {
    if (dir.length > MAX_DIR_LEN || cmd.length > MAX_CMD_LEN) { ambiguous.push(`${dir}: \`${cmd.slice(0, 60)}…\` is too long for the repair request`); return; }
    if (!byDir.has(dir)) byDir.set(dir, cmd);
  };
  // 1. CI: the run lines of a job that checks generated code (the repo's own word for how to regenerate).
  for (const [path, text] of Object.entries(files)) {
    if (!/^\.github\/workflows\/[^/]+\.ya?ml$/.test(path)) continue;
    for (const job of jobsOf(text)) {
      if (!GEN_JOB.test(job.id) && !GEN_JOB.test(job.name)) continue;
      const runs = job.runs.filter((r) => GEN_RUN.test(r.cmd));
      // The command with its own arguments, up to the next shell operator (`go generate ./...`, not `go generate`), in its own
      // step's folder. Quoting or expansion in it is beyond this reading: the Engineer proposes the command instead.
      const cmd = runs.length === 1 ? /[^;&|]*/.exec(runs[0]!.cmd.slice(runs[0]!.cmd.search(GEN_RUN)))![0].trim() : "";
      if (cmd && !/["'`$\\]/.test(cmd)) put(runs[0]!.dir, cmd);
      else if (runs.length) ambiguous.push(`${path}: job ${job.id} ${runs.length > 1 ? `runs ${runs.length} generate commands` : "runs a generate command this can't read plainly"}`);
      else if (runs.length > 1) ambiguous.push(`${path}: job ${job.id} runs ${runs.length} generate commands`);
    }
  }
  // 2. AGENTS.md: a plain generate command it names (in code), for its own dir.
  for (const [path, text] of Object.entries(files)) {
    if (base(path) !== "AGENTS.md") continue;
    const m = /`([^`\n]*)`/g;
    for (let x = m.exec(text); x; x = m.exec(text)) if (WHOLE.test(x[1]!.trim())) { put(dirOf(path), x[1]!.trim()); break; }
  }
  // 3. Build files, per package dir.
  for (const [path, text] of Object.entries(files)) {
    const dir = dirOf(path);
    if (/^(GNU)?[Mm]akefile$/.test(base(path)) && /^generate\s*:/m.test(text)) put(dir, "make generate");
    if (base(path) === "package.json") { try { if (JSON.parse(text)?.scripts?.generate) put(dir, "npm run generate"); } catch {} }
  }
  for (const [path, text] of Object.entries(files)) {
    if (!path.endsWith(".go") || !/^\/\/go:generate /m.test(text)) continue;
    // The Go module the directive sits in: the nearest go.mod above it.
    let dir = dirOf(path);
    while (dir !== "." && !(`${dir}/go.mod` in files)) dir = dirOf(dir);
    put(dir, "go generate ./...");
  }
  // The repair request takes at most MAX_GLOBS paths of MAX_GLOB_LEN characters and MAX_COMMANDS commands: past that the rest is
  // left out and said, loudly (the owner or the Engineer sets `generated` with wider globs), never a request that fails every pass.
  const fit = [...globs].filter((g) => g.length <= MAX_GLOB_LEN);
  const kept = fit.slice(0, MAX_GLOBS);
  if (kept.length < globs.size) ambiguous.push(`${globs.size - kept.length} generated path(s) are left out of the repair (its request holds ${MAX_GLOBS} paths of up to ${MAX_GLOB_LEN} characters): set \`generated.globs\` with wider globs`);
  const commands = [...byDir].map(([dir, cmd]) => ({ dir, cmd }));
  if (commands.length > MAX_COMMANDS) ambiguous.push(`${commands.length - MAX_COMMANDS} generate command(s) are left out of the repair (its request holds ${MAX_COMMANDS}): set \`generated.command\``);
  return { globs: kept, commands: commands.slice(0, MAX_COMMANDS), ambiguous, suggest: suggestions(files) };
}

const REGEN = /\b(rebase|regenerat|generat|codegen)/i;
/** The repo's own regenerate paths, from its workflows: a workflow_dispatch workflow that rebases or regenerates, proposed with the
 * PR's number as its input that names the PR (`pr`, `pr_number`, `pull_request`, …; a hook runs on the base branch, so an input
 * is how it knows the PR; a workflow without one is left to the owner). Proposed in the report as `actions` steps; enabling one is the owner's or an agent's ship_configure. */
function suggestions(files: Record<string, string>): Suggestion[] {
  const out: Suggestion[] = [];
  for (const [path, text] of Object.entries(files)) {
    if (!/^\.github\/workflows\/[^/]+\.ya?ml$/.test(path)) continue;
    const name = base(path);
    const regen = REGEN.test(name) || jobsOf(text).some((j) => j.runs.some((r) => GEN_RUN.test(r) || /\bgit\s+rebase\b/.test(r)));
    const after = text.slice(Math.max(0, text.search(/\bworkflow_dispatch:/)));
    const input = /^\s+((?:pr|pull)(?:[_-]?(?:number|request))?):\s*$/im.exec(after)?.[1];
    if (input && regen) out.push({ stage: "conflict", step: { workflow: name, inputs: { [input]: "{pr}" } }, from: path });
  }
  return out;
}

/**
 * A workflow's jobs, read just enough: each job's id, name and `run:` lines (one-line and block scalars), each with its own
 * working directory (the step's `working-directory`, else the job's `defaults.run.working-directory`, else the root).
 */
function jobsOf(yaml: string) {
  type Step = { dir?: string; runs: string[] };
  const jobs: { id: string; name: string; dir: string; steps: Step[]; runs: { cmd: string; dir: string }[] }[] = [];
  let inJobs = false, jobIndent = -1, cur: (typeof jobs)[number] | undefined, step: Step | undefined, stepIndent = -1, inSteps = false, block: { indent: number } | undefined;
  const clean = (d: string) => d.replace(/^\.\//, "").replace(/\/$/, "") || ".";
  for (const raw of yaml.split("\n")) {
    const indent = raw.length - raw.trimStart().length;
    const line = raw.trim();
    if (block) {
      if (line && indent > block.indent) { step?.runs.push(line); continue; }
      if (!line) continue;
      block = undefined;
    }
    if (/^jobs:\s*$/.test(raw)) { inJobs = true; continue; }
    if (!inJobs || !line || line.startsWith("#")) continue;
    if (indent === 0) { inJobs = false; continue; }
    if (jobIndent < 0 || indent === jobIndent) {
      const m = /^([\w-]+):\s*$/.exec(line);
      if (m) { jobIndent = indent; cur = { id: m[1]!, name: "", dir: ".", steps: [], runs: [] }; jobs.push(cur); step = undefined; stepIndent = -1; inSteps = false; continue; }
    }
    if (!cur) continue;
    // The job's own keys: `steps:` opens its steps; any other key at that indent (needs, defaults, …) closes them.
    if (indent === jobIndent + 2 && !line.startsWith("- ")) { inSteps = /^steps:\s*$/.test(line); step = undefined; stepIndent = -1; }
    // A new step: a list item at the steps' indent, inside `steps:`.
    if (inSteps && line.startsWith("- ") && (stepIndent < 0 || indent <= stepIndent) && indent > jobIndent + 2) { stepIndent = indent; step = { runs: [] }; cur.steps.push(step); }
    const name = /^name:\s*["']?(.+?)["']?\s*$/.exec(line);
    if (name && !cur.name && indent === jobIndent + 2) cur.name = name[1]!;
    const wd = /^(?:-\s+)?working-directory:\s*["']?(.+?)["']?\s*$/.exec(line);
    if (wd) { if (step && indent >= stepIndent) step.dir = clean(wd[1]!); else cur.dir = clean(wd[1]!); }
    const run = /^(?:-\s+)?run:\s*(.*)$/.exec(line);
    if (run && step) {
      if (/^[|>][-+]?$/.test(run[1]!.trim())) block = { indent };
      else step.runs.push(run[1]!.trim().replace(/^(["'])(.*)\1$/, "$2"));
    }
  }
  for (const j of jobs) j.runs = j.steps.flatMap((st) => st.runs.map((cmd) => ({ cmd, dir: st.dir ?? j.dir })));
  return jobs;
}
