// The host's disk reclaim (ops/units/prune-docker.*, ops/prune-docker-containers.sh, ops/prune-docker-verify.sh,
// ops/apply-config-work.sh) and the Docker disk
// gauge it reports (ops/host-metrics.sh): the timer must prune often enough that the peak between prunes stays under the
// alert line, every prune must happen whatever the ones before it did, the run must still fail when a prune did not do its
// work, only disposable containers that have been STOPPED long enough may go, and the size gauges must come from
// `docker system df` without serving stale numbers (or failing the metrics timer) when Docker cannot answer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "../..");
const timer = readFileSync(join(repo, "ops/units/prune-docker.timer"), "utf8");
const service = readFileSync(join(repo, "ops/units/prune-docker.service"), "utf8");
const script = readFileSync(join(repo, "ops/prune-docker-containers.sh"), "utf8");
const verify = readFileSync(join(repo, "ops/prune-docker-verify.sh"), "utf8");
const apply = readFileSync(join(repo, "ops/apply-config-work.sh"), "utf8");
// The verify's build-cache ceiling, read from the script so the boundary cases below are the ones it actually enforces.
const ceilingGb = Number(/^CACHE_CEILING_GB=(\d+)/m.exec(verify)?.[1] ?? "0");
// A script's commands, without the comment lines that talk about them.
const commands = (text) => text.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");

test("prune-docker.timer prunes every four hours, not once a night", () => {
  const calendar = /^OnCalendar=(.*)$/m.exec(timer)?.[1] ?? "";
  assert.equal(calendar, "*-*-* 00,04,08,12,16,20:30");
  const hours = /(\d{1,2})(?:,\d{1,2})*:/.exec(calendar)?.[0].slice(0, -1).split(",").map(Number) ?? [];
  assert.ok(hours.length >= 4, `at least four runs a day, got ${hours.length}: ${calendar}`);
  // Every hour gap must be the same, so no part of the day waits longer between prunes than any other.
  const gaps = hours.map((h, i) => (hours[(i + 1) % hours.length] - h + 24) % 24);
  assert.deepEqual(new Set(gaps), new Set([4]), `even 4-hour gaps, got ${gaps}`);
  assert.match(timer, /^Persistent=true$/m, "a missed run still happens after boot");
  assert.match(timer, /^Description=.*peak/m, "the description says why: the peak, not one nightly sweep");
});

test("every prune ExecStart is `-`-prefixed, and the last step reports whether they did their work", () => {
  const execs = service.split("\n").filter((l) => l.startsWith("ExecStart="))
    .map((l) => l.slice("ExecStart=".length).trim());
  assert.ok(execs.length >= 4, `the prunes: ${execs.join(" | ")}`);
  // The delegating agent's amend: every prune step independent (`-`), so a failing builder prune never skips the image or
  // container prune; the last step is deliberately unprefixed, so a prune that did nothing at all still fails the unit.
  for (const e of execs.slice(0, -1)) assert.ok(e.startsWith("-"), `not independent, a failing one skips the rest: ${e}`);
  assert.equal(execs.at(-1), "/usr/bin/env bash ${AIDENHQ_DIR}/ops/prune-docker-verify.sh");
  assert.ok(!execs.at(-1).startsWith("-"), "the verification's exit code must reach systemd");
  // A pruning command that hangs must not hold the oneshot until TimeoutStartSec and take the later steps with it: each
  // one has a timeout well under the service's ceiling.
  for (const e of execs.slice(0, -1)) assert.match(e, /^-(\/usr\/bin\/timeout \d+m|\/usr\/bin\/env bash .*\/usr\/bin\/timeout \d+m|\/usr\/bin\/env bash .*\/usr\/bin\/timeout \d+ )/, `no per-command timeout: ${e}`);
  const ceiling = Number(/^TimeoutStartSec=(\d+)min$/m.exec(service)?.[1]);
  const sum = execs.slice(0, -1).map((e) => Number(/(\d+)m\b/.exec(e)?.[1] ?? 0)).reduce((a, b) => a + b, 0);
  assert.ok(ceiling > sum, `TimeoutStartSec ${ceiling}min must exceed the per-command timeouts (${sum}min)`);
  // The cache cap in both flag forms: buildx knows --max-used-space, the classic fallback only --keep-storage (a CLI
  // without the buildx plugin fails the first with "unknown flag"), and each is a no-op where the other works. Each goes
  // through the step wrapper so its status is recorded: one failing is expected, both failing is a prune that ran nothing,
  // and the verification has to see that even when the cache under its ceiling would read clean.
  assert.ok(execs.some((e) => e === "-/usr/bin/env bash ${AIDENHQ_DIR}/ops/prune-docker-step.sh builder-buildx /usr/bin/timeout 15m /usr/bin/docker builder prune -af --max-used-space 20GB"), `buildx cache cap: ${execs.join(" | ")}`);
  assert.ok(execs.some((e) => e === "-/usr/bin/env bash ${AIDENHQ_DIR}/ops/prune-docker-step.sh builder-classic /usr/bin/timeout 15m /usr/bin/docker builder prune -af --keep-storage 20GB"), `classic-builder cache cap: ${execs.join(" | ")}`);
  // The image and container prunes go through the step wrapper, which records their status for the verification: the `-`
  // keeps a failure from skipping the next step, and the record is how it still fails the unit.
  assert.ok(execs.some((e) => e === "-/usr/bin/env bash ${AIDENHQ_DIR}/ops/prune-docker-step.sh images /usr/bin/timeout 10m /usr/bin/docker image prune -af --filter until=48h --filter label!=aidenhq.keep=true"), `48h image retention kept: ${execs.join(" | ")}`);
  // The container step records its own status: a listing that failed while the daemon was unreachable can recover before
  // the verification's re-listing, and its fresh listing would then read as a clean scan, so its status has to be kept.
  assert.ok(execs.some((e) => e === "-/usr/bin/timeout 5m /usr/bin/env bash ${AIDENHQ_DIR}/ops/prune-docker-containers.sh"), `one-off reclaim: ${execs.join(" | ")}`);
  assert.match(commands(script), /\$state\/containers|"\$state\/containers"/, "the container step records its status for the verification");
  // The cache is snapshotted by its own prefixed step, immediately after the two builder prunes and before the image and
  // container prunes (which take minutes on a large host): a build adding cache while those run does not get into the
  // snapshot.
  assert.ok(execs.slice(0, -1).some((e) => e === "-/usr/bin/env bash ${AIDENHQ_DIR}/ops/prune-docker-step.sh build-cache /usr/bin/timeout 30 /usr/bin/docker system df --format '{{json .}}'"), `cache snapshot: ${execs.join(" | ")}`);
  const cacheAt = execs.findIndex((e) => /prune-docker-step\.sh build-cache/.test(e));
  const lastBuilder = execs.map((e) => /docker builder prune/.test(e)).lastIndexOf(true);
  const firstLater = execs.findIndex((e) => /docker image prune|prune-docker-containers\.sh/.test(e));
  assert.ok(cacheAt === lastBuilder + 1, `the snapshot must directly follow the builder prunes: ${execs.join(" | ")}`);
  assert.ok(cacheAt < firstLater, `the snapshot must precede the image and container prunes: ${execs.join(" | ")}`);
  assert.match(service, /^Environment=AIDENHQ_DIR=/m);
  assert.match(service, /^EnvironmentFile=-%h\/\.config\/aidenhq-prune-docker\.env$/m, "the applied checkout wins over the one setup recorded");
  // Enabling is not starting: on a fresh host a prune run can fail (a cold `docker system df` past its cap) and must not
  // make the install fail, so setup enables the timer (and the service, for boot) without `--now` on the service.
  const setup = readFileSync(join(repo, "ops/setup.sh"), "utf8");
  const now = /systemctl --user enable --now ([^\n]*)/.exec(setup)?.[1] ?? "";
  assert.ok(!/prune-docker\.service/.test(now), `setup starts prune-docker.service synchronously: ${now}`);
  assert.match(setup, /systemctl --user enable --now [^\n]*prune-docker\.timer/);
  assert.match(setup, /systemctl --user enable prune-docker\.service$/m);
  // No volume or data deletion: the unit never takes --volumes or prunes volumes.
  assert.doesNotMatch(service, /system prune|--volumes|volume prune/);
});

