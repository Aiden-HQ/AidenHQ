// ops/compose-recreate.sh, the apply's compose step. A fake `docker` serves the container list, the compose config and
// the build, and records every call, so each test reads exactly what the step asked the daemon to do: which services it
// recreated, that the rest were left alone, and that a leftover is the only thing removed.
import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const script = join(dirname(fileURLToPath(import.meta.url)), "../../ops/compose-recreate.sh");
const ciRunner = "aidenhq-ci-runner-Aiden-HQ-8";
const ciRunnerId = "382e6572c1a0";
const raced = `Container ${ciRunner}\nError response from daemon: removal of container ${ciRunnerId} is already in progress`;

// A compose model with the root project's services only, and a secret file each: `paperclip` mounts one whose content
// rotates, `board` mounts none. The real script reads this through `docker compose config --format json`.
function model(dir) {
  return {
    name: "aidenhq",
    secrets: { grafana_mcp_token: { name: "aidenhq_grafana_mcp_token", file: join(dir, "secrets/grafana_mcp_token") } },
    services: {
      board: {},
      paperclip: { secrets: [{ source: "grafana_mcp_token", target: "/run/secrets/grafana_mcp_token" }] },
    },
  };
}

const fake = `#!/usr/bin/env bash
set -uo pipefail
dir=__DIR__
printf 'docker %s\\n' "$*" >> "$dir/calls"
case "$1" in
  compose)
    case "$*" in
      *"config --services"*) cat "$dir/services" ;;
      *"config --images"*)
        s=$(printf '%s' "\${@: -1}"); cat "$dir/image-$s" 2>/dev/null ;;
      *"config --hash"*)
        s=$(printf '%s' "\${@: -1}")
        if [ "$s" = "*" ]; then cat "$dir/hashes" 2>/dev/null; else awk -v s="$s" '$1 == s {print}' "$dir/hashes" 2>/dev/null; fi ;;
      *"config --format json"*) cat "$dir/model.json" 2>/dev/null ;;
      *"compose ps -a -q"*)
        s=$(printf '%s' "\${@: -1}"); cat "$dir/psid-$s" 2>/dev/null ;;
      *"compose ps -a --format"*)
        s=$(printf '%s' "\${@: -1}"); cat "$dir/state-$s" 2>/dev/null ;;
      *"build"*) cat "$dir/build.out" 2>/dev/null; exit "$(cat "$dir/build.code" 2>/dev/null || echo 0)" ;;
      *"up -d"*)
        n=$(( $(cat "$dir/upcount" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$dir/upcount"
        code=$(cat "$dir/up-$n.code" 2>/dev/null || echo 0)
        # A real --force-recreate starts a new container with a new id, carrying the same image and config hash.
        # A failed up starts nothing, as compose's own race does, unless starts-<n> says it got that far.
        if [ "$code" = 0 ] || [ -f "$dir/starts-$n" ]; then
          for s in "\${@:2}"; do
            case "$s" in -*) continue ;; esac
            [ -f "$dir/recreate-$s" ] || continue
            old=$(cat "$dir/psid-$s"); g=$(( $(cat "$dir/recreated-$s" 2>/dev/null || echo 0) + 1 ))
            echo "$g" > "$dir/recreated-$s"; echo "\${s}recreated\${g}" > "$dir/psid-$s"
            cp "$dir/running-$old" "$dir/running-\${s}recreated\${g}"
            cp "$dir/imageof-$old" "$dir/imageof-\${s}recreated\${g}"
            cp "$dir/hashof-$old" "$dir/hashof-\${s}recreated\${g}"
          done
        fi
        cat "$dir/up-$n.out" 2>/dev/null
        exit "$code" ;;
    esac ;;
  ps) cat "$dir/ids" ;;
  inspect)
    id=$(printf '%s' "\${@: -1}")
    case "$*" in
      *'{{.Name}}'*) cat "$dir/name-$id" 2>/dev/null ;;
      *'{{.State.Running}}'*) cat "$dir/running-$id" 2>/dev/null ;;
      *'{{.Image}}'*) cat "$dir/imageof-$id" 2>/dev/null ;;
      *'config-hash'*) cat "$dir/hashof-$id" 2>/dev/null ;;
    esac ;;
  image) id=$(printf '%s' "\${@: -1}" | tr '/:' '__'); cat "$dir/imageid-$id" 2>/dev/null ;;
  rm)
    id=$(printf '%s' "\${@: -1}")
    if [ -f "$dir/rm-$id" ]; then cat "$dir/rm-$id"; exit 1; fi ;;
  run) cat "$dir/dump.out" 2>/dev/null; exit "$(cat "$dir/dump.code" 2>/dev/null || echo 0)" ;;
esac
exit 0
`;

