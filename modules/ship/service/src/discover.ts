// Zero-config discovery for the deterministic repair (spec §3 "Generated files"): which paths are generated and which command
// regenerates them, read from the target branch's own files (never the PR's). Pure: the caller hands it the files it read.
//   globs:     `.gitattributes` `linguist-generated` and the known lockfiles only: the repo declared those, so the repair may write
//              them. Anything wider is a loosening, the owner's `generated` setting.
//   commands:  per package dir, the first of: a CI job that checks generated code is up to date, a command AGENTS.md names, a
//              Makefile `generate` target, a package.json `generate` script, `go:generate` directives (go generate ./...)
//   ambiguous: what discovery couldn't settle (the Engineer proposes the command with ship_configure; the setting wins from then on)
//   suggest:   the repo's own regenerate command or workflow, as an `actions` step for the report to propose (never enabled here)
export const LOCKFILES = ["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "go.sum", "Cargo.lock", "poetry.lock", "uv.lock"];

export type Suggestion = { stage: "conflict" | "behind"; step: { comment: string } | { workflow: string }; from: string };
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
  const globs = new Set<string>();
  const ambiguous: string[] = [];
  for (const [path, text] of Object.entries(files)) {
    if (base(path) === ".gitattributes") {
      const at = dirOf(path);
      for (const line of text.split("\n")) {
        const [pattern, ...attrs] = line.trim().split(/\s+/);
        if (!pattern || pattern.startsWith("#")) continue;
        if (!attrs.some((a) => a === "linguist-generated" || a === "linguist-generated=true")) continue;
        const p = pattern.replace(/^\//, "");
        globs.add(at === "." ? (pattern.startsWith("/") || p.includes("/") ? p : `**/${p}`) : `${at}/${p}`);
      }
    }
  }
  for (const l of LOCKFILES) globs.add(`**/${l}`);

  const byDir = new Map<string, string>();
  const put = (dir: string, cmd: string) => { if (!byDir.has(dir)) byDir.set(dir, cmd); };
  // 1. CI: the run lines of a job that checks generated code (the repo's own word for how to regenerate).
  for (const [path, text] of Object.entries(files)) {
    if (!/^\.github\/workflows\/[^/]+\.ya?ml$/.test(path)) continue;
    for (const job of jobsOf(text)) {
      if (!GEN_JOB.test(job.id) && !GEN_JOB.test(job.name)) continue;
      const runs = job.runs.filter((r) => GEN_RUN.test(r));
      // The command with its own arguments, up to the next shell operator (`go generate ./...`, not `go generate`). Quoting or
      // expansion in it is beyond this reading: the Engineer proposes the command instead.
      const cmd = runs.length === 1 ? /[^;&|]*/.exec(runs[0]!.slice(runs[0]!.search(GEN_RUN)))![0].trim() : "";
      if (cmd && !/["'`$\\]/.test(cmd)) put(job.dir, cmd);
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
  return { globs: [...globs], commands: [...byDir].map(([dir, cmd]) => ({ dir, cmd })), ambiguous, suggest: suggestions(files) };
}

// A comment workflow's command: `startsWith(github.event.comment.body, '/rebase')`, `contains(…, '/rebase')` or `== '/rebase'`.
const SLASH = /comment\.body\s*(?:,\s*|==\s*)['"](\/[\w-]{1,40})['"]/;
const REGEN = /\b(rebase|regenerat|generat|codegen)/i;
/** The repo's own regenerate paths, from its workflows: a slash command that rebases or regenerates (issue_comment), and a
 * workflow_dispatch workflow that does. Proposed in the report as `actions` steps; enabling one is the owner's or an agent's
 * ship_configure. */
function suggestions(files: Record<string, string>): Suggestion[] {
  const out: Suggestion[] = [];
  for (const [path, text] of Object.entries(files)) {
    if (!/^\.github\/workflows\/[^/]+\.ya?ml$/.test(path)) continue;
    const name = base(path);
    const regen = REGEN.test(name) || jobsOf(text).some((j) => j.runs.some((r) => GEN_RUN.test(r) || /\bgit\s+rebase\b/.test(r)));
    const slash = SLASH.exec(text)?.[1];
    if (/\bissue_comment\b/.test(text) && slash && (regen || REGEN.test(slash))) out.push({ stage: "conflict", step: { comment: slash }, from: path });
    else if (/\bworkflow_dispatch\b/.test(text) && regen) out.push({ stage: "conflict", step: { workflow: name }, from: path });
  }
  return out;
}

/** A workflow's jobs, read just enough: each job's id, name, working directory and `run:` lines (one-line and block scalars). */
function jobsOf(yaml: string) {
  const jobs: { id: string; name: string; dir: string; runs: string[] }[] = [];
  const lines = yaml.split("\n");
  let inJobs = false, jobIndent = -1, cur: (typeof jobs)[number] | undefined, block: { indent: number } | undefined;
  for (const raw of lines) {
    const indent = raw.length - raw.trimStart().length;
    const line = raw.trim();
    if (block) {
      if (line && indent > block.indent) { cur?.runs.push(line); continue; }
      if (!line) continue;
      block = undefined;
    }
    if (/^jobs:\s*$/.test(raw)) { inJobs = true; continue; }
    if (!inJobs || !line || line.startsWith("#")) continue;
    if (indent === 0) { inJobs = false; continue; }
    if (jobIndent < 0 || indent === jobIndent) {
      const m = /^([\w-]+):\s*$/.exec(line);
      if (m) { jobIndent = indent; cur = { id: m[1]!, name: "", dir: ".", runs: [] }; jobs.push(cur); continue; }
    }
    if (!cur) continue;
    const name = /^name:\s*["']?(.+?)["']?\s*$/.exec(line);
    if (name && !cur.name && indent === jobIndent + 2) cur.name = name[1]!;
    const wd = /^working-directory:\s*["']?(.+?)["']?\s*$/.exec(line);
    if (wd) cur.dir = wd[1]!.replace(/^\.\//, "").replace(/\/$/, "") || ".";
    const run = /^(?:-\s+)?run:\s*(.*)$/.exec(line);
    if (run) {
      if (/^[|>][-+]?$/.test(run[1]!.trim())) block = { indent };
      else cur.runs.push(run[1]!.trim().replace(/^(["'])(.*)\1$/, "$2"));
    }
  }
  return jobs;
}