test("applying a product without the Docker disk collector removes the stale docker.prom", () => {
  // A rollback to a product version from before docker.prom would otherwise leave the last file the newer collector wrote
  // in node-exporter's textfile directory: it would serve those bytes and collect_ok 1 as current, and HostMetricsStale
  // would page on a mtime no running collector can refresh. The apply removes the file and its read cache when the product
  // it applies has no writer for it.
  assert.match(commands(apply), /! grep -q 'write docker\.prom' ops\/host-metrics\.sh/);
  assert.match(commands(apply), /rm -f "\$textfile_dir\/docker\.prom" "\$monitoring_dir\/docker-df\.json"/);
  // And nothing legitimate: while the applied product does write it, the apply leaves both alone.
  assert.match(readFileSync(join(repo, "ops/host-metrics.sh"), "utf8"), /} \| write docker\.prom/);
});

test("applying a product without the prune step collector removes the stale prune-docker.prom", () => {
  // The same rollback path as docker.prom: a product from before this collector would leave the last step records on the
  // scrape, and a failed unit's stale step would read as current. The apply removes the file when the applied version has
  // no writer for it; a version that writes it leaves it alone (its first run rewrites it).
  assert.match(commands(apply), /! grep -q 'write prune-docker\.prom' ops\/host-metrics\.sh/);
  assert.match(commands(apply), /rm -f "\$textfile_dir\/prune-docker\.prom"/);
  assert.match(readFileSync(join(repo, "ops/host-metrics.sh"), "utf8"), /} \| write prune-docker\.prom/);
});

test("the container step removes only one-offs stopped over a day, and the verification is what fails the unit", () => {
  assert.ok(existsSync(join(repo, "ops/prune-docker-containers.sh")));
  assert.ok(statSync(join(repo, "ops/prune-docker-containers.sh")).mode & 0o100, "executable");
  assert.ok(statSync(join(repo, "ops/prune-docker-verify.sh")).mode & 0o100, "executable");
  // Stopped time, not created time: `container prune --filter until=` filters on creation (moby daemon/prune.go) and would
  // delete a compose service an apply's generation snapshot had just stopped.
  assert.match(script, /ps -aq\b/);
  assert.match(script, /State\.FinishedAt/, "stopped time, not created time");
  assert.match(script, /com\.docker\.compose\.service/, "a compose service an apply stopped is never a candidate");
  assert.match(script, /aidenhq\.computer/, "nor a computer box");
  assert.match(script, /86400/);
  assert.doesNotMatch(commands(script), /container prune|--filter until=24h/, "container prune filters on created time, which can delete a stopped service");
  // No volume or data deletion: no -v, no volume prune, no system prune, and app-warehouse_pgdata is never named. The
  // comments say so in words, so the commands are what this reads.
  assert.doesNotMatch(commands(script), /rm -[a-z]*v|--volumes|volume prune|system prune|app-warehouse_pgdata/);
  // The verification checks the three ways the reclaim can silently not happen: the daemon, the build-cache ceiling, and
  // a one-off stopped over a day that is still there.
  assert.match(verify, /docker|"\$DOCKER" info/, "the daemon must answer");
  assert.match(verify, /Build Cache/);
  // The ceiling is a backstop for a prune that did nothing, not the 20 GB the builder prune aims at: the fleet's normal
  // reclaimable cache sits on the 20 GB line and peaked at 29.9 GB, so judging it at 20 GB failed every ordinary run.
  assert.ok(ceilingGb >= 30, `the build-cache ceiling must clear the measured 29.9 GB peak, got ${ceilingGb}`);
  assert.match(verify, /State\.FinishedAt/);
  // The image prune runs once, in its `-`-prefixed step, and the verification reads the status the step wrapper recorded:
  // running the same 48 h prune a second time doubles the work on a large host.
  assert.doesNotMatch(commands(verify), /"\$DOCKER" image prune|docker image prune/, "verify must not run a second image prune");
  assert.match(verify, /prune-docker-step|step_status/);
  assert.match(verify, /exit 1/);
  assert.doesNotMatch(commands(verify), /rm -[a-z]*v|--volumes|volume prune|system prune|app-warehouse_pgdata/);
});

test("the apply-time prunes are independent too, and keep the same retention", () => {
  const lines = apply.split("\n").filter((l) => /^\s*(timeout (-k \S+ )?\d+m )?(docker (builder|image|container) prune|bash ops\/prune-docker-containers\.sh)/.test(l));
  assert.ok(lines.length >= 4, lines.join("\n"));
  for (const l of lines) assert.match(l, /\|\| true$/, `a failing one must not skip the rest: ${l}`);
  // `|| true` only helps when the command exits: bound each one so a daemon that stops answering cannot hold the apply,
  // after services restarted and before the new product is recorded.
  for (const l of lines) assert.match(l, /^\s*timeout (-k \S+ )?\d+m /, `unbounded apply-time prune: ${l}`);
  // timeout's SIGTERM can be ignored by a stuck buildx child: `-k` is the hard deadline that guarantees the step ends and
  // the steps after it (and the applied marker) are still reached.
  for (const l of lines) assert.match(l, /^\s*timeout -k \S+ \d+m /, `soft-only deadline on apply-time prune: ${l}`);
  assert.ok(lines.some((l) => /docker builder prune -f --max-used-space 20GB\b/.test(l)), lines.join("\n"));
  assert.ok(lines.some((l) => /docker builder prune -f --keep-storage 20GB\b/.test(l)), lines.join("\n"));
  assert.ok(lines.some((l) => /docker image prune -af --filter until=48h --filter label!=aidenhq\.keep=true\b/.test(l)), lines.join("\n"));
  assert.ok(lines.some((l) => /bash ops\/prune-docker-containers\.sh\b/.test(l)), lines.join("\n"));
  assert.doesNotMatch(apply, /^\s*docker (system|volume) prune.*--volumes/m);
});