/**
 * containers: id → { name, running, image, hash } (what `docker inspect` prints for each).
 * services: the services this config runs; hashes: service → its compose config hash.
 * up: what `docker compose up` does, in order: [output, exit code]. rmFails: id → the error `docker rm` gives.
 */
function fixture({ containers = {}, services, hashes = {}, up = [["", 0]], rmFails = {}, dump }) {
  const dir = mkdtempSync(join(tmpdir(), "compose-recreate-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(dir, "ids"), `${Object.keys(containers).join("\n")}\n`);
  writeFileSync(join(dir, "services"), `${services.join("\n")}\n`);
  writeFileSync(join(dir, "hashes"), Object.entries(hashes).map(([s, h]) => `${s} ${h}\n`).join(""));
  for (const [id, c] of Object.entries(containers)) {
    writeFileSync(join(dir, `name-${id}`), `${c.name}\n`);
    writeFileSync(join(dir, `running-${id}`), `${c.running}\n`);
    if (c.image) writeFileSync(join(dir, `imageof-${id}`), `${c.image}\n`);
    if (c.hash) writeFileSync(join(dir, `hashof-${id}`), `${c.hash}\n`);
  }
  for (const [id, err] of Object.entries(rmFails)) writeFileSync(join(dir, `rm-${id}`), `${err}\n`);
  up.forEach(([out, code], i) => {
    writeFileSync(join(dir, `up-${i + 1}.out`), `${out}\n`);
    writeFileSync(join(dir, `up-${i + 1}.code`), `${code}\n`);
  });
  if (dump) writeFileSync(join(dir, "dump.code"), `${dump}\n`);
  const file = join(bin, "docker");
  writeFileSync(file, fake.replace("__DIR__", JSON.stringify(dir)));
  chmodSync(file, 0o755);
  return { dir, bin, calls: () => readFileSync(join(dir, "calls"), "utf8") };
}

function apply(f, { env = {} } = {}) {
  writeFileSync(join(f.dir, "calls"), "");
  return new Promise((resolve) => {
    execFile("bash", [script], {
      cwd: f.dir,
      env: { ...process.env, PATH: `${f.bin}:/usr/bin:/bin`, COMPOSE_PROJECT_NAME: "aidenhq", AIDENHQ_DATA_DIR: join(f.dir, "data"), AIDENHQ_SECRETS_DIR: join(f.dir, "secrets"), ...env },
    }, (error, stdout, stderr) => {
      resolve({ status: error ? error.code : 0, out: `${stdout}${stderr}`, calls: f.calls() });
    });
  });
}

const calls = (r, prefix) => r.calls.split("\n").filter((l) => l.startsWith(prefix));
const removals = (r) => calls(r, "docker rm ");
const recreates = (r) => calls(r, "docker compose up");

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
  assert.match(r.out, /whisper-live-mcp leftover cleaned/);
});

