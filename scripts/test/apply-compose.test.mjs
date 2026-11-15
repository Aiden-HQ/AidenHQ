// ops/apply-compose.sh, the apply's compose step: it removes compose's stopped <12hex>_<project>-<service>-<n> leftovers
// for services this config dropped, and nothing else -- never a CI job's runner (a named one-off that removes itself,
// which is what a deploy raced and died on), never a running container, never one of a service still in the config. It
// retries once only for the daemon's "removal of container ... is already in progress". A fake `docker` on PATH serves
// the container list and records every call, so each test can read exactly what the step asked the daemon to do.
import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const script = join(dirname(fileURLToPath(import.meta.url)), "../../ops/apply-compose.sh");
const ciRunner = "aidenhq-ci-runner-Aiden-HQ-8";
const ciRunnerId = "382e6572c1a0";
const raced = `Container ${ciRunner}\nError response from daemon: removal of container ${ciRunnerId} is already in progress`;

const fake = `#!/usr/bin/env bash
set -uo pipefail
dir=__DIR__
printf 'docker %s\\n' "$*" >> "$dir/calls"
case "$1" in
  compose)
    case "$*" in
      *"config --services"*) cat "$dir/services" ;;
      *"up -d"*)
        n=$(( $(cat "$dir/upcount" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$dir/upcount"
        cat "$dir/up-$n.out" 2>/dev/null
        exit "$(cat "$dir/up-$n.code" 2>/dev/null || echo 0)" ;;
    esac ;;
  ps) cat "$dir/ids" ;;
  inspect)
    id=$(printf '%s' "\${@: -1}")
    case "$*" in
      *'{{.Name}}'*) cat "$dir/name-$id" 2>/dev/null ;;
      *'{{.State.Running}}'*) cat "$dir/running-$id" 2>/dev/null ;;
    esac ;;
  rm)
    id=$(printf '%s' "\${@: -1}")
    if [ -f "$dir/rm-$id" ]; then cat "$dir/rm-$id"; exit 1; fi ;;
esac
exit 0
`;

/**
 * containers: id → { name: what `docker inspect -f '{{.Name}}'` prints, running: "true" | "false" }.
 * services: what `docker compose config --services` lists (the services this apply starts).
 * up: what `docker compose up` does, in order: [output, exit code].
 * rmFails: id → the error `docker rm` gives for it.
 */