// ops/prune-docker-containers.sh and ops/prune-docker-verify.sh against a fake docker: what the container step does, and
// what the verification makes of the host afterwards.
function fakeDocker({
  containers = [], cache = "10.52GB", daemonUp = true, cacheRow = true, imagePruneFails = false,
  uninspectable = [], vanishOnRm = [], vanishOnInspect = [], relistFails = false, systemDfFails = false,
  restartedBeforeRm = [], reclaimable = "", sizeMissing = false, labelListFails = false,
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), "prune-docker-"));
  const bin = join(dir, "bin");
  const calls = join(dir, "calls");
  mkdirSync(bin);
  writeFileSync(calls, "");
  // One row per container: id|running|hours-stopped (`never` for the zero time a container created and never started has)
  // |compose service|computer label|`labelled` when it carries the opt-in aidenhq.oneoff=1. `ps -aq --filter label=` lists
  // only the labelled ones.
  const rows = containers.map((c) => `${c.id}|${c.running}|${c.finished}|${c.service ?? ""}|${c.computer ?? ""}|${c.oneoff ? "labelled" : ""}`).join("\n");
  const rowsFile = join(dir, "rows");
  writeFileSync(rowsFile, rows + "\n");
  const seenFile = join(dir, "seen");
  writeFileSync(seenFile, "");
  writeFileSync(join(bin, "docker"), `#!/usr/bin/env bash
rows_file="${rowsFile}"
seen_file="${seenFile}"
printf '%s\\n' "$*" >> "${calls}"
case "$1 $2" in
  # \`docker info\` has no positional operand: match it on its whole line, before "$1 $2" ("info ").
  "info ") exit ${daemonUp ? 0 : 1} ;;
  "info") exit ${daemonUp ? 0 : 1} ;;
  "ps -aq")
    case "$*" in
      *"label="*)
        ${labelListFails ? `[ "\${PRUNE_LABEL_FAIL:-0}" = 1 ] && { echo "Cannot connect to the Docker daemon" >&2; exit 1; }` : ""}
        grep 'labelled$' "\${rows_file}" | cut -d'|' -f1 ;;
      ${relistFails ? `*) [ "\${PRUNE_RELIST_FAIL:-0}" = 1 ] || exit 0; echo "Cannot connect to the Docker daemon" >&2; exit 1 ;;` : ""}
      *) cut -d'|' -f1 "\${rows_file}" ;;
    esac
    exit 0 ;;
  "inspect -f")
    id="\${@: -1}"
    case " ${vanishOnInspect.join(" ")} " in
      *" $id "*)
        # Gone between the listing and its inspect (its own --rm): there is nothing left to check or reclaim.
        grep -v "^$id|" "\${rows_file}" > "\${rows_file}.tmp"; mv "\${rows_file}.tmp" "\${rows_file}"
        echo "Error: No such container: $id" >&2; exit 1 ;;
    esac
    case " ${uninspectable.join(" ")} " in
      *" $id "*) echo "Error response from daemon: container $id is not running" >&2; exit 1 ;;
    esac
    # The second read of a container that was restarted mid-run: it is running again, exactly the race the step must not
    # delete through.
    case " ${restartedBeforeRm.join(" ")} " in
      *" $id "*)
        if grep -qx "$id" "\${seen_file}"; then printf 'true|0001-01-01T00:00:00Z||\n'; exit 0; fi
        printf '%s\\n' "$id" >> "\${seen_file}" ;;
    esac
    while IFS='|' read -r cid running hours service computer oneoff; do
      [ "$cid" = "$id" ] || continue
      case "$hours" in
        never) finished=0001-01-01T00:00:00Z ;;
        *) finished="$(date -u -d "-$hours hours" +%Y-%m-%dT%H:%M:%S.%NZ)" ;;
      esac
      printf '%s|%s|%s|%s\\n' "$running" "$finished" "$service" "$computer"
      exit 0
    done < "\${rows_file}"
    exit 1 ;;
  "rm "*|"rm")
    id="\${@: -1}"
    case " ${vanishOnRm.join(" ")} " in
      *" $id "*)
        # It went between the listing and the removal (its own --rm): the daemon's rm then fails, nothing is left.
        grep -v "^$id|" "\${rows_file}" > "\${rows_file}.tmp"; mv "\${rows_file}.tmp" "\${rows_file}"
        echo "Error: No such container: $id" >&2; exit 1 ;;
    esac
    exit 0 ;;
  "system df")
    ${systemDfFails ? `echo "Cannot connect to the Docker daemon" >&2; exit 1 ;;` : ""}
    ${cacheRow
      ? `printf '{"Size":"%s","Reclaimable":"%s","Type":"Build Cache"}\\n' "${sizeMissing ? "" : cache}" "${reclaimable}"`
      : `printf '{"Size":"25.15GB","Type":"Images"}\\n'`}
    exit 0 ;;
  "image prune") exit ${imagePruneFails ? 1 : 0} ;;
esac
exit 0
`);
  chmodSync(join(bin, "docker"), 0o755);
  return {
    bin,
    calls: () => readFileSync(calls, "utf8"),
    run: (script, extraEnv = {}) => {
      const r = spawnSync("bash", [join(repo, script)], { env: { PATH: "/usr/bin:/bin", DOCKER: join(bin, "docker"), ...extraEnv }, encoding: "utf8" });
      return { status: r.status, out: `${r.stdout}${r.stderr}`, calls: readFileSync(calls, "utf8") };
    },
  };
}

test("only one-offs stopped over a day are removed, and never with their volumes", () => {
  const d = fakeDocker({
    containers: [
      { id: "running", running: "true", finished: "30", oneoff: true },
      { id: "young", running: "false", finished: "2", oneoff: true },
      { id: "old", running: "false", finished: "30", oneoff: true },
      { id: "service", running: "false", finished: "30", service: "warehouse", oneoff: true },
      { id: "box", running: "false", finished: "30", computer: "1", oneoff: true },
      { id: "never", running: "false", finished: "never", oneoff: true },
      // Not labelled aidenhq.oneoff: somebody's hand-started container. The cleanup does not reach it however old it is.
      { id: "handmade", running: "false", finished: "30" },
    ],
  });
  const r = d.run("ops/prune-docker-containers.sh");
  assert.match(r.calls, /^rm old$/m, r.calls);
  // A composposed service may be one an apply's generation snapshot stopped a moment ago, and a computer box has its own
  // lifecycle: neither is a one-off. A container created and never started has no stopped time to measure the day
  // against, so the retention rule gives no reason to remove it.
  assert.doesNotMatch(r.calls, /^rm (running|young|service|box|never)$/m, r.calls);
  // Removal needs the container to say it is disposable: a hand-started one is never a candidate, however long it has been
  // there. The listing asks the daemon for the label, so it does not even read them.
  assert.doesNotMatch(r.calls, /^rm handmade$/m, r.calls);
  assert.match(r.calls, /^ps -aq --filter label=aidenhq\.oneoff=1/m, r.calls);
  assert.match(r.out, /never: never started, kept/, r.out);
  assert.doesNotMatch(r.calls, /rm -[a-z]*v/, "docker rm takes no -v: volumes stay");
  assert.equal(r.status, 0, r.out);
});

