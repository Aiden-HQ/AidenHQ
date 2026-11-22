// The host's disk reclaim (ops/units/prune-docker.*, ops/prune-docker-containers.sh, ops/prune-docker-verify.sh,
// ops/apply-config-work.sh) and the Docker disk
// gauge it reports (ops/host-metrics.sh): the timer must prune often enough that the peak between prunes stays under the
// alert line, every prune must happen whatever the ones before it did, the run must still fail when a prune did not do its
// work, only disposable containers that have been STOPPED long enough may go, and the size gauges must come from
// `docker system df` without serving stale numbers (or failing the metrics timer) when Docker cannot answer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
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
  // The cache cap in both flag forms: buildx knows --max-used-space, the classic fallback only --keep-storage (a CLI
  // without the buildx plugin fails the first with "unknown flag"), and each is a no-op where the other works.
  assert.ok(execs.some((e) => e === "-/usr/bin/docker builder prune -f --max-used-space 20GB"), `buildx cache cap: ${execs.join(" | ")}`);
  assert.ok(execs.some((e) => e === "-/usr/bin/docker builder prune -f --keep-storage 20GB"), `classic-builder cache cap: ${execs.join(" | ")}`);
  assert.ok(execs.some((e) => e === "-/usr/bin/docker image prune -af --filter until=48h"), `48h image retention kept: ${execs.join(" | ")}`);
  assert.ok(execs.some((e) => e === "-/usr/bin/env bash ${AIDENHQ_DIR}/ops/prune-docker-containers.sh"), `one-off reclaim: ${execs.join(" | ")}`);
  assert.match(service, /^Environment=AIDENHQ_DIR=/m);
  assert.match(service, /^EnvironmentFile=-%h\/\.config\/aidenhq-prune-docker\.env$/m, "the applied checkout wins over the one setup recorded");
  // No volume or data deletion: the unit never takes --volumes or prunes volumes.
  assert.doesNotMatch(service, /system prune|--volumes|volume prune/);
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
  // The verification checks the three ways the reclaim can silently not happen: the daemon, the 20 GB cache cap, and a
  // one-off stopped over a day that is still there.
  assert.match(verify, /docker|"\$DOCKER" info/, "the daemon must answer");
  assert.match(verify, /Build Cache/);
  assert.match(verify, /CAP_BYTES=.*20|21 \* 1000/);
  assert.match(verify, /State\.FinishedAt/);
  assert.match(verify, /exit 1/);
  assert.doesNotMatch(commands(verify), /rm -[a-z]*v|--volumes|volume prune|system prune|app-warehouse_pgdata/);
});

test("the apply-time prunes are independent too, and keep the same retention", () => {
  const lines = apply.split("\n").filter((l) => /^\s*(docker (builder|image|container) prune|bash ops\/prune-docker-containers\.sh)/.test(l));
  assert.ok(lines.length >= 4, lines.join("\n"));
  for (const l of lines) assert.match(l, /\|\| true$/, `a failing one must not skip the rest: ${l}`);
  assert.ok(lines.some((l) => /docker builder prune -f --max-used-space 20GB\b/.test(l)), lines.join("\n"));
  assert.ok(lines.some((l) => /docker builder prune -f --keep-storage 20GB\b/.test(l)), lines.join("\n"));
  assert.ok(lines.some((l) => /docker image prune -af --filter until=48h\b/.test(l)), lines.join("\n"));
  assert.ok(lines.some((l) => /bash ops\/prune-docker-containers\.sh\b/.test(l)), lines.join("\n"));
  assert.doesNotMatch(apply, /^\s*docker (system|volume) prune.*--volumes/m);
});

// ops/prune-docker-containers.sh and ops/prune-docker-verify.sh against a fake docker: what the container step does, and
// what the verification makes of the host afterwards.
function fakeDocker({ containers = [], cache = "10.52GB", daemonUp = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "prune-docker-"));
  const bin = join(dir, "bin");
  const calls = join(dir, "calls");
  mkdirSync(bin);
  writeFileSync(calls, "");
  // One row per container: id|running|hours-stopped (`never` for the zero time a container created and never started has)
  // |compose service|computer label.
  const rows = containers.map((c) => `${c.id}|${c.running}|${c.finished}|${c.service ?? ""}|${c.computer ?? ""}`).join("\n");
  writeFileSync(join(bin, "docker"), `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${calls}"
case "$1 $2" in
  "info"*) exit ${daemonUp ? 0 : 1} ;;
  "ps -aq") cut -d'|' -f1 <<'EOT'
${rows}
EOT
    exit 0 ;;
  "inspect -f")
    id="\${@: -1}"
    while IFS='|' read -r cid running hours service computer; do
      [ "$cid" = "$id" ] || continue
      case "$hours" in
        never) finished=0001-01-01T00:00:00Z ;;
        *) finished="$(date -u -d "-$hours hours" +%Y-%m-%dT%H:%M:%S.%NZ)" ;;
      esac
      printf '%s|%s|%s|%s\\n' "$running" "$finished" "$service" "$computer"
      exit 0
    done <<'EOT'
${rows}
EOT
    exit 1 ;;
  "rm "*|"rm") exit 0 ;;
  "system df") printf '{"Size":"%s","Type":"Build Cache"}\\n' "${cache}"; exit 0 ;;
esac
exit 0
`);
  chmodSync(join(bin, "docker"), 0o755);
  return {
    calls: () => readFileSync(calls, "utf8"),
    run: (script) => {
      const r = spawnSync("bash", [join(repo, script)], { env: { PATH: "/usr/bin:/bin", DOCKER: join(bin, "docker") }, encoding: "utf8" });
      return { status: r.status, out: `${r.stdout}${r.stderr}`, calls: readFileSync(calls, "utf8") };
    },
  };
}

