// The agent's side of a Codex turn (codex exec --json, from fakes/codex.mjs): the runner's prompt on stdin. It does what
// $FAKE_STEP says (first line: what to do in acme/app; then any `aidenhq …` commands to run, as the agent would from its
// shell), and replies: Codex's JSON events on stdout, its last message in the -o file.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { log } from "./lib.mjs";

export async function agent(args, prompt) {
const out = (event) => console.log(JSON.stringify(event));
const thread = args[1] === "resume" ? args[2] : "session-1";
// A session Codex has no record of (one from before the Engineer had a computer): Codex's own error, and no turn.
if (thread.startsWith("gone-")) {
  log("agent", { argv: args, prompt });
  console.error(`Error: thread/resume: thread/resume failed: no rollout found for thread id ${thread} (code -32600)`);
  process.exit(1);
}
log("agent", { argv: args, prompt });
out({ type: "thread.started", thread_id: thread });

const repo = [join(process.cwd(), "app"), join(process.cwd(), "acme/app")].find((d) => existsSync(join(d, ".git")));
const git = (...a) => spawnSync("git", ["-C", repo, ...a], { stdio: "ignore" });
log("workspace", { repo });
/** policy.txt: two identical blocks; `allowed` (0 or 1) is the one whose last line says allow = true. */
const policy = (allowed) => [0, 1].map((i) => `# block ${i}\n\nx1\nx2\nx3\nallow = ${i === allowed}\ny1\ny2\ny3\n`).join("\n");
const [step, ...tools] = (existsSync(process.env.FAKE_STEP) ? readFileSync(process.env.FAKE_STEP, "utf8").trim() : "commit").split("\n");
if (step === "commit") {
  git("switch", "-qc", "fix/remove-legacy", "origin/main");
  writeFileSync(join(repo, "chains.txt"), "chain\n");
  git("add", "chains.txt");
  git("commit", "-qm", "fix: drop Legacy");
} else if (step === "second") {
  git("switch", "-qc", "feat/second", "origin/main");
  writeFileSync(join(repo, "second.txt"), "second\n");
  git("add", "second.txt");
  git("commit", "-qm", "feat: second change");
} else if (step === "third") {
  git("switch", "-qc", "feat/third", "origin/main");
  writeFileSync(join(repo, "third.txt"), "third\n");
  git("add", "third.txt");
  git("commit", "-qm", "feat: third change");
} else if (step === "fourth") {
  git("switch", "-qc", "feat/fourth", "origin/main");
  writeFileSync(join(repo, "fourth.txt"), "fourth\n");
  git("add", "fourth.txt");
  git("commit", "-qm", "feat: fourth change");
} else if (step === "ui") {
  git("switch", "-qc", "feat/ui", "origin/main");
  mkdirSync(join(repo, "web"), { recursive: true });
  writeFileSync(join(repo, "web/app.css"), "body { margin: 0 }\n");
  git("add", "web/app.css");
  git("commit", "-qm", "feat: restyle the page");
} else if (step === "ui-more") {
  git("switch", "-q", "feat/ui");
  writeFileSync(join(repo, "web/app.css"), `body { margin: ${Date.now() % 7}px }\n`);
  git("add", "web/app.css");
  git("commit", "-qm", "feat: restyle the page, again");
} else if (step === "ui-card") {
  git("switch", "-qc", "feat/ui-card", "origin/main");
  mkdirSync(join(repo, "web"), { recursive: true });
  writeFileSync(join(repo, "web/card.css"), ".card { padding: 1rem }\n");
  git("add", "web/card.css");
  git("commit", "-qm", "feat: a card style");
} else if (step === "ui-card-more") {
  git("switch", "-q", "feat/ui-card");
  writeFileSync(join(repo, "web/card.css"), `.card { padding: ${2 + (Date.now() % 4)}rem }\n`);
  git("add", "web/card.css");
  git("commit", "-qm", "feat: a card style, tidied");
} else if (step === "ui-next") {
  git("switch", "-q", "feat/ui");
  writeFileSync(join(repo, "web/app.css"), `body { margin: ${Date.now() % 7}px; padding: 0 }\n`);
  git("add", "web/app.css");
  git("commit", "-qm", "feat: restyle the page, once more");
} else if (step === "ui-fix") {
  git("switch", "-q", "feat/ui");
  writeFileSync(join(repo, "web/app.css"), "body { margin: 0; padding: 8px }\n");
  git("add", "web/app.css");
  git("commit", "-qm", "fix: what the design review flagged");
} else if (step === "more") {
  git("switch", "-q", "feat/third");
  writeFileSync(join(repo, "more.txt"), "more\n");
  git("add", "more.txt");
  git("commit", "-qm", "feat: more of the third change");
} else if (step === "again") {
  git("switch", "-q", "feat/third");
  writeFileSync(join(repo, "again.txt"), `${Date.now()}\n`);
  git("add", "again.txt");
  git("commit", "-qm", "feat: the third change again");
} else if (step === "amend") {
  // Rewrites the pushed commit, as a rebase does.
  git("switch", "-q", "fix/remove-legacy");
  writeFileSync(join(repo, "chains.txt"), `chain\n# ${Date.now()}\n`);
  git("add", "chains.txt");
  git("commit", "-q", "--amend", "-m", "fix: drop Legacy");
} else if (step.startsWith("reword ")) {
  // The same change under a new commit: only the message differs.
  git("switch", "-q", step.slice("reword ".length));
  git("commit", "-q", "--amend", "-m", `feat: reworded at ${Date.now()}`);
} else if (step.startsWith("rebase ")) {
  // `rebase <branch>`: onto GitHub's main as it is now, cleanly (the same change on a new base).
  git("fetch", "-q", "origin");
  git("switch", "-q", step.slice("rebase ".length));
  git("rebase", "-q", "origin/main");
} else if (step.startsWith("new ")) {
  // `new <branch> [policy|bytes]`: a branch off GitHub's main with one commit: its own file, the first block of policy.txt
  // allowed, or a file with a byte that isn't UTF-8.
  const [, branch, kind] = step.split(" ");
  git("fetch", "-q", "origin");
  git("switch", "-qc", branch, "origin/main");
  if (kind === "policy") writeFileSync(join(repo, "policy.txt"), policy(0));
  else if (kind === "bytes") writeFileSync(join(repo, "raw.txt"), Buffer.from([0x61, 0x80, 0x0a]));
  else writeFileSync(join(repo, `${branch.replace(/\W/g, "-")}.txt`), `${branch}\n`);
  git("add", "-A");
  git("commit", "-qm", `feat: ${branch}`);
} else if (step.startsWith("write ")) {
  // `write <branch> <path> <text…>`: one commit on <branch> (made off GitHub's main the first time) writing <text> to <path>.
  const [, branch, path, ...text] = step.split(" ");
  git("fetch", "-q", "origin");
  if (git("switch", "-q", branch).status !== 0) git("switch", "-qc", branch, "origin/main");
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), `${text.join(" ")}\n`);
  git("add", "-A");
  git("commit", "-qm", `feat: ${path}`);
} else if (step === "stacked") {
  // A branch stacked on GitHub's `feat/base`, with one commit of its own.
  git("fetch", "-q", "origin");
  git("switch", "-qc", "feat/base", "origin/feat/base");
  git("switch", "-qc", "feat/stacked", "feat/base");
  writeFileSync(join(repo, "stacked.txt"), "stacked\n");
  git("add", "stacked.txt");
  git("commit", "-qm", "feat: stacked change");
} else if (step.startsWith("stale ")) {
  // A stack whose commits are already on main (someone merged it there) but whose workspace still has main where it
  // was: the stacked branch is fetched by name only, and its base branch, gone from GitHub, is made locally.
  const branch = step.slice("stale ".length);
  git("fetch", "-q", "origin", `refs/heads/${branch}:refs/remotes/origin/${branch}`);
  git("switch", "-qc", branch, `origin/${branch}`);
  git("branch", "feat/landed-base", `origin/${branch}~1`);
} else if (step.startsWith("hunk-moved ")) {
  // The approved one-line edit made to policy.txt's other, identical block instead (same hunk text, other place).
  git("fetch", "-q", "origin");
  git("switch", "-q", step.slice("hunk-moved ".length));
  git("reset", "-q", "--hard", "origin/main");
  writeFileSync(join(repo, "policy.txt"), policy(1));
  git("add", "-A");
  git("commit", "-qm", `feat: ${step.slice("hunk-moved ".length)}`);
} else if (step.startsWith("bytes-swapped ")) {
  // Rebased, with the approved invalid byte swapped for another (both decode to the same replacement character).
  git("fetch", "-q", "origin");
  git("switch", "-q", step.slice("bytes-swapped ".length));
  git("rebase", "-q", "origin/main");
  writeFileSync(join(repo, "raw.txt"), Buffer.from([0x61, 0x81, 0x0a]));
  git("add", "-A");
  git("commit", "-q", "--amend", "--no-edit");
} else if (step.startsWith("revert ")) {
  // Rebased, plus an unapproved commit and its revert: the end result is the approved tree.
  git("fetch", "-q", "origin");
  git("switch", "-q", step.slice("revert ".length));
  git("rebase", "-q", "origin/main");
  writeFileSync(join(repo, "evil.txt"), "unapproved\n");
  git("add", "-A");
  git("commit", "-qm", "chore: tweak");
  git("revert", "--no-edit", "HEAD");
} else if (step.startsWith("replace ")) {
  // `replace <branch>`: the branch's commit shown as a harmless sibling (git replace), so plain git reads the sibling.
  const branch = step.slice("replace ".length);
  git("switch", "-q", branch);
  git("switch", "-qc", "sibling", "HEAD~1");
  writeFileSync(join(repo, "readme"), "docs\n");
  git("add", "-A");
  git("commit", "-qm", "docs");
  git("switch", "-q", branch);
  git("replace", branch, "sibling");
} else if (step.startsWith("forge ")) {
  // `forge <branch>`: a hostile agent hides an extra change under a forged origin/main and rebases onto it, so its
  // workspace shows only the approved change against "main".
  const branch = step.slice("forge ".length);
  git("fetch", "-q", "origin");
  git("switch", "-qC", "hidden", "origin/main");
  writeFileSync(join(repo, "hidden.txt"), "unapproved\n");
  git("add", "hidden.txt");
  git("commit", "-qm", "chore: hidden");
  git("update-ref", "refs/remotes/origin/main", "hidden");
  git("switch", "-q", branch);
  git("rebase", "-q", "hidden");
} else if (step.startsWith("describe")) {
  // A PR description in the workspace, with Claude Code's own footer (and an internal name, for "describe-leak").
  mkdirSync(join(process.cwd(), ".aidenhq"), { recursive: true });
  writeFileSync(join(process.cwd(), ".aidenhq/pr-body.md"), `## Why\n\nLegacy is gone.${step === "describe-leak" ? " Tracked in Paperclip." : ""}\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n`);
} else if (step === "report") {
  // A report for Primer and a screenshot for the others to read.
  mkdirSync(join(process.cwd(), ".aidenhq/out"), { recursive: true });
  writeFileSync(join(process.cwd(), ".aidenhq/primer.md"), "# Wallet copy, mapped to the app\n\nWhere each string goes.\n");
  writeFileSync(join(process.cwd(), ".aidenhq/out/move-page.png"), Buffer.from("89504e470d0a1a0a", "hex"));
} else if (step === "report-v2") {
  // The same report, revised.
  writeFileSync(join(process.cwd(), ".aidenhq/primer.md"), "# Wallet copy, mapped to the app\n\nv2\n");
} else if (step === "slow") {
  // Works until the test says so (a "release" file next to the step file), so no test waits on a timer.
  const release = join(dirname(process.env.FAKE_STEP), "release");
  while (!existsSync(release)) await new Promise((r) => setTimeout(r, 20));
  rmSync(release);
}
for (const line of tools) {
  // `hold`: keeps working (after the commands before it) until the test writes the "release" file.
  if (line === "hold") {
    const release = join(dirname(process.env.FAKE_STEP), "release");
    while (!existsSync(release)) await new Promise((r) => setTimeout(r, 20));
    rmSync(release);
    continue;
  }
  const [cmd, ...cmdArgs] = line.split(" ");
  // `emit <Tool> <command…>`: a command the engine shows as a step, as the real agent's are.
  if (cmd === "emit") {
    out({ type: "item.started", item: { type: "command_execution", command: cmdArgs.slice(1).join(" ") } });
    continue;
  }
  const res = spawnSync(cmd, cmdArgs, { cwd: process.cwd(), encoding: "utf8" });
  log("tool", { line, code: res.status, out: (res.stdout ?? "") + (res.stderr ?? "") });
}
const reply = step === "silent" ? "NO_REPLY" : "Checked every repository; nothing needed changing.";
out({ type: "item.completed", item: { type: "agent_message", text: reply } });
out({ type: "turn.completed", usage: { input_tokens: prompt.length, cached_input_tokens: 0, output_tokens: reply.length } });
writeFileSync(args[args.indexOf("-o") + 1], reply);
}