test("a container listing that failed while the daemon was down still fails the run once Docker answers again", () => {
  // The step is `-`-prefixed, so its exit status never reaches systemd. With only the verification's own re-listing, a
  // listing that failed while the daemon was unreachable and recovered would read as a clean scan with nothing to remove.
  assert.match(script, /containers/);
  const state = mkdtempSync(join(tmpdir(), "prune-containers-status-"));
  mkdirSync(join(state, "prune-docker"));
  writeFileSync(join(state, "prune-docker/images"), "inv-l 0\n");
  writeFileSync(join(state, "prune-docker/build-cache"), 'inv-l 0\n{"Type":"Build Cache","Size":"1GB","Reclaimable":"0B"}\n');
  writeFileSync(join(state, "prune-docker/builder-buildx"), "inv-l 0\n");
  writeFileSync(join(state, "prune-docker/builder-classic"), "inv-l 0\n");
  const down = fakeDocker({ labelListFails: true });
  let r = down.run("ops/prune-docker-containers.sh", { AIDENHQ_STATE_DIR: state, INVOCATION_ID: "inv-l", PRUNE_LABEL_FAIL: "1" });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /could not list the containers/);
  assert.equal(readFileSync(join(state, "prune-docker/containers"), "utf8").trim(), "inv-l 1", "the step records its own failure");
  // Docker answers again by the time the verification re-lists, and nothing is eligible: the recorded status is what
  // still fails the unit.
  const up = fakeDocker({});
  r = up.run("ops/prune-docker-verify.sh", { AIDENHQ_STATE_DIR: state, INVOCATION_ID: "inv-l", DOCKER: join(up.bin, "docker") });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /containers prune step exited 1/);
  // A run whose listing did complete is clean.
  writeFileSync(join(state, "prune-docker/containers"), "inv-l 0\n");
  r = up.run("ops/prune-docker-verify.sh", { AIDENHQ_STATE_DIR: state, INVOCATION_ID: "inv-l", DOCKER: join(up.bin, "docker") });
  assert.equal(r.status, 0, r.out);
});

test("a one-off that is restarted between the check and the removal is kept", () => {
  // The first inspect says it has been stopped for 30 h, so it is eligible; the re-check immediately before `docker rm`
  // sees it running again (another process restarted it). Removing it then would delete a live container's layer.
  const d = fakeDocker({
    containers: [{ id: "racy", running: "false", finished: "30", oneoff: true }],
    restartedBeforeRm: ["racy"],
  });
  const r = d.run("ops/prune-docker-containers.sh");
  assert.equal(r.status, 0, r.out);
  assert.doesNotMatch(r.calls, /^rm racy$/m, r.calls);
  assert.match(r.out, /racy: changed state since it was inspected/);
});

test("the apply-time container step and the unit's are the same script, so the retention has one home", () => {
  assert.match(apply, /^\s*timeout -k \S+ 5m bash ops\/prune-docker-containers\.sh \|\| true$/m);
  assert.doesNotMatch(apply, /docker container prune/);
});

test("the verification fails the unit when the daemon is down, the cache is over the ceiling, or a one-off was left", () => {
  // Clean: the unit reads success.
  let d = fakeDocker({ cache: "10.52GB" });
  let r = d.run("ops/prune-docker-verify.sh");
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /verified/);
  // The daemon does not answer: every prune above was a no-op, and the unit must not read clean.
  d = fakeDocker({ daemonUp: false });
  r = d.run("ops/prune-docker-verify.sh");
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /daemon does not answer/);
  // Neither builder flag form capped the cache and there is still reclaimable data: the ceiling is the backstop for a
  // prune that did nothing at all.
  d = fakeDocker({ cache: "104.2GB", reclaimable: "90GB" });
  r = d.run("ops/prune-docker-verify.sh");
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /still reclaimable after the prune/);
  // Over the ceiling with nothing reclaimable: a concurrent build holds that cache in use, the prune did all it could,
  // and the unit must not read as a failed prune.
  d = fakeDocker({ cache: "104.2GB", reclaimable: "0B" });
  r = d.run("ops/prune-docker-verify.sh");
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /nothing is reclaimable/);
  // Over the ceiling with a little reclaimable cache left: that is cache a prune could have freed, not cache in use, so
  // it fails. Only an exact zero is the in-use exception; a silent tolerance would hide a partly failed prune.
  d = fakeDocker({ cache: `${ceilingGb + 2}GB`, reclaimable: "800MB" });
  r = d.run("ops/prune-docker-verify.sh");
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /still reclaimable after the prune/);
  // A Build Cache row with no size is not an absent row: Docker says something is cached and how big it is cannot be
  // read, so the ceiling cannot be confirmed and the unit fails.
  d = fakeDocker({ sizeMissing: true });
  r = d.run("ops/prune-docker-verify.sh");
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /Build Cache row with no readable size/);
  // The tolerance on the ceiling is the precision Docker printed the size with, not a fixed gigabyte: exactly the ceiling
  // (one decimal) can be half a display step over it, so it passes; one tenth over cannot be at or under it however it
  // was rounded, so it fails.
  d = fakeDocker({ cache: `${ceilingGb}.0GB`, reclaimable: "0B" });
  r = d.run("ops/prune-docker-verify.sh");
  assert.equal(r.status, 0, r.out);
  d = fakeDocker({ cache: `${ceilingGb}.1GB`, reclaimable: "2GB" });
  r = d.run("ops/prune-docker-verify.sh");
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /still reclaimable after the prune/);
  d = fakeDocker({ cache: `${ceilingGb}.01GB`, reclaimable: "1GB" });
  r = d.run("ops/prune-docker-verify.sh");
  assert.equal(r.status, 1, r.out);
  // A whole-unit size has a wider display step, and it is still only half of that unit: the ceiling in whole GB is
  // within it, one GB over is not.
  d = fakeDocker({ cache: `${ceilingGb}GB`, reclaimable: "0B" });
  r = d.run("ops/prune-docker-verify.sh");
  assert.equal(r.status, 0, r.out);
  d = fakeDocker({ cache: `${ceilingGb + 1}GB`, reclaimable: "1GB" });
  r = d.run("ops/prune-docker-verify.sh");
  assert.equal(r.status, 1, r.out);
  // Over the ceiling with an unreadable reclaimable size: the ceiling cannot be confirmed either way.
  d = fakeDocker({ cache: "104.2GB", reclaimable: "" });
  r = d.run("ops/prune-docker-verify.sh");
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /reclaimable size .* is unreadable/);
  // A one-off stopped over a day ago is still there: the container step did not do its work.
  d = fakeDocker({ containers: [{ id: "left", running: "false", finished: "30", oneoff: true }] });
  r = d.run("ops/prune-docker-verify.sh");
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /container left is a one-off stopped over a day ago and still there/);
});

test("both builder prunes failing fails the unit even when the cache is under the ceiling", () => {
  // The unit runs the cap in both flag forms; one failing is the expected `unknown flag` on a CLI that lacks that form.
  // Both failing is no cap at all. Before the ceiling was raised the size check caught that on its own at 20 GB; at 40 GB
  // a run whose builder prunes both failed would read clean at the fleet's normal ~21 GB, so the pair's status has to be
  // read.
  const run = (buildx, classic, cache = "21GB", extra = {}) => {
    const state = mkdtempSync(join(tmpdir(), "prune-builders-"));
    mkdirSync(join(state, "prune-docker"));
    writeFileSync(join(state, "prune-docker/images"), "inv-b 0\n");
    writeFileSync(join(state, "prune-docker/containers"), "inv-b 0\n");
    writeFileSync(join(state, "prune-docker/builder-buildx"), `inv-b ${buildx}\n`);
    writeFileSync(join(state, "prune-docker/builder-classic"), `inv-b ${classic}\n`);
    writeFileSync(join(state, "prune-docker/build-cache"), `inv-b 0\n{"Type":"Build Cache","Size":"${cache}","Reclaimable":"0B"}\n`);
    return fakeDocker({ cache, ...extra }).run("ops/prune-docker-verify.sh", { AIDENHQ_STATE_DIR: state, INVOCATION_ID: "inv-b" });
  };
  // Both failed: with nothing reclaimable and a size well under the ceiling, only the status can see this.
  let r = run(1, 1);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /neither builder prune ran/);
  // One failing is expected (`unknown flag`), in either order: the other form capped the cache.
  r = run(1, 0);
  assert.equal(r.status, 0, r.out);
  r = run(0, 1);
  assert.equal(r.status, 0, r.out);
  // Both succeeded: clean.
  r = run(0, 0);
  assert.equal(r.status, 0, r.out);
});

