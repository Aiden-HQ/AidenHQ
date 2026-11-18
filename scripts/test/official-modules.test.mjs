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
  const settings = { timezone: "Europe/London", owner_name: "Sam", owner_email: "me@example.com" };
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
