// `docker exec --env-file <f> -w /workspace <box> sh -c <scrub> aidenhq-computer /opt/aidenhq/engine/bin/engine /aidenhq-out/job`:
// a box job's turn, the engine played here. The box is the fake launcher's ($FAKE_BOXES/<box>.json: its task folder and out
// folder, gone or not). Logs what it got (its own env's names, the env file's names, the argv, the job spec), then does what
// $FAKE_STEP says: `slow` works until the test writes "release" next to the step file; `symlink` makes the events file a link
// to a host file ($FAKE_SECRET). It answers in the job dir (/aidenhq-out/job, the launcher's outDir/job on the host), as an
// engine does.
import { appendFileSync, existsSync, readFileSync, rmSync, symlinkSync } from "node:fs";
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
const jobDir = join(box.outDir, "job");
const spec = JSON.parse(readFileSync(join(jobDir, "job.json"), "utf8"));
const emit = (e) => appendFileSync(join(jobDir, "events.jsonl"), `${JSON.stringify(e)}\n`);
log("docker", { argv: args, clientEnv: Object.keys(process.env), envFile: readFileSync(envFile, "utf8").split("\n").filter(Boolean).map((l) => l.split("=")[0]), prompt: spec.prompt, spec });
process.on("SIGTERM", () => process.exit(143));
const step = existsSync(process.env.FAKE_STEP) ? readFileSync(process.env.FAKE_STEP, "utf8").trim() : "";
if (step === "symlink") symlinkSync(process.env.FAKE_SECRET, join(jobDir, "events.jsonl"));
else emit({ t: "session", id: `thread-${container}` });
if (step === "slow") {
  const release = join(dirname(process.env.FAKE_STEP), "release");
  while (!existsSync(release)) await new Promise((r) => setTimeout(r, 20));
  rmSync(release);
}
if (step !== "symlink") emit({ t: "final", text: "Box reply: the page lists the apps." });