test("the build-cache ceiling clears the fleet's normal level and still fails a prune that did nothing", () => {
  // The unit failed continuously after 2026-11-22T09:15Z with the cache at 20.8-21.5 GB (29.9 GB five-hour peak): the
  // fleet's ordinary reclaimable cache sits on the builder prune's 20 GB target, so a 20 GB verification ceiling read a
  // working prune as broken. At the normal level the unit must now read clean, whether or not a little is reclaimable.
  for (const cache of ["20.82GB", "21GB", "21.4GB", "29.9GB", "30GB"]) {
    const d = fakeDocker({ cache, reclaimable: "15GB" });
    const r = d.run("ops/prune-docker-verify.sh");
    assert.equal(r.status, 0, `${cache} is the fleet's normal level, not a failed prune: ${r.out}`);
  }
  // Just under the ceiling with reclaimable cache left still passes: the boundary is the ceiling, not "any reclaimable
  // cache at all". Only a size over it plus reclaimable bytes means the prune capped nothing.
  let d = fakeDocker({ cache: `${(ceilingGb - 0.1).toFixed(1)}GB`, reclaimable: "30GB" });
  let r = d.run("ops/prune-docker-verify.sh");
  assert.equal(r.status, 0, r.out);
  // Just over the ceiling is a prune that did nothing, and still fails.
  d = fakeDocker({ cache: `${(ceilingGb + 0.1).toFixed(1)}GB`, reclaimable: "30GB" });
  r = d.run("ops/prune-docker-verify.sh");
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /still reclaimable after the prune/);
  // The ceiling clears the measured peak by a real margin, so ordinary growth between builds does not re-fail the unit.
  assert.ok(ceilingGb >= 30, `ceiling must be above the 29.9 GB peak, got ${ceilingGb}`);
});

test("the verification reads an absent Build Cache row and a failed image prune as failures, not as clean", () => {
  // Own-store `docker system df` without a Build Cache row: the ceiling cannot be confirmed, so the unit must not read clean.
  let d = fakeDocker({ cacheRow: false });
  let r = d.run("ops/prune-docker-verify.sh");
  // A store with no build cache at all may leave the row out; nothing cached means the ceiling holds, so this passes.
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /no Build Cache row/);
  // A read that FAILED is not "no row": the ceiling cannot be confirmed and the unit fails.
  d = fakeDocker({ cacheRow: false, systemDfFails: true });
  r = d.run("ops/prune-docker-verify.sh");
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /docker system df failed/);
  // Every step is `-`-prefixed, so a failing `docker image prune` never reaches systemd by itself. The step wrapper records
  // its status for the verification, which reads it — and does NOT run the 48 h prune again.
  const state = mkdtempSync(join(tmpdir(), "prune-state-"));
  mkdirSync(join(state, "prune-docker"));
  writeFileSync(join(state, "prune-docker/images"), "inv-1 1\n");
  writeFileSync(join(state, "prune-docker/containers"), "inv-1 0\n");
  writeFileSync(join(state, "prune-docker/builder-buildx"), "inv-1 0\n");
  writeFileSync(join(state, "prune-docker/builder-classic"), "inv-1 0\n");
  d = fakeDocker({ imagePruneFails: true });
  r = d.run("ops/prune-docker-verify.sh", { AIDENHQ_STATE_DIR: state, INVOCATION_ID: "inv-1" });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /images prune step exited 1/);
  assert.doesNotMatch(r.calls, /^image prune /m, `verify must not run a second image prune: ${r.calls}`);
  // A missing status under systemd is unknown, not a pass; outside systemd (no INVOCATION_ID) it is not held against the run.
  r = fakeDocker({}).run("ops/prune-docker-verify.sh", { AIDENHQ_STATE_DIR: state, INVOCATION_ID: "inv-2" });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /left no status/);
  // Outside systemd no step ran, so no record is expected at all.
  r = fakeDocker({}).run("ops/prune-docker-verify.sh", { AIDENHQ_STATE_DIR: state });
  assert.equal(r.status, 0, r.out);
  // The container step's own failure is read the same way: a listing that failed while the daemon was down can recover
  // before this re-listing, and a fresh listing with nothing eligible would otherwise read as a clean scan.
  const cstate = mkdtempSync(join(tmpdir(), "prune-state-c-"));
  mkdirSync(join(cstate, "prune-docker"));
  writeFileSync(join(cstate, "prune-docker/images"), "inv-c 0\n");
  writeFileSync(join(cstate, "prune-docker/build-cache"), 'inv-c 0\n{"Type":"Build Cache","Size":"1GB","Reclaimable":"0B"}\n');
  writeFileSync(join(cstate, "prune-docker/builder-buildx"), "inv-c 0\n");
  writeFileSync(join(cstate, "prune-docker/builder-classic"), "inv-c 0\n");
  writeFileSync(join(cstate, "prune-docker/containers"), "inv-c 1\n");
  r = fakeDocker({}).run("ops/prune-docker-verify.sh", { AIDENHQ_STATE_DIR: cstate, INVOCATION_ID: "inv-c" });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /containers prune step exited 1/);
  writeFileSync(join(cstate, "prune-docker/containers"), "inv-c 0\n");
  r = fakeDocker({}).run("ops/prune-docker-verify.sh", { AIDENHQ_STATE_DIR: cstate, INVOCATION_ID: "inv-c" });
  assert.equal(r.status, 0, r.out);
  // A labelled container the daemon lists but cannot inspect is a cleanup that could not be checked: a failure.
  d = fakeDocker({ containers: [{ id: "ghost", running: "false", finished: "2", oneoff: true }], uninspectable: ["ghost"] });
  r = d.run("ops/prune-docker-verify.sh");
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /cannot be inspected/);
  // A re-list that FAILS is not a container that vanished: both are "not listed", but only the second is benign. The
  // first leaves the cleanup unread, which is a failure.
  d = fakeDocker({ containers: [{ id: "ghost", running: "false", finished: "2", oneoff: true }], uninspectable: ["ghost"], relistFails: true });
  r = d.run("ops/prune-docker-verify.sh", { PRUNE_RELIST_FAIL: "1" });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /could not re-list the containers/);
});

