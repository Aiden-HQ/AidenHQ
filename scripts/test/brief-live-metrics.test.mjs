// A daily brief led its "Needs you" list with a disk figure copied from the previous night's note; an overnight cleanup
// had already fixed it, and the owner's real open item was hidden behind the stale number. The rule, the read that makes it
// possible and the check that holds a brief to it live in the pinned modules; this reads the pin, so a later bump that
// drops any of them fails here rather than in the next brief.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const modules = join(dirname(fileURLToPath(import.meta.url)), "../../modules");
const read = (...p) => readFileSync(join(modules, ...p), "utf8");

test("the pinned chief-of-staff handbook reads brief numbers live and says where a number it can't read comes from", () => {
  const handbook = read("chief-of-staff", "agents", "chief-of-staff", "AGENTS.md");
  assert.match(handbook, /Every number you put in front of the owner \(disk, memory, spend, counts\) is read live in this run/);
  assert.match(handbook, /never copied from an earlier task's note or a previous brief/);
  assert.match(handbook, /its reason line states the live measure and whether the task's done condition is already met/);
  assert.match(handbook, /A number you can't measure yourself .* comes from the agent that holds it, asked in this run/);
  assert.match(handbook, /`query_prometheus`/); // the read the grant below makes possible
});

test("the pinned chief of staff may read the host's own series", () => {
  const manifest = read("chief-of-staff", "module.yaml");
  const cos = manifest.slice(manifest.indexOf("  chief-of-staff:"), manifest.indexOf("  assistant:"));
  assert.match(cos, /^ {6}grafana\?: read$/m);
});

test("the pinned task tools hold a brief's host and fleet figures to a measurement from the run that wrote it", () => {
  const tools = read("tasks", "connections", "tasks-mcp", "src", "tools.mjs");
  assert.match(tools, /Read the value live at brief time; quote it with the time you measured it/);
  assert.match(tools, /const MEASURED_FRESH_MS = 15 \* 60_000/);
  assert.match(tools, /const HOST_METRIC = /);
  assert.match(tools, /source:brief:/); // a brief is found by its marker, not only its label
  // A metric-free brief is never flagged, and the warning does not stop the brief from being filed.
  assert.match(tools, /if \(!stale\.length\) return undefined;/);
  assert.ok(read("tasks", "connections", "tasks-mcp", "test", "brief-live-metrics.test.mjs").includes("no time it was measured within 15 minutes"));
});