test("a compose failure that is not a removal race still fails the apply, with no retry", async () => {
  // board's image moved, so this apply would recreate it; the daemon refuses for an unrelated reason.
  const f = fixture({ containers, services, hashes: { board: "old", paperclip: "same" }, up: [["Error response from daemon: pull access denied for aidenhq/board", 1]] });
  writeFileSync(join(f.dir, "psid-board"), "board1\n");
  writeFileSync(join(f.dir, "image-board"), "aidenhq/board:local\n");
  writeFileSync(join(f.dir, "imageid-aidenhq_board_local"), "sha256:new\n");
  writeFileSync(join(f.dir, "imageof-board1"), "sha256:new\n");
  writeFileSync(join(f.dir, "hashof-board1"), "old\n");
  const r = await apply(f);
  assert.equal(r.status, 1, r.out);
  assert.equal(recreates(r).length, 1, "compose ran once");
  assert.deepEqual(removals(r), [], "nothing was removed");
  assert.doesNotMatch(r.out, /retrying/, r.out);
  assert.match(r.out, /pull access denied/);
});

test("the retry is one: a second race still fails the apply", async () => {
  const r = await apply(fixture({ containers, services, up: [[raced, 1], [raced, 1]] }));
  assert.equal(r.status, 1, r.out);
  assert.equal(recreates(r).length, 2, "compose ran twice, never three times");
});

test("only the services whose image or config moved are recreated, and every service gets a line", async () => {
  const f = fixture({ containers, services, hashes: { board: "h-board", paperclip: "h-paperclip" } });
  // board: same image, same config hash → kept. paperclip: its config hash differs → recreated.
  writeFileSync(join(f.dir, "psid-board"), "board1\n");
  writeFileSync(join(f.dir, "image-board"), "aidenhq/board:local\n");
  writeFileSync(join(f.dir, "imageid-aidenhq_board_local"), "sha256:board\n");
  writeFileSync(join(f.dir, "imageof-board1"), "sha256:board\n");
  writeFileSync(join(f.dir, "hashof-board1"), "h-board\n");
  writeFileSync(join(f.dir, "psid-paperclip"), "pc1\n");
  writeFileSync(join(f.dir, "image-paperclip"), "ghcr.io/paperclipai/paperclip:2026.1106.0\n");
  writeFileSync(join(f.dir, "imageid-ghcr.io_paperclipai_paperclip_2026.1106.0"), "sha256:pc\n");
  writeFileSync(join(f.dir, "imageof-pc1"), "sha256:pc\n");
  writeFileSync(join(f.dir, "hashof-pc1"), "h-old\n");
  writeFileSync(join(f.dir, "state-board"), "running\n");
  writeFileSync(join(f.dir, "state-paperclip"), "running\n");
  const r = await apply(f);
  assert.equal(r.status, 0, r.out);
  const ups = recreates(r);
  assert.equal(ups.length, 1, r.calls);
  assert.match(ups[0], /--force-recreate paperclip$/, `only paperclip is recreated: ${ups[0]}`);
  assert.doesNotMatch(ups[0], /board/, `board is not recreated: ${ups[0]}`);
  assert.match(r.out, /compose: board kept/);
  assert.match(r.out, /compose: paperclip recreated/);
});

test("an empty service list builds, dumps and removes nothing", async () => {
  const f = fixture({ containers, services: [] });
  const r = await apply(f);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /lists no services/);
  assert.deepEqual(calls(r, "docker compose build"), [], "nothing is built");
  assert.deepEqual(removals(r), [], "nothing is removed");
  assert.deepEqual(calls(r, "docker run"), [], "nothing is dumped");
});

test("an unset warehouse password fails before any docker call", async () => {
  const f = fixture({ containers, services });
  // A warehouse deployment with no password in the vault: the dump can't be taken, so the apply stops before Docker.
  mkdirSync(join(f.dir, "secrets/apps/warehouse"), { recursive: true });
  const r = await apply(f);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /POSTGRES_PASSWORD/);
  assert.equal(r.calls.trim(), "", `docker was never called:\n${r.calls}`);
});

