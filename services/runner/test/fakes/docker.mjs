// `docker exec -i --env-file <f> -w /workspace <box> sh -c <scrub> aidenhq-computer codex exec …`: a box job's agent turn.
// The box is the fake launcher's ($FAKE_BOXES/<box>.json: its task folder and out folder, gone or not). Logs what it got (its
// own env's names, the env file's names, the argv), then does what $FAKE_STEP says: `slow` works until the test writes
// "release" next to the step file; `symlink` answers with a link to a host file ($FAKE_SECRET) instead of a message. It answers
// in the box's /aidenhq-out/last.txt (the launcher's outDir on the host), as Codex's -o does.
import { existsSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { log } from "./lib.mjs";

const args = process.argv.slice(2);
const envFile = args[args.indexOf("--env-file") + 1];
const container = args[args.indexOf("-w") + 2];
const file = join(process.env.FAKE_BOXES, `${container}.json`);
const box = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { gone: true };
if (box.gone || box.die) {
  console.error(`Error response from daemon: container ${container} is not running`);
  process.exit(1);
}
const prompt = readFileSync(0, "utf8");
log("docker", { argv: args, clientEnv: Object.keys(process.env), envFile: readFileSync(envFile, "utf8").split("\n").filter(Boolean).map((l) => l.split("=")[0]), prompt });
console.log(JSON.stringify({ type: "thread.started", thread_id: `thread-${container}` }));
process.on("SIGTERM", () => process.exit(143));
const step = existsSync(process.env.FAKE_STEP) ? readFileSync(process.env.FAKE_STEP, "utf8").trim() : "";
if (step === "slow") {
  const release = join(dirname(process.env.FAKE_STEP), "release");
  while (!existsSync(release)) await new Promise((r) => setTimeout(r, 20));
  rmSync(release);
}
const last = join(box.outDir, "last.txt");
if (step === "symlink") symlinkSync(process.env.FAKE_SECRET, last);
else writeFileSync(last, "Box reply: the page lists the apps.");
console.log(JSON.stringify({ type: "turn.completed" }));
