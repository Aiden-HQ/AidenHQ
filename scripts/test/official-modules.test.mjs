// The official modules (modules/) compile with the product's compiler on two fixture instances, the default bundle and
// every module, with each required setting given a placeholder so only manifest errors remain; and a vendor connection's
// read endpoint gets exactly its connection's `read` tags (kernel/sdk/src/vendor/proxy.ts serves only those).
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import YAML from "yaml";
import { compile } from "../modules.mjs";

const product = join(import.meta.dirname, "../..");
const market = JSON.parse(readFileSync(join(product, "modules/marketplace.json"), "utf8"));
const names = market.plugins.map((p) => p.name);
const defs = Object.fromEntries(names.filter((n) => existsSync(join(product, "modules", n, "module.yaml"))).map((n) => [n, YAML.parse(readFileSync(join(product, "modules", n, "module.yaml"), "utf8"))]));
const tmp = mkdtempSync(join(tmpdir(), "official-modules-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

test("the default bundle and every official module compile", () => {
  const settings = { timezone: "Europe/London", owner_name: "Sam", owner_email: "me@example.com", product_repo: "acme/aidenhq" };
  for (const def of Object.values(defs)) {
    for (const [k, d] of Object.entries(def.settings ?? {})) {
      if (d?.required && !(k in settings)) settings[k] = d.values ? (d.type === "list" ? [d.values[0]] : d.values[0]) : d.type === "url" ? `https://${(d.host ?? "example.com").replace("*", "acme")}` : "example";
    }
  }
  for (const [label, modules] of [["default bundle", market.bundle], ["every module", names]]) {
    const dir = join(tmp, label.replace(/ /g, "-"));
    mkdirSync(join(dir, "agents"), { recursive: true });
    writeFileSync(join(dir, "instance.yaml"), YAML.stringify({ product: "0".repeat(40), modules, settings }));
    assert.doesNotThrow(() => compile(product, dir), label);
  }
});

test("a vendor connection's read endpoint gets exactly its connection's read tags", () => {
  for (const [n, def] of Object.entries(defs)) {
    for (const [svc, s] of Object.entries(def.services?.run ?? {})) {
      const env = s?.env ?? {};
      const conn = Object.entries(def.connections ?? {}).find(([, c]) => new URL(c.url).hostname === svc);
      if (env.READ_TOOLS == null && !(env.MCP_READ_TOKEN_FILE && existsSync(join(product, "modules", n, String(s.build ?? ""), "src/vendor/proxy.ts")))) continue;
      assert.equal(env.READ_TOOLS, (conn?.[1].tools.read ?? []).join(","), `${n}: ${svc}'s READ_TOOLS must be its connection's read tags`);
    }
  }
});

test("a fresh install of the default bundle compiles with no optional connection set, and starts no container for one it can't use", () => {
  const dir = join(tmp, "fresh");
  mkdirSync(join(dir, "agents"), { recursive: true });
  writeFileSync(join(dir, "instance.yaml"), YAML.stringify({ product: "0".repeat(40), modules: market.bundle, settings: { timezone: "Europe/London", owner_name: "Sam", owner_email: "me@example.com", product_repo: "acme/aidenhq", quiet_start: "on", spend_day_usd: 10 } }));
  const { compose, paperclip } = compile(product, dir);
  for (const k of ["meeting-scan", "security-scan", "security-weekly", "red-team-new", "red-team-weekly"]) assert.equal(paperclip.routines[k].status, "paused", `${k} waits for the owner (quiet start)`);
  for (const k of ["ui-designer", "ui-reviewer"]) assert.equal(paperclip.agents[k].heartbeat, false, `${k} has no heartbeat until the owner sets one`);
  assert.equal(compose.services["jira-mcp"], undefined, "jira-mcp waits for the owner's site");
  assert.ok(compose.services["glean-mcp"] && compose.services["primer-mcp"], "the idle connection servers are there");
});

test("an install made before the bundle grew gets the new members once its host sees the old bundle, and keeps them; a removal sticks", () => {
  const settings = { timezone: "Europe/London", owner_name: "Sam", owner_email: "me@example.com", product_repo: "acme/aidenhq" };
  const newer = ["design", "glean", "jira", "meetings", "primer", "security", "slack"];
  const oldBundle = market.bundle.filter((n) => !newer.includes(n));
  const run = (label, extra, opts) => {
    const dir = join(tmp, label);
    mkdirSync(join(dir, "agents"), { recursive: true });
    writeFileSync(join(dir, "instance.yaml"), YAML.stringify({ product: "0".repeat(40), modules: oldBundle, settings, ...extra }));
    return compile(product, dir, opts);
  };
  const first = run("upgraded", {}, { oldBundle });
  assert.ok(first.compose.services["glean-mcp"] && first.compose.services["slack-mcp"] && first.compose.services["security-scanner"], "the new members arrive");
  // The next apply has no old bundle to diff; the host's record keeps them.
  const later = run("upgraded", {}, { bundleState: first.bundleState });
  assert.ok(later.compose.services["glean-mcp"], "still on at the next apply");
  const kept = run("removed", { modules_removed: ["slack", "glean"] }, { oldBundle });
  assert.equal(kept.compose.services["slack-mcp"], undefined);
  assert.equal(kept.compose.services["glean-mcp"], undefined);
  assert.ok(kept.compose.services["security-scanner"]);
  assert.equal(run("first", {}, {}).compose.services["glean-mcp"], undefined, "with no old bundle and no record, nothing extra");
});