function fixture({ containers, services, up, rmFails = {} }) {
  const dir = mkdtempSync(join(tmpdir(), "apply-compose-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(dir, "ids"), `${Object.keys(containers).join("\n")}\n`);
  writeFileSync(join(dir, "services"), `${services.join("\n")}\n`);
  for (const [id, c] of Object.entries(containers)) {
    writeFileSync(join(dir, `name-${id}`), `${c.name}\n`);
    writeFileSync(join(dir, `running-${id}`), `${c.running}\n`);
  }
  for (const [id, err] of Object.entries(rmFails)) writeFileSync(join(dir, `rm-${id}`), `${err}\n`);
  up.forEach(([out, code], i) => {
    writeFileSync(join(dir, `up-${i + 1}.out`), `${out}\n`);
    writeFileSync(join(dir, `up-${i + 1}.code`), `${code}\n`);
  });
  const file = join(bin, "docker");
  writeFileSync(file, fake.replace("__DIR__", JSON.stringify(dir)));
  chmodSync(file, 0o755);
  return { bin, calls: () => readFileSync(join(dir, "calls"), "utf8") };
}

function apply(f) {
  return new Promise((resolve) => {
    execFile("bash", [script], { env: { ...process.env, PATH: `${f.bin}:/usr/bin:/bin`, COMPOSE_PROJECT_NAME: "aidenhq" } }, (error, stdout, stderr) => {
      resolve({ status: error ? error.code : 0, out: `${stdout}${stderr}`, calls: f.calls() });
    });
  });
}

// `ci-runner` is under the inactive `ci` profile, so `up`'s own service list doesn't have it; the finished job's
// container is a named one-off (`docker compose run --name`) removing itself. `orphan1` is the real leftover: compose's
// old <12hex>_aidenhq-whisper-live-mcp-1 name, stopped, for a module this config turned off. Everything else must be
// left alone: a running container of that same dropped service, a stopped one under any other compose name, a stopped
// container of a service still in the config, and a container whose name isn't compose's own.
const services = ["board", "paperclip"];
const containers = {
  board1: { name: "/aidenhq-board-1", running: "true" },
  [ciRunnerId]: { name: `/${ciRunner}`, running: "true" },
  orphan1: { name: "/0123456789ab_aidenhq-whisper-live-mcp-1", running: "false" },
  live1: { name: "/0123456789ab_aidenhq-some-dropped-service-1", running: "true" },
  kept1: { name: "/0123456789ab_aidenhq-paperclip-1", running: "false" },
  second1: { name: "/0123456789ab_aidenhq-some-dropped-service-2", running: "false" },
  other1: { name: "/handmade", running: "false" },
  bare1: { name: "/aidenhq-some-dropped-service-1", running: "false" },
};
const calls = (r, prefix) => r.calls.split("\n").filter((l) => l.startsWith(prefix));
const removals = (r) => calls(r, "docker rm ");

test("the script sources nothing: the project name comes from the inherited environment", () => {
  const code = readFileSync(script, "utf8").split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
  assert.doesNotMatch(code, /^\s*(\.|source)\s/m, "no file is sourced");
  assert.doesNotMatch(code, /\.env\b/, "no .env is read");
  assert.match(code, /COMPOSE_PROJECT_NAME/);
});

test("a mid-removal ci-runner container is never removed, and the step succeeds", async () => {
  const r = await apply(fixture({ containers, services, up: [[raced, 1], ["Container board Started", 0]] }));
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(removals(r), ["docker rm orphan1"], "only the stopped leftover is removed");
  assert.ok(!r.calls.includes(ciRunner), `the ci-runner container reached a command:\n${r.calls}`);
  for (const c of removals(r)) assert.doesNotMatch(c, /-f|--force/, `nothing is force-removed: ${c}`);
  for (const c of calls(r, "docker compose up")) assert.doesNotMatch(c, /--remove-orphans/, c);
  assert.match(r.out, /retrying once/, "the race is retried instead of failing the apply");
});

test("running containers and services still in the config are left alone", async () => {
  const r = await apply(fixture({ containers, services, up: [["Container board Started", 0]] }));
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(removals(r), ["docker rm orphan1"], "only the stopped <12hex>_…-1 leftover is removed");
  assert.deepEqual(calls(r, "docker stop "), [], "nothing is stopped");
});

test("a leftover that is already being removed when apply reaches it is tolerated", async () => {
  const err = "Error response from daemon: removal of container orphan1 is already in progress";
  const r = await apply(fixture({ containers, services, up: [["Container board Started", 0]], rmFails: { orphan1: err } }));
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /whisper-live-mcp was already being removed/);
});

test("a compose failure that is not the removal race still fails the apply, with no retry", async () => {
  const r = await apply(fixture({ containers, services, up: [["Error response from daemon: pull access denied for aidenhq/board", 1]] }));
  assert.equal(r.status, 1, r.out);
  assert.equal(calls(r, "docker compose up").length, 1, "compose ran once");
  assert.deepEqual(removals(r), [], "nothing was removed");
  assert.doesNotMatch(r.out, /retrying/, r.out);
  assert.match(r.out, /pull access denied/);
});

test("the retry is one: a second race still fails the apply", async () => {
  const r = await apply(fixture({ containers, services, up: [[raced, 1], [raced, 1]] }));
  assert.equal(r.status, 1, r.out);
  assert.equal(calls(r, "docker compose up").length, 2, "compose ran twice, never three times");
});