test("a container that disappears between the listing and its inspect or removal is benign, not a failure", () => {
  // Its own `--rm` finished it between `ps` and `inspect`: nothing to inspect, nothing to reclaim, not a failed run.
  let d = fakeDocker({ containers: [{ id: "gone", running: "false", finished: "30", oneoff: true }], vanishOnInspect: ["gone"] });
  let r = d.run("ops/prune-docker-containers.sh");
  assert.equal(r.status, 0, r.out);
  assert.equal(r.status, 0, d.run("ops/prune-docker-verify.sh").status);
  // Still listed, then removed by someone else before our `docker rm`: the removal failing is the wanted outcome.
  d = fakeDocker({ containers: [{ id: "late", running: "false", finished: "30", oneoff: true }], vanishOnRm: ["late"] });
  r = d.run("ops/prune-docker-containers.sh");
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /gone before it was removed/);
});

// ops/host-metrics.sh with fake docker/systemctl: the textfile the node-exporter collector reads.
function metrics({ df, timeout, dir = mkdtempSync(join(tmpdir(), "docker-prom-")), env = {} }) {
  const bin = join(dir, "bin");
  const data = join(dir, "data");
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(data, "modules/monitoring/textfile"), { recursive: true });
  writeFileSync(join(bin, "docker"), `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${join(dir, "calls")}"
${df}\n`);
  writeFileSync(join(bin, "systemctl"), "#!/usr/bin/env bash\nexit 1\n");
  // The real `timeout` with the same arguments, at a fraction of the cap: the behaviour, without a 10 s test.
  if (timeout) writeFileSync(join(bin, "timeout"), `#!/usr/bin/env bash\n[ "$1" = 10 ] || { echo "cap is not 10s: $1" >&2; exit 2; }\nshift 1\nexec /usr/bin/timeout 0.5 "$@"\n`);
  for (const n of ["docker", "systemctl", ...(timeout ? ["timeout"] : [])]) chmodSync(join(bin, n), 0o755);
  const r = execFileSync("bash", [join(repo, "ops/host-metrics.sh")], {
    env: { PATH: `${bin}:/usr/bin:/bin`, HOME: dir, AIDENHQ_DATA_DIR: data, AIDENHQ_STATE_DIR: join(dir, "state"), ...env },
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  });
  const file = join(data, "modules/monitoring/textfile/docker.prom");
  const pruneFile = join(data, "modules/monitoring/textfile/prune-docker.prom");
  return {
    r, file, dir, pruneFile, body: existsSync(file) ? readFileSync(file, "utf8") : "",
    prune: existsSync(pruneFile) ? readFileSync(pruneFile, "utf8") : "",
    calls: existsSync(join(dir, "calls")) ? readFileSync(join(dir, "calls"), "utf8") : "",
  };
}

const ROWS = [
  `{"Active":"5","Reclaimable":"23.7GB (94%)","Size":"25.15GB","TotalCount":"14","Type":"Images"}`,
  `{"Active":"2","Reclaimable":"86.02kB (0%)","Size":"217.4MB","TotalCount":"4","Type":"Containers"}`,
  `{"Active":"4","Reclaimable":"624MB (21%)","Size":"2.882GB","TotalCount":"6","Type":"Local Volumes"}`,
  `{"Active":"0","Reclaimable":"10.52GB","Size":"10.52GB","TotalCount":"284","Type":"Build Cache"}`,
].join("\n");
const DF = `case "$*" in *"system df"*) cat <<'EOT'\n${ROWS}\nEOT\n;; *) exit 0 ;; esac`;