test("a dump is created exclusively, 0600 in a 0700 directory, and older dumps keep their bytes", async () => {
  const f = fixture({ containers, services });
  mkdirSync(join(f.dir, "secrets/apps/warehouse"), { recursive: true });
  writeFileSync(join(f.dir, "secrets/apps/warehouse/POSTGRES_PASSWORD"), "pw");
  // A running warehouse, so the dump path is taken; and a dump already at the base name, which must not be truncated.
  writeFileSync(join(f.dir, "running-app-warehouse-postgres-1"), "true\n");
  const dumps = join(f.dir, "data/dumps");
  mkdirSync(dumps, { recursive: true });
  writeFileSync(join(dumps, "warehouse.dump"), "older bytes");
  writeFileSync(join(dumps, "warehouse-1.dump"), "older bytes 1");
  // The fake docker writes a payload to stdout for `run`, which becomes the new dump's content.
  writeFileSync(join(f.dir, "dump.out"), "fresh dump");
  const r = await apply(f);
  assert.equal(r.status, 0, r.out);
  assert.equal(readFileSync(join(dumps, "warehouse.dump"), "utf8"), "older bytes", "the taken name is never truncated");
  assert.equal(readFileSync(join(dumps, "warehouse-1.dump"), "utf8"), "older bytes 1");
  const fresh = join(dumps, "warehouse-2.dump");
  assert.ok(existsSync(fresh), `a distinct new dump was made: ${readdirSync(dumps)}`);
  assert.equal(readFileSync(fresh, "utf8"), "fresh dump");
  assert.equal(statSync(fresh).mode & 0o777, 0o600, "the new dump is 0600");
  assert.equal(statSync(dumps).mode & 0o777, 0o700, "the dumps directory is 0700");
  for (const f2 of ["warehouse.dump", "warehouse-1.dump"]) assert.equal(statSync(join(dumps, f2)).mode & 0o777, 0o600, `${f2} is tightened to 0600`);
});

test("a service whose mounted secret content changed since it started is recreated", async () => {
  const f = fixture({ containers, services, hashes: { board: "h-board", paperclip: "h-paperclip" } });
  writeFileSync(join(f.dir, "model.json"), `${JSON.stringify(model(f.dir))}\n`);
  mkdirSync(join(f.dir, "secrets"), { recursive: true });
  writeFileSync(join(f.dir, "secrets/grafana_mcp_token"), "new-token\n");
  // A recreate is a new container: the fake up starts <service>recreated<n> for a service marked recreate-<service>.
  for (const [service, id, hash] of [["board", "board1", "h-board"], ["paperclip", "pc1", "h-paperclip"]]) {
    writeFileSync(join(f.dir, `psid-${service}`), `${id}\n`);
    writeFileSync(join(f.dir, `image-${service}`), `aidenhq/${service}:local\n`);
    writeFileSync(join(f.dir, `imageid-aidenhq_${service}_local`), `sha256:${service}\n`);
    writeFileSync(join(f.dir, `state-${service}`), "running\n");
    writeFileSync(join(f.dir, `recreate-${service}`), "1\n");
    writeFileSync(join(f.dir, `running-${id}`), "true\n");
    writeFileSync(join(f.dir, `imageof-${id}`), `sha256:${service}\n`);
    writeFileSync(join(f.dir, `hashof-${id}`), `${hash}\n`);
  }
  // No record yet: the start of the running container is unknown, so the mounting service is recreated once and recorded.
  const first = await apply(f);
  assert.equal(first.status, 0, first.out);
  assert.match(recreates(first).at(-1), /--force-recreate paperclip$/, `only the mounting service is recreated: ${first.calls}`);
  assert.doesNotMatch(recreates(first).at(-1), /board/, `a service with no secret is not recreated: ${first.calls}`);
  // The recreated container read what is on disk, so the next apply keeps it.
  const second = await apply(f);
  assert.equal(second.status, 0, second.out);
  assert.equal(recreates(second).length, 0, `unchanged content is kept: ${second.calls}`);
  assert.match(second.out, /compose: paperclip kept/);
  // A rotation changes the digest the running container was recorded with.
  writeFileSync(join(f.dir, "secrets/grafana_mcp_token"), "rotated-token\n");
  const third = await apply(f);
  assert.equal(third.status, 0, third.out);
  assert.match(recreates(third).at(-1), /--force-recreate paperclip$/, `the rotated secret recreates paperclip: ${third.calls}`);
  assert.doesNotMatch(recreates(third).at(-1), /board/, `a service with no secret is not recreated: ${third.calls}`);
  // The record follows the new container, so a second apply on the same content keeps it rather than restarting it again.
  const fourth = await apply(f);
  assert.equal(fourth.status, 0, fourth.out);
  assert.equal(recreates(fourth).length, 0, `the recreated container's record is written: ${fourth.calls}`);
});

