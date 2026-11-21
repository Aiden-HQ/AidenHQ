// A publish stays inside the brief: the Engineer handbook says the diff carries the change the task names, and an
// access rule, a config change or an unrelated file comes in only when the brief asks for it by name. A fix that seems to need
// one is raised on the task so its delegator can widen the brief first.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { compile } from "../modules.ts";
import { readInstructions } from "../handbook.ts";
import { BUNDLE } from "./bundle.ts";

const product = join(import.meta.dirname, "../..");

/** The Engineer's compiled handbook: the product compiled with the default bundle. */
function compiled() {
  const dir = mkdtempSync(join(tmpdir(), "engineer-scope-"));
  mkdirSync(join(dir, "agents"));
  writeFileSync(join(dir, "instance.yaml"), YAML.stringify({
    product: "0".repeat(40),
    modules: [...BUNDLE],
    settings: { timezone: "Europe/London", owner_name: "Sam", owner_email: "me@example.com", product_repo: "acme/aidenhq" },
  }));
  const r = compile(product, dir);
  return readInstructions(r.paperclip, r.paperclip.agents.engineer, { repo: product, instanceDir: dir });
}

test("the Engineer's handbook keeps a publish to the brief's scope", () => {
  const text = compiled().replace(/\s+/g, " ");
  assert.match(text, /Change only what the brief asks/);
  assert.match(text, /the diff carries the change the task names/);
  assert.match(text, /An access rule, a config change or an unrelated file comes in only when the brief asks for it by name/);
  assert.match(text, /say so on the task and let its delegator widen the brief first/);
});
