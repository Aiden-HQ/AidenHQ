// The host's disk reclaim (ops/units/prune-docker.*, ops/prune-docker.sh, ops/apply-config-work.sh) and the Docker disk
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
const script = readFileSync(join(repo, "ops/prune-docker.sh"), "utf8");
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

test("the unit runs the reclaim script from the applied checkout, and fails the unit when a step did not do its work", () => {
  const execs = service.split("\n").filter((l) => l.startsWith("ExecStart="));
  assert.equal(execs.length, 1, `one step to report on: ${execs.join(" | ")}`);
  // Not `-`-prefixed: a prefix would swallow the script's exit 1, and a prune where every step failed would read clean.
  assert.equal(execs[0], "ExecStart=/usr/bin/env bash ${AIDENHQ_DIR}/ops/prune-docker.sh");
  assert.match(service, /^Environment=AIDENHQ_DIR=/m);
  assert.match(service, /^EnvironmentFile=-%h\/\.config\/aidenhq-prune-docker\.env$/m, "the applied checkout wins over the one setup recorded");
  assert.ok(execs.every((e) => !e.startsWith("ExecStart=-")), "the reclaim's own failure must reach systemd");
});

test("the script attempts every prune, and still exits non-zero when one did not do its work", () => {
  assert.ok(existsSync(join(repo, "ops/prune-docker.sh")));
  assert.ok(statSync(join(repo, "ops/prune-docker.sh")).mode & 0o100, "executable");
  assert.doesNotMatch(script, /^set -e/m, "set -e would stop at the first failing step");
  // The cache cap in both flag forms: buildx knows --max-used-space, the classic fallback only --keep-storage (a CLI
  // without the buildx plugin fails the first with "unknown flag"), and each is a no-op where the other works.
  assert.match(script, /builder prune -f --max-used-space 20GB/);
  assert.match(script, /builder prune -f --keep-storage 20GB/);
  assert.match(script, /image prune -af --filter until=48h/, "48 h image retention kept");
  assert.match(script, /exit 1/, "a step that failed must fail the run");
  // Containers: only the explicitly disposable label, and only by how long they have been stopped. `container prune
  // --filter until=` filters on CREATED time (moby daemon/prune.go), which would delete a service an apply's generation
  // snapshot had just stopped and then could not start again.
  assert.match(script, /ps -aq\b/);
  assert.match(script, /State\.FinishedAt/, "stopped time, not created time");
  assert.match(script, /com\.docker\.compose\.service/, "a compose service an apply stopped is never a candidate");
  assert.match(script, /aidenhq\.computer/, "nor a computer box");
  assert.match(script, /86400/);
  assert.doesNotMatch(commands(script), /container prune|--filter until=24h/, "container prune filters on created time, which can delete a stopped service");
  // No volume or data deletion: no -v, no volume prune, no system prune, and app-warehouse_pgdata is never named. The
  // comments say so in words, so the commands are what this reads.
  assert.doesNotMatch(commands(script), /rm -[a-z]*v|--volumes|volume prune|system prune|app-warehouse_pgdata/);
});

test("apply runs the same script after its rebuilds, and never fails an apply that already switched over", () => {
  assert.match(apply, /^\s*bash ops\/prune-docker\.sh \|\| true$/m, "the apply-time reclaim is the unit's own script");
  const direct = apply.split("\n").filter((l) => /^\s*docker (builder|image|container) prune/.test(l));
  assert.deepEqual(direct, [], "one copy of the flags, in ops/prune-docker.sh");
  assert.doesNotMatch(apply, /^\s*docker (system|volume) prune.*--volumes/m);
});

// ops/prune-docker.sh against a fake docker: which steps ran, and what it did to a container.
const HOUR = 3600;
function prune({ builder = 0, image = 0, containers = [] }) {
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
  "builder prune")  echo "\${*}" >> "${calls}.builder"; exit ${builder} ;;
  "image prune") exit ${image} ;;
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
  "system df") echo "TYPE SIZE"; exit 0 ;;
esac
exit 0
`);
  chmodSync(join(bin, "docker"), 0o755);
  const r = spawnSync("bash", [join(repo, "ops/prune-docker.sh")], {
    env: { PATH: "/usr/bin:/bin", DOCKER: join(bin, "docker") },
    encoding: "utf8",
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}`, calls: readFileSync(calls, "utf8") };
}

test("a failing builder prune does not skip the image prune, and a failed cap fails the run", () => {
  const r = prune({ builder: 1 });
  assert.match(r.calls, /builder prune -f --max-used-space 20GB/);
  assert.match(r.calls, /builder prune -f --keep-storage 20GB/);
  assert.match(r.calls, /image prune -af --filter until=48h/);
  assert.equal(r.status, 1, `every cache-cap form failed: the unit must not read clean\n${r.out}`);
  assert.match(r.out, /20 GB cap did not run/);
  const ok = prune({ builder: 0 });
  assert.equal(ok.status, 0, ok.out);
});

test("a failed image prune fails the run, after the container cleanup ran", () => {
  const r = prune({ image: 1, containers: [{ id: "gen1", running: "false", finished: "30" }] });
  assert.match(r.calls, /^ps -aq$/m, "cleanup is not skipped");
  assert.match(r.calls, /^rm gen1$/m);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /images: unused for 48 h/);
});

test("only disposable containers stopped over a day are removed, and never with their volumes", () => {
  const r = prune({
    containers: [
      { id: "running", running: "true", finished: "30" },
      { id: "young", running: "false", finished: "2" },
      { id: "old", running: "false", finished: "30" },
      { id: "service", running: "false", finished: "30", service: "warehouse", computer: "" },
      { id: "box", running: "false", finished: "30", service: "", computer: "1" },
      { id: "never", running: "false", finished: "never" },
    ],
  });
  assert.match(r.calls, /^rm old$/m, r.calls);
  assert.match(r.calls, /^rm never$/m, "a created-never-started one-off holds no layer");
  // A stopped compose service may be one an apply's generation snapshot stopped a moment ago, and a computer box has its
  // own lifecycle: neither is a one-off, however long ago they were created.
  assert.doesNotMatch(r.calls, /^rm (running|young|service|box)$/m, r.calls);
  assert.doesNotMatch(r.calls, /rm -.v|rm -f?[a-z]*v /, "docker rm takes no -v: volumes stay");
  assert.equal(r.status, 0, r.out);
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
