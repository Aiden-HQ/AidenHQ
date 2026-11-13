// Claude Code with streamed input (--input-format stream-json --replay-user-messages): the first
// message is the runner's prompt. It does what $FAKE_STEP says (first line: what to do in acme/app;
// then any `aidenhq …` commands to run, as the agent would from its shell), and replies. Messages
// that arrive while it works are taken in and answered in the same turn; later ones get a turn each.
// It exits when stdin closes, like the real one.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { log } from "./lib.mjs";

const out = (event) => console.log(JSON.stringify(event));
const lines = [];
let closed = false;
let wake = () => {};
createInterface({ input: process.stdin })
  .on("line", (line) => {
    lines.push(JSON.parse(line).message.content);
    wake();
  })
  .on("close", () => {
    closed = true;
    wake();
  });
const next = () => (lines.length || closed ? Promise.resolve() : new Promise((r) => (wake = r)));
const take = () => {
  const text = lines.shift();
  out({ type: "user", isReplay: true, message: { role: "user", content: text } });
  return text;
};

await next();
const prompt = take();
log("claude", { argv: process.argv.slice(2), prompt });
out({ type: "system", subtype: "init", session_id: "session-1" });

const repo = [join(process.cwd(), "app"), join(process.cwd(), "acme/app")].find((d) => existsSync(join(d, ".git")));
const git = (...args) => spawnSync("git", ["-C", repo, ...args], { stdio: "ignore" });
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
} else if (step.startsWith("describe")) {
  // A PR description in the workspace, with Claude Code's own footer (and an internal name, for "describe-leak").
  mkdirSync(join(process.cwd(), ".aidenhq"), { recursive: true });
  writeFileSync(join(process.cwd(), ".aidenhq/pr-body.md"), `## Why\n\nLegacy is gone.${step === "describe-leak" ? " Tracked in Paperclip." : ""}\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n`);
} else if (step === "report") {
  // A report for Primer and a screenshot for the others to read.
  mkdirSync(join(process.cwd(), ".aidenhq/out"), { recursive: true });
  writeFileSync(join(process.cwd(), ".aidenhq/primer.md"), "# Wallet copy, mapped to the app\n\nWhere each string goes.\n");
  writeFileSync(join(process.cwd(), ".aidenhq/out/move-page.png"), Buffer.from("89504e470d0a1a0a", "hex"));
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
  const res = spawnSync(cmd, cmdArgs, { cwd: process.cwd(), encoding: "utf8" });
  log("tool", { line, code: res.status, out: (res.stdout ?? "") + (res.stderr ?? "") });
}
// Messages that came in while it worked: taken in now, answered in this turn.
const during = [];
while (lines.length) during.push(take());
if (during.length) log("claude-mid-run", during);
const reply = step === "silent" ? "NO_REPLY" : "Checked every repository; nothing needed changing.";
out({ type: "result", subtype: "success", result: during.length ? `${reply}\n\nAlso, as you asked while I worked: ${during.join(" / ")}` : reply });
// Anything after this turn ended gets a turn of its own, until the runner closes the input.
for (;;) {
  await next();
  if (!lines.length && closed) break;
  const text = take();
  out({ type: "result", subtype: "success", result: `On your later note (${text}): done.` });
}
