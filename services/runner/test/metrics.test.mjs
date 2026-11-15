// The runner's metrics file (monitoring module): valid Prometheus text, written atomically, and only when the module made
// its directory.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMetrics, writeMetrics } from "../src/metrics.ts";

test("runner metrics: queue, jobs, durations and merge queues as exposition text", () => {
  const m = createMetrics();
  m.jobEnded(120);
  m.jobEnded(4000);
  const now = Date.parse("2026-11-14T12:00:00Z");
  const text = m.text({ now, queued: 3, running: [{ startedAt: "2026-11-14T11:50:00Z" }], merges: [{ state: "running", prs: [{ status: "pending" }, { status: "merged" }] }, { state: "stopped", held: true, prs: [] }] });
  for (const l of text.trim().split("\n")) assert.match(l, /^(# (HELP|TYPE) \w+ .+|[a-z_]+(\{[a-z_]+="[^"]*"\})? -?\d+(\.\d+)?)$/);
  assert.match(text, /^aidenhq_runner_queue_depth 3$/m);
  assert.match(text, /^aidenhq_runner_running_jobs 1$/m);
  assert.match(text, /^aidenhq_runner_oldest_job_seconds 600$/m);
  assert.match(text, /^aidenhq_runner_job_duration_seconds_bucket\{le="300"\} 1$/m);
  assert.match(text, /^aidenhq_runner_job_duration_seconds_bucket\{le="\+Inf"\} 2$/m);
  assert.match(text, /^aidenhq_runner_job_duration_seconds_count 2$/m);
  assert.match(text, /^aidenhq_runner_merge_queues\{state="held"\} 1$/m);
  assert.match(text, /^aidenhq_runner_merge_prs_waiting 1$/m);

  const dir = mkdtempSync(join(tmpdir(), "rm-"));
  const off = join(dir, "missing", "runner.prom");
  assert.equal(writeMetrics(off, text), false);
  assert.equal(existsSync(off), false);
  mkdirSync(join(dir, "textfile"));
  assert.equal(writeMetrics(join(dir, "textfile", "runner.prom"), text), true);
  assert.equal(readFileSync(join(dir, "textfile", "runner.prom"), "utf8"), text);
});
