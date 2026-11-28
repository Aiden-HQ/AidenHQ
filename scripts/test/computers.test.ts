// Agent computers: what the launcher is told and which agents may name an image.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { compile, defaultComputersMax, grantEntry } from "../modules.ts";
import { computersConfig, validateImages } from "../computers.ts";
import { BUNDLE } from "./bundle.ts";

const product = join(dirname(fileURLToPath(import.meta.url)), "../..");
function inst(overrides, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), "inst-"));
  writeFileSync(join(dir, "instance.yaml"), YAML.stringify({ product: "0".repeat(40), modules: [...BUNDLE], settings: { timezone: "Europe/London", owner_name: "Sam", owner_email: "o@x", product_repo: "acme/aidenhq", ...extra }, overrides }));
  mkdirSync(join(dir, "agents"));
  return dir;
}

test("the instance switches one agent on; the launcher learns the image tag and the connections it may reach", () => {
  const r = compile(product, inst({ agents: { assistant: { image: "agent-base" } } }));
  assert.equal(r.paperclip.agents.assistant.image, "agent-base");
  const c = computersConfig(r.paperclip, product);
  assert.match(c.images["agent-base"], /^aidenhq\/computer-agent-base:[0-9a-f]{12}$/);
  // The browser image is always built (apps-mcp renders in it), and agents can't name it.
  assert.match(c.images.browser, /^aidenhq\/computer-browser:[0-9a-f]{12}$/);
  assert.match(computersConfig(compile(product, inst({})).paperclip, product).images.browser, /^aidenhq\/computer-browser:/);
  // Agent jobs' computers (`max`) and check jobs' own (`checks`, a constant 32): the kernel admits each kind against its own, the launcher keeps both.
  assert.equal(r.computersMax, defaultComputersMax());
  assert.deepEqual([computersConfig(r.paperclip, product, r.computersMax, r.checkComputersMax).max, r.checkComputersMax], [r.computersMax, 32]);
  // Unset, the pool follows the host's RAM (one box per 1.5 GB, 4 to 64); a setting wins.
  const GB = 2 ** 30;
  assert.deepEqual([1, 8, 16, 32, 64, 128].map((g) => defaultComputersMax(g * GB)), [4, 5, 10, 21, 42, 64]);
  assert.equal(compile(product, inst({}, { computers_max: 7 })).computersMax, 7);
  // A profile is compiled into the grants entry the kernel freezes into each job (crew unless the agent says otherwise).
  assert.equal(grantEntry("assistant", r.paperclip.agents.assistant, r.paperclip.routines).profile, "crew");
  const eng = compile(product, inst({ agents: { assistant: { image: "agent-base" } } }));
  eng.paperclip.agents.assistant.profile = "engineer";
  assert.equal(grantEntry("assistant", eng.paperclip.agents.assistant, eng.paperclip.routines).profile, "engineer");
  assert.throws(() => validateImages({ x: { image: "browser" } }), /image must be one of agent-base, engineer/);
  // No URL or secret reaches the launcher: every connection goes through the kernel's proxy, tasks included.
  assert.deepEqual(c.connections.apps, { tool_timeout_sec: 600 });
  assert.deepEqual(c.connections.paperclip_tasks, { tool_timeout_sec: 300 });
});