test("only one-offs stopped over a day are removed, and never with their volumes", () => {
  const d = fakeDocker({
    containers: [
      { id: "running", running: "true", finished: "30" },
      { id: "young", running: "false", finished: "2" },
      { id: "old", running: "false", finished: "30" },
      { id: "service", running: "false", finished: "30", service: "warehouse", computer: "" },
      { id: "box", running: "false", finished: "30", service: "", computer: "1" },
      { id: "never", running: "false", finished: "never" },
    ],
  });
  const r = d.run("ops/prune-docker-containers.sh");
  assert.match(r.calls, /^rm old$/m, r.calls);
  // A composposed service may be one an apply's generation snapshot stopped a moment ago, and a computer box has its own
  // lifecycle: neither is a one-off. A container created and never started has no stopped time to measure the day
  // against, so the retention rule gives no reason to remove it.
  assert.doesNotMatch(r.calls, /^rm (running|young|service|box|never)$/m, r.calls);
  assert.match(r.out, /never: never started, kept/, r.out);
  assert.doesNotMatch(r.calls, /rm -[a-z]*v/, "docker rm takes no -v: volumes stay");
  assert.equal(r.status, 0, r.out);
});

test("the apply-time container step and the unit's are the same script, so the retention has one home", () => {
  assert.match(apply, /^\s*bash ops\/prune-docker-containers\.sh \|\| true$/m);
  assert.doesNotMatch(apply, /docker container prune/);
});

test("the verification fails the unit when the daemon is down, the cache is over the cap, or a one-off was left", () => {
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
  // Neither builder flag form capped the cache: the 20 GB cap is the thing that has to hold.
  d = fakeDocker({ cache: "104.2GB" });
  r = d.run("ops/prune-docker-verify.sh");
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /over the 20 GB cap/);
  // A one-off stopped over a day ago is still there: the container step did not do its work.
  d = fakeDocker({ containers: [{ id: "left", running: "false", finished: "30" }] });
  r = d.run("ops/prune-docker-verify.sh");
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /container left is a one-off stopped over a day ago and still there/);
});

// ops/host-metrics.sh with fake docker/systemctl: the textfile the node-exporter collector reads.
function metrics({ df, timeout }) {
  const dir = mkdtempSync(join(tmpdir(), "docker-prom-"));
  const bin = join(dir, "bin");
  const data = join(dir, "data");
  mkdirSync(bin);
  mkdirSync(join(data, "modules/monitoring/textfile"), { recursive: true });
  writeFileSync(join(bin, "docker"), `#!/usr/bin/env bash\n${df}\n`);
  writeFileSync(join(bin, "systemctl"), "#!/usr/bin/env bash\nexit 1\n");
  // The real `timeout` with the same arguments, at a fraction of the cap: the behaviour, without a 10 s test.
  if (timeout) writeFileSync(join(bin, "timeout"), `#!/usr/bin/env bash\n[ "$1" = 10 ] || { echo "cap is not 10s: $1" >&2; exit 2; }\nshift 1\nexec /usr/bin/timeout 0.5 "$@"\n`);
  for (const n of ["docker", "systemctl", ...(timeout ? ["timeout"] : [])]) chmodSync(join(bin, n), 0o755);
  const r = execFileSync("bash", [join(repo, "ops/host-metrics.sh")], {
    env: { PATH: `${bin}:/usr/bin:/bin`, HOME: dir, AIDENHQ_DATA_DIR: data, AIDENHQ_STATE_DIR: join(dir, "state") },
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  });
  const file = join(data, "modules/monitoring/textfile/docker.prom");
  return { r, file, body: existsSync(file) ? readFileSync(file, "utf8") : "" };
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

// A run where docker cannot answer still rewrites the file: collect_ok 0 and no byte count, so the previous run's sizes
// are never served as current and a fresh install still gets a file whose mtime HostMetricsStale reads.
const UNKNOWN = /^aidenhq_docker_collect_ok 0$/m;

test("docker system df failing reports the breakdown as unknown, not as zero and not as the last run's bytes", () => {
  const m = metrics({ df: `case "$*" in *"system df"*) echo "Cannot connect to the Docker daemon" >&2; exit 1 ;; *) exit 0 ;; esac` });
  assert.match(m.body, UNKNOWN);
  assert.doesNotMatch(m.body, /_size_bytes \d/m, m.body);
  assert.ok(existsSync(m.file), "the file is rewritten, so its mtime is current");
});

test("docker system df timing out reports the breakdown as unknown and does not fail the metrics run", { skip: !existsSync("/usr/bin/timeout") && "needs coreutils timeout" }, () => {
  assert.match(readFileSync(join(repo, "ops/host-metrics.sh"), "utf8"), /timeout 10 docker system df/);
  const m = metrics({ timeout: true, df: `case "$*" in *"system df"*) sleep 30 ;; *) exit 0 ;; esac` });
  assert.match(m.body, UNKNOWN);
  assert.doesNotMatch(m.body, /_size_bytes \d/m, m.body);
});
