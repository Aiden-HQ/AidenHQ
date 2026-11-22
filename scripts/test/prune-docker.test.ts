// The host's disk reclaim (ops/units/prune-docker.*, ops/apply-config-work.sh) and the Docker disk gauge it reports
// (ops/host-metrics.sh): the timer must prune often enough that the peak between prunes stays under DiskSpaceLow's line,
// every prune in the oneshot must be independent of the others, stopped containers must be reclaimed, and the size gauges
// must come from `docker system df` without failing the metrics timer when Docker cannot answer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "../..");
const timer = readFileSync(join(repo, "ops/units/prune-docker.timer"), "utf8");
const service = readFileSync(join(repo, "ops/units/prune-docker.service"), "utf8");
const apply = readFileSync(join(repo, "ops/apply-config-work.sh"), "utf8");

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

test("every prune ExecStart is `-`-prefixed, and stopped containers over a day old are pruned", () => {
  const execs = service.split("\n").filter((l) => l.startsWith("ExecStart=")).map((l) => l.slice("ExecStart=".length).trim());
  assert.ok(execs.length >= 2, `prunes: ${execs.join(" | ")}`);
  for (const e of execs) assert.ok(e.startsWith("-"), `not independent, a failing one skips the rest: ${e}`);
  assert.ok(execs.some((e) => e === "-/usr/bin/docker builder prune -f --max-used-space 20GB"), `build cache cap kept: ${execs.join(" | ")}`);
  assert.ok(execs.some((e) => e === "-/usr/bin/docker image prune -af --filter until=48h"), `48h image retention kept: ${execs.join(" | ")}`);
  assert.ok(execs.some((e) => e === "-/usr/bin/docker container prune -f --filter until=24h"), `stopped-container reclaim: ${execs.join(" | ")}`);
  // No volume or data deletion: the prune units never take --volumes or prune volumes.
  assert.doesNotMatch(service, /system prune|--volumes|volume prune/);
});

test("the apply-time prunes are independent too, and keep the same retention", () => {
  const lines = apply.split("\n").filter((l) => /^\s*docker (builder|image|container) prune/.test(l));
  assert.ok(lines.length >= 2, lines.join("\n"));
  for (const l of lines) assert.match(l, /\|\| true$/, `a failing one must not skip the rest: ${l}`);
  assert.ok(lines.some((l) => /docker builder prune -f --max-used-space 20GB\b/.test(l)), lines.join("\n"));
  assert.ok(lines.some((l) => /docker image prune -af --filter until=48h\b/.test(l)), lines.join("\n"));
  assert.doesNotMatch(apply, /^\s*docker (system|volume) prune.*--volumes/m);
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

test("docker system df failing writes nothing, so the gauge reads unknown rather than zero", () => {
  const m = metrics({ df: `case "$*" in *"system df"*) echo "Cannot connect to the Docker daemon" >&2; exit 1 ;; *) exit 0 ;; esac` });
  assert.equal(m.body, "", "no docker.prom on an error");
});

test("docker system df timing out writes nothing and does not fail the metrics run", { skip: !existsSync("/usr/bin/timeout") && "needs coreutils timeout" }, () => {
  assert.match(readFileSync(join(repo, "ops/host-metrics.sh"), "utf8"), /timeout 10 docker system df/);
  const m = metrics({ timeout: true, df: `case "$*" in *"system df"*) sleep 30 ;; *) exit 0 ;; esac` });
  assert.equal(m.body, "");
});
