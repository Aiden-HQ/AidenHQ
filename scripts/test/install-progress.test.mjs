import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const apply = readFileSync(join(root, "ops/apply-config-work.sh"), "utf8");
const BASE = "7/9/8/80/900"; // the installer's step 7 of 9, from 8% for 80 points, a 900 s install

const progress = (out) => out.split("\n").filter((l) => l.startsWith("AIDENHQ_PROGRESS=")).map((l) => {
  const m = l.match(/^AIDENHQ_PROGRESS=(\d+)\/(\d+) (\d+)% (.+) ~(\d+)$/);
  assert.ok(m, `not the fixed format: ${l}`);
  return { n: +m[1], total: +m[2], pct: +m[3], step: m[4], left: +m[5] };
});
const nondecreasing = (ls) => ls.every((l, i) => i === 0 || l.pct >= ls[i - 1].pct);

// The apply's laps in the order the script runs them, with the real phase table, as one (possibly killed) run.
const laps = [...apply.matchAll(/^\s*lap ([a-z-]+)/gm)].map((m) => m[1]);
const table = apply.match(/^APPLY_PHASES=\([\s\S]*?^\)/m)[0];
const run = (kill = "", env = {}) => spawnSync("bash", ["-c", `
  . ${root}/ops/lib/progress.sh
  ${table}
  lap() { progress_after APPLY_PHASES "$1"; [ "$1" != "$KILL_AFTER" ] || kill -9 $$; }
  progress_line APPLY_PHASES instance
  for p in ${[...new Set(laps)].join(" ")}; do lap "$p"; done
`], { encoding: "utf8", env: { PATH: process.env.PATH, KILL_AFTER: kill, ...env } });

test("apply phases print progress lines in the installer's format, never down, inside the slice", () => {
  const ls = progress(run("", { AIDENHQ_PROGRESS_BASE: BASE }).stdout);
  assert.ok(ls.length >= 6, `${ls.length} lines`); // phases that share a percent report once
  assert.ok(ls.every((l) => l.n === 7 && l.total === 9 && l.pct >= 8 && l.pct <= 88), JSON.stringify(ls));
  assert.ok(ls.every((l, i) => i === 0 || l.pct > ls[i - 1].pct));
  assert.ok(nondecreasing(ls));
  assert.ok(ls.some((l) => /downloading/.test(l.step)), "the image pull is its own phase");
  assert.equal(run("", {}).stdout, "", "without AIDENHQ_PROGRESS_BASE nothing is printed");
});

test("rerun after a killed pull: the apply stopped mid-pull, the rerun reports again from its start and goes on to the slice's end", () => {
  // setup.sh's equivalent of the installer's test: the full setup can't run offline, so the kill is in the apply's pull phase.
  const env = { AIDENHQ_PROGRESS_BASE: BASE };
  const first = run("compose", env);
  assert.equal(first.status, null, "the first run was killed");
  const a = progress(first.stdout);
  assert.equal(a.at(-1).step, "setting up Aiden and the agents", "the last line before the kill: the pull had just finished its phase");
  const b = progress(run("", env).stdout);
  assert.ok(nondecreasing(b) && b[0].pct === a[0].pct, "the rerun starts at the slice's start");
  assert.ok(b.at(-1).pct > a.at(-1).pct);
});

test("an apply handing over to a newer copy of itself never reports a lower percent", () => {
  const out = execFileSync("bash", ["-c", `
    . ${root}/ops/lib/progress.sh
    ${table}
    progress_line APPLY_PHASES instance; progress_after APPLY_PHASES validate
    (progress_line APPLY_PHASES instance; progress_after APPLY_PHASES compose)   # the new copy, from the start, with the exported last percent
  `], { encoding: "utf8", env: { PATH: process.env.PATH, AIDENHQ_PROGRESS_BASE: BASE } });
  const ls = progress(out);
  assert.deepEqual(ls.map((l) => l.step), ["checking your instance", "checking what changed", "setting up Aiden and the agents"], out);
  assert.ok(nondecreasing(ls));
});

test("setup's dry run reports its phases and nests the apply's slice", () => {
  const dir = mkdtempSync(join(tmpdir(), "progress-"));
  const cfg = join(dir, "p.env");
  writeFileSync(cfg, "AIDENHQ_USER=alice\nOWNER_NAME=Alice\nOWNER_EMAIL=alice@example.com\nTIMEZONE=UTC\n");
  const out = execFileSync("bash", [join(root, "ops/setup.sh"), "--dry-run", "--unattended", "--no-tailscale", "--config", cfg], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { PATH: process.env.PATH, AIDENHQ_PROGRESS_BASE: BASE },
  });
  const ls = progress(out);
  assert.deepEqual(ls.map((l) => l.step.split(" ")[0]), ["installing", "writing", "preparing", "downloading", "starting", "making"]);
  assert.ok(nondecreasing(ls) && ls.at(-1).pct < 88 && ls[0].pct === 8);
  assert.match(out, /with AIDENHQ_PROGRESS_BASE,/, "the apply gets its slice");
  assert.ok(!out.split("\n").some((l) => l.startsWith("AIDENHQ_SETUP_URL=")), "the link line is the installer's to follow, not part of progress");
});