test("a secret that rotated and then raced a removal is not restarted again by the retry", async () => {
  // The first pass starts the new container and then loses the daemon race on the way out: what it started already read
  // the rotated secret, so the retry must keep it rather than start a second one.
  const f = fixture({ containers, services: ["paperclip"], hashes: { paperclip: "h-paperclip" }, up: [[raced, 1], ["Container paperclip Started", 0]] });
  writeFileSync(join(f.dir, "starts-1"), "1\n");
  writeFileSync(join(f.dir, "model.json"), `${JSON.stringify(model(f.dir))}\n`);
  mkdirSync(join(f.dir, "secrets"), { recursive: true });
  writeFileSync(join(f.dir, "secrets/grafana_mcp_token"), "new-token\n");
  writeFileSync(join(f.dir, "psid-paperclip"), "pc1\n");
  writeFileSync(join(f.dir, "image-paperclip"), "aidenhq/paperclip:local\n");
  writeFileSync(join(f.dir, "imageid-aidenhq_paperclip_local"), "sha256:paperclip\n");
  writeFileSync(join(f.dir, "state-paperclip"), "running\n");
  writeFileSync(join(f.dir, "recreate-paperclip"), "1\n");
  writeFileSync(join(f.dir, "running-pc1"), "true\n");
  writeFileSync(join(f.dir, "imageof-pc1"), "sha256:paperclip\n");
  writeFileSync(join(f.dir, "hashof-pc1"), "h-paperclip\n");
  // First apply: no record, one recreate, the race, and the retry finds the container it started recorded.
  const first = await apply(f);
  assert.equal(first.status, 0, first.out);
  assert.match(first.out, /retrying once/);
  assert.equal(recreates(first).length, 1, `the retry keeps what the first pass started: ${first.calls}`);
  assert.match(recreates(first)[0], /--force-recreate paperclip$/, recreates(first)[0]);
  // The rotation is recorded against the container that read it.
  const second = await apply(f);
  assert.equal(second.status, 0, second.out);
  assert.equal(recreates(second).length, 0, `the retry's container is recorded: ${second.calls}`);
});

test("a secret that rotated and raced before anything started is recreated by the retry", async () => {
  // The other side of the same race: the first pass started nothing, so the retry is the one that has to recreate it.
  const f = fixture({ containers, services: ["paperclip"], hashes: { paperclip: "h-paperclip" }, up: [[raced, 1], ["Container paperclip Started", 0]] });
  writeFileSync(join(f.dir, "model.json"), `${JSON.stringify(model(f.dir))}\n`);
  mkdirSync(join(f.dir, "secrets"), { recursive: true });
  writeFileSync(join(f.dir, "secrets/grafana_mcp_token"), "rotated-token\n");
  writeFileSync(join(f.dir, "psid-paperclip"), "pc1\n");
  writeFileSync(join(f.dir, "image-paperclip"), "aidenhq/paperclip:local\n");
  writeFileSync(join(f.dir, "imageid-aidenhq_paperclip_local"), "sha256:paperclip\n");
  writeFileSync(join(f.dir, "state-paperclip"), "running\n");
  writeFileSync(join(f.dir, "recreate-paperclip"), "1\n");
  writeFileSync(join(f.dir, "running-pc1"), "true\n");
  writeFileSync(join(f.dir, "imageof-pc1"), "sha256:paperclip\n");
  writeFileSync(join(f.dir, "hashof-pc1"), "h-paperclip\n");
  const r = await apply(f);
  assert.equal(r.status, 0, r.out);
  assert.equal(recreates(r).length, 2, `the retry recreates what the first pass never started: ${r.calls}`);
  assert.match(r.out, /compose: paperclip recreated/);
});