test("docker.prom carries a size gauge per consumer, from docker system df", () => {
  const m = metrics({ df: DF });
  assert.match(m.body, /^aidenhq_docker_collect_ok 1$/m);
  assert.match(m.body, /^aidenhq_docker_images_size_bytes 25150000000$/m);
  assert.match(m.body, /^aidenhq_docker_containers_size_bytes 217400000$/m);
  assert.match(m.body, /^aidenhq_docker_build_cache_size_bytes 10520000000$/m);
  assert.match(m.body, /^aidenhq_docker_volumes_size_bytes 2882000000$/m);
  assert.match(m.body, /^# TYPE aidenhq_docker_images_size_bytes gauge$/m);
  // Reclaimable where the format carries it: "23.7GB (94%)" is a size before its parenthesised share.
  assert.match(m.body, /^aidenhq_docker_images_reclaimable_bytes 23700000000$/m);
  assert.match(m.body, /^aidenhq_docker_build_cache_reclaimable_bytes 10520000000$/m);
  // The other textfiles are still written beside it.
  assert.ok(existsSync(m.file.replace("docker.prom", "units.prom")));
});

test("prune-docker.prom carries each step's last recorded status and invocation", () => {
  const dir = mkdtempSync(join(tmpdir(), "prune-prom-"));
  const state = join(dir, "state");
  mkdirSync(join(state, "prune-docker"), { recursive: true });
  const stamp = new Date("2026-11-23T15:35:45Z");
  // The wrapper's record: `<INVOCATION_ID> <rc>` on the first line. build-cache carries its rows after it, which are not
  // part of the header.
  writeFileSync(join(state, "prune-docker/builder-buildx"), "0f2a 1\n");
  writeFileSync(join(state, "prune-docker/builder-classic"), "0f2a 0\n");
  writeFileSync(join(state, "prune-docker/build-cache"), '0f2a 0\n{"Type":"Build Cache","Size":"53.87GB","Reclaimable":"3GB"}\n');
  writeFileSync(join(state, "prune-docker/images"), "0f2a 0\n");
  writeFileSync(join(state, "prune-docker/containers"), "0f2a 0\n");
  for (const name of readdirSync(join(state, "prune-docker"))) utimesSync(join(state, "prune-docker", name), stamp, stamp);
  const m = metrics({ dir, df: DF });
  const ts = Math.floor(stamp.getTime() / 1000);
  assert.match(m.prune, /^# TYPE aidenhq_prune_docker_step_rc gauge$/m);
  assert.match(m.prune, /^aidenhq_prune_docker_step_rc\{step="builder-buildx",invocation="0f2a"\} 1$/m);
  assert.match(m.prune, /^aidenhq_prune_docker_step_rc\{step="builder-classic",invocation="0f2a"\} 0$/m);
  assert.match(m.prune, /^aidenhq_prune_docker_step_rc\{step="build-cache",invocation="0f2a"\} 0$/m);
  assert.match(m.prune, new RegExp(`^aidenhq_prune_docker_step_run_timestamp_seconds\\{step="build-cache",invocation="0f2a"\\} ${ts}$`, "m"));
  // The rows after the header are not a second series and the atomic write's .tmp is not a step.
  assert.equal((m.prune.match(/^aidenhq_prune_docker_step_rc\{/gm) ?? []).length, 5);
  // An empty state directory still writes the file (its mtime is what HostMetricsStale reads) with no series.
  const empty = metrics({ dir: mkdtempSync(join(tmpdir(), "prune-prom-empty-")), df: DF });
  mkdirSync(join(empty.dir, "state", "prune-docker"), { recursive: true });
  const emptyState = metrics({ dir: empty.dir, df: DF });
  assert.match(emptyState.prune, /^# TYPE aidenhq_prune_docker_step_rc gauge$/m);
  assert.doesNotMatch(emptyState.prune, /^aidenhq_prune_docker_step_rc\{/m);
  // No state directory at all: no file, and a previous file is removed so its stale step is not served.
  const absent = metrics({ dir: empty.dir, df: DF });
  rmSync(join(absent.dir, "state", "prune-docker"), { recursive: true, force: true });
  const absentRun = metrics({ dir: absent.dir, df: DF });
  assert.equal(absentRun.prune, "", "no prune state directory means no prune-docker.prom");
});

test("a malformed prune step record is skipped, never guessed", () => {
  const dir = mkdtempSync(join(tmpdir(), "prune-prom-bad-"));
  const state = join(dir, "state");
  mkdirSync(join(state, "prune-docker"), { recursive: true });
  writeFileSync(join(state, "prune-docker/images"), "not-a-status\n");
  writeFileSync(join(state, "prune-docker/containers"), "inv-b 0\n");
  writeFileSync(join(state, "prune-docker/images.tmp"), "inv-c 0\n");
  const m = metrics({ dir, df: DF });
  assert.doesNotMatch(m.prune, /step="images"/, "a record without a numeric rc is not a status");
  assert.match(m.prune, /^aidenhq_prune_docker_step_rc\{step="containers",invocation="inv-b"\} 0$/m);
  assert.doesNotMatch(m.prune, /step="images\.tmp"/, "the atomic write's temporary file is not a step");
});

// A run where docker cannot answer still rewrites the file: collect_ok 0 and no byte count, so the previous run's sizes
// are never served as current and a fresh install still gets a file whose mtime HostMetricsStale reads.
const UNKNOWN = /^aidenhq_docker_collect_ok 0$/m;

test("docker system df failing reports the breakdown as unknown, not as zero and not as the last run's bytes", () => {
  const m = metrics({ df: `case "$*" in *"system df"*) echo "Cannot connect to the Docker daemon" >&2; exit 1 ;; *) exit 0 ;; esac` });
  assert.match(m.body, UNKNOWN);
  assert.doesNotMatch(m.body, /_size_bytes \d/m, m.body);
  assert.ok(existsSync(m.file), "the file is rewritten, so its mtime is current");
});

test("a failed cache write still publishes the sample this run just read", () => {
  // A read-only data dir (or a full disk where the cache lives) must not turn a fresh answer into unknown: the bytes are
  // current whatever happened to the file.
  const dir = mkdtempSync(join(tmpdir(), "docker-prom-ro-"));
  const data = join(dir, "data");
  const cacheDir = join(data, "modules/monitoring");
  mkdirSync(cacheDir, { recursive: true });
  // The cache path is occupied by a directory, so the atomic rename onto it fails.
  mkdirSync(join(cacheDir, "docker-df.json"));
  const m = metrics({ dir, df: DF });
  assert.match(m.body, /^aidenhq_docker_collect_ok 1$/m, m.body);
  assert.match(m.body, /^aidenhq_docker_images_size_bytes 25150000000$/m, m.body);
});

test("the step wrapper runs the prune once and records its status for the verification", () => {
  const state = mkdtempSync(join(tmpdir(), "prune-step-"));
  const step = join(repo, "ops/prune-docker-step.sh");
  let r = spawnSync("bash", [step, "images", "bash", "-c", "exit 0"], { env: { PATH: "/usr/bin:/bin", AIDENHQ_STATE_DIR: state, INVOCATION_ID: "inv-a" }, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(join(state, "prune-docker/images"), "utf8").trim(), "inv-a 0");
  r = spawnSync("bash", [step, "images", "bash", "-c", "exit 7"], { env: { PATH: "/usr/bin:/bin", AIDENHQ_STATE_DIR: state, INVOCATION_ID: "inv-b" }, encoding: "utf8" });
  assert.equal(r.status, 7, "the step's own status still reaches the prefixed ExecStart");
  assert.equal(readFileSync(join(state, "prune-docker/images"), "utf8").trim(), "inv-b 7");
});

test("the cache snapshot and its status are one record, so a stale snapshot cannot pass as the new run's", () => {
  const state = mkdtempSync(join(tmpdir(), "prune-record-"));
  const step = join(repo, "ops/prune-docker-step.sh");
  const run = (d, inv) => spawnSync("bash", [step, "build-cache", "docker", "system", "df", "--format", "{{json .}}"],
    { env: { PATH: `${d.bin}:/usr/bin:/bin`, AIDENHQ_STATE_DIR: state, INVOCATION_ID: inv }, encoding: "utf8" });
  const run0 = run(fakeDocker({ cache: "10.52GB" }), "inv-first");
  assert.equal(run0.status, 0);
  // One file holds the invocation, the status and the rows: a reader either gets that run's whole result or nothing new.
  const rec = readFileSync(join(state, "prune-docker/build-cache"), "utf8");
  assert.match(rec, /^inv-first 0\n/);
  assert.match(rec, /10\.52GB/);
  assert.doesNotMatch(readdirSync(join(state, "prune-docker")).join(" "), /build-cache\.(df|status)/, "no second file can disagree");
  // This run's builder prunes failed and the cache is over the ceiling: the record says so and the verification fails,
  // rather than reading the earlier run's under-ceiling rows.
  const over = fakeDocker({ cache: "45GB", reclaimable: "5GB" });
  assert.equal(run(over, "inv-second").status, 0, "system df itself succeeded");
  const r = over.run("ops/prune-docker-verify.sh", { AIDENHQ_STATE_DIR: state, INVOCATION_ID: "inv-second", DOCKER: join(over.bin, "docker") });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /still reclaimable after the prune/);
  // A record from another run is not this run's result either.
  const r2 = over.run("ops/prune-docker-verify.sh", { AIDENHQ_STATE_DIR: state, INVOCATION_ID: "inv-third", DOCKER: join(over.bin, "docker") });
  assert.equal(r2.status, 1, r2.out);
  assert.match(r2.out, /record is from another run/);
});

test("the verification reads the record once, so it cannot pair this run's status with another run's rows", () => {
  // The step publishes with `mv`, so the file itself is never half-written; but a reader that opened it twice could read
  // the header before a manual run replaced it and the rows after, and pass an over-ceiling run on the replacement's.
  // The verification must take both from one read: it never calls `tail` on the record, and an over-ceiling record is
  // still judged over the ceiling however the file changes afterwards.
  assert.doesNotMatch(commands(verify), /\btail\b/, "the record's rows are read from the same bytes as its status");
  const state = mkdtempSync(join(tmpdir(), "prune-one-read-"));
  mkdirSync(join(state, "prune-docker"));
  // This run pruned and the cache was 45 GB with 5 GB still reclaimable: over the ceiling, so the unit must fail.
  writeFileSync(join(state, "prune-docker/images"), "inv-timer 0\n");
  writeFileSync(join(state, "prune-docker/builder-buildx"), "inv-timer 0\n");
  writeFileSync(join(state, "prune-docker/builder-classic"), "inv-timer 0\n");
  writeFileSync(join(state, "prune-docker/build-cache"), 'inv-timer 0\n{"Type":"Build Cache","Size":"45GB","Reclaimable":"5GB"}\n');
  const d = fakeDocker({ cache: "1GB", reclaimable: "0B" });
  const r = d.run("ops/prune-docker-verify.sh", { AIDENHQ_STATE_DIR: state, INVOCATION_ID: "inv-timer", DOCKER: join(d.bin, "docker") });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /still reclaimable after the prune/);
});

test("the ceiling is judged on the cache right after pruning, not on a later read a build has grown", () => {
  const state = mkdtempSync(join(tmpdir(), "prune-snapshot-"));
  const step = (d, name = "build-cache", ...cmd) => spawnSync("bash", [join(repo, "ops/prune-docker-step.sh"), name, ...(cmd.length ? cmd : ["docker", "system", "df", "--format", "{{json .}}"])],
    { env: { PATH: `${d.bin}:/usr/bin:/bin`, AIDENHQ_STATE_DIR: state, INVOCATION_ID: "inv-run" }, encoding: "utf8" });
  // The builder, image and container steps ran too (with their own status): the verification reports every missing
  // record, and this test is about the cache snapshot.
  const pruned0 = fakeDocker();
  assert.equal(step(pruned0, "builder-buildx", "bash", "-c", "exit 0").status, 0);
  assert.equal(step(pruned0, "builder-classic", "bash", "-c", "exit 0").status, 0);
  assert.equal(step(pruned0, "images", "docker", "image", "prune", "-af").status, 0);
  assert.equal(step(pruned0, "containers", "bash", "-c", "exit 0").status, 0);
  // The builder prunes finished at 10.52 GB: the step right after them records exactly that.
  const pruned = fakeDocker({ cache: "10.52GB" });
  assert.equal(step(pruned, "build-cache", "docker", "system", "df", "--format", "{{json .}}").status, 0);
  assert.match(readFileSync(join(state, "prune-docker/build-cache"), "utf8"), /10\.52GB/);
  // A build has since grown the cache to 45 GB with 5 GB reclaimable, over the ceiling. The prune did cap the cache, so
  // the verification judges the snapshot and does not call this a failed prune.
  const later = fakeDocker({ cache: "45GB", reclaimable: "5GB" });
  const r = later.run("ops/prune-docker-verify.sh", { AIDENHQ_STATE_DIR: state, INVOCATION_ID: "inv-run", DOCKER: join(later.bin, "docker") });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /verified/);
  assert.doesNotMatch(r.calls, /^system df$/m, "the verification reads the snapshot, not a second disk walk");
  // A snapshot step that could not read the cache is not "nothing cached": the ceiling is unknown, so the unit fails.
  const down = fakeDocker({ systemDfFails: true });
  assert.notEqual(step(down, "build-cache", "docker", "system", "df", "--format", "{{json .}}").status, 0, "the snapshot step reports a failed read");
  const r2 = later.run("ops/prune-docker-verify.sh", { AIDENHQ_STATE_DIR: state, INVOCATION_ID: "inv-run", DOCKER: join(later.bin, "docker") });
  assert.equal(r2.status, 1, r2.out);
  assert.match(r2.out, /could not read the cache/);
});

test("docker.prom is cached for 5 minutes: the 30 s timer does not walk every image, container and volume each run", () => {
  const dir = mkdtempSync(join(tmpdir(), "docker-prom-"));
  const first = metrics({ dir, df: DF });
  assert.match(first.body, /^aidenhq_docker_images_size_bytes 25150000000$/m);
  // Second run inside the window: it republishes the cache and never calls Docker's disk walk again.
  writeFileSync(join(dir, "calls"), "");
  const second = metrics({ dir, df: `case "$*" in *"system df"*) echo "must not be called inside the cache window" >&2; exit 1 ;; *) exit 0 ;; esac` });
  assert.doesNotMatch(second.calls, /system df/);
  assert.match(second.body, /^aidenhq_docker_collect_ok 1$/m);
  assert.match(second.body, /^aidenhq_docker_images_size_bytes 25150000000$/m);
  assert.ok(existsSync(join(dir, "data/modules/monitoring/docker-df.json")));
  // Past the window (`AIDENHQ_DOCKER_DF_CACHE_S=0` here) it reads Docker again, and a failed read is unknown, not the old
  // bytes.
  const third = metrics({ dir, env: { AIDENHQ_DOCKER_DF_CACHE_S: "0" }, df: `case "$*" in *"system df"*) echo down >&2; exit 1 ;; *) exit 0 ;; esac` });
  assert.match(third.calls, /system df/);
  assert.match(third.body, UNKNOWN);
  assert.doesNotMatch(third.body, /_size_bytes \d/m, third.body);
});

test("docker system df timing out reports the breakdown as unknown and does not fail the metrics run", { skip: !existsSync("/usr/bin/timeout") && "needs coreutils timeout" }, () => {
  assert.match(readFileSync(join(repo, "ops/host-metrics.sh"), "utf8"), /timeout 10 docker system df/);
  const m = metrics({ timeout: true, df: `case "$*" in *"system df"*) sleep 30 ;; *) exit 0 ;; esac` });
  assert.match(m.body, UNKNOWN);
  assert.doesNotMatch(m.body, /_size_bytes \d/m, m.body);
});

test("both image prunes skip the computer images, which the browser Dockerfile labels and every other computer image inherits", () => {
  const keep = "--filter label!=aidenhq.keep=true";
  for (const [name, text] of [["unit", service], ["apply", apply]]) {
    const prunes = text.split("\n").filter((l) => /docker image prune/.test(l) && !/^\s*#/.test(l));
    assert.ok(prunes.length >= 1, `${name}: no image prune`);
    for (const l of prunes) assert.ok(l.includes(keep), `${name}: image prune without the keep filter: ${l}`);
  }
  assert.match(readFileSync(join(repo, "services/computer/images/browser/Dockerfile"), "utf8"), /^LABEL aidenhq\.keep=true$/m);
  // Labelled images are never pruned, so an apply removes the superseded ones itself, once its generation is good.
  assert.match(apply, /retireUnits\n(    #[^\n]*\n)*    timeout -k 30s 5m bash ops\/prune-computer-images\.sh \|\| true/);
  assert.doesNotMatch(service, /prune-computer-images/);
});

test("the superseded-image sweep removes labelled images the config no longer names and keeps the current ones, by ID (digest-referenced and dangling ones included)", () => {
  const dir = mkdtempSync(join(tmpdir(), "prune-computer-images-"));
  mkdirSync(join(dir, "ops"));
  mkdirSync(join(dir, "config"));
  mkdirSync(join(dir, "bin"));
  writeFileSync(join(dir, "ops/prune-computer-images.sh"), readFileSync(join(repo, "ops/prune-computer-images.sh")));
  writeFileSync(join(dir, "config/computers.json"), JSON.stringify({ images: { browser: "aidenhq/computer-browser:new", "agent-base": "aidenhq/computer-agent-base:new" } }));
  writeFileSync(join(dir, "bin/docker"), `#!/bin/sh
case "$1 $2" in
  "image inspect") case "$5" in *:new|*:current) echo sha256:cur ;; *) exit 1 ;; esac ;;
  "image ls") case "$*" in *until*) echo "invalid filter 'until'" >&2; exit 1 ;; *label=aidenhq.keep=true*) printf '%s\\n' sha256:cur sha256:old sha256:old sha256:dangling ;; esac ;;
  "image rm") echo "rm $4" >> "$CALLS" ;;
esac
`);
  chmodSync(join(dir, "bin/docker"), 0o755);
  const calls = join(dir, "calls");
  writeFileSync(calls, "");
  const r = spawnSync("bash", [join(dir, "ops/prune-computer-images.sh")], { env: { PATH: `${join(dir, "bin")}:/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin`, CALLS: calls }, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(calls, "utf8"), "rm sha256:dangling\nrm sha256:old\n".repeat(3));
});
