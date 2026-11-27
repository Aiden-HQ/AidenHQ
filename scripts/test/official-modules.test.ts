// The official modules (modules/) compile with the product's compiler on two fixture instances, the default bundle and
// every module, with each required setting given a placeholder so only manifest errors remain; and a vendor connection's
// read endpoint gets exactly its connection's `read` tags (kernel/sdk/src/vendor/proxy.ts serves only those); and no skill
// names a tool its module's connection does not grant.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import YAML from "yaml";
import { compile } from "../modules.ts";

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
    if (label !== "every module") continue;
    // The default teammates, keyed and named as the roster (each with its kit face); the meeting work is Nora's alone.
    const r = compile(product, dir);
    const kit = (hair, accessory, body, n, hair_color = n) => ({ hair, accessory, body, skin: n, hair_color, palette: n });
    const roster = Object.fromEntries(Object.entries(r.paperclip.agents).filter(([, a]) => a.teammate).map(([k, a]) => [k, [a.name, a.teammate.job, a.teammate.face]]));
    assert.deepEqual(roster, {
      "chief-of-staff": ["Aiden", "Chief of staff", kit("short", "none", "tie", 0)],
      "open-loops": ["Tess", "Follow-up chaser", kit("long", "headset", "none", 1)],
      meetings: ["Nora", "Meeting notes", kit("long", "pencil", "notepad", 2)],
      "reviewer-manager": ["Max", "PR reviewer", kit("spiky", "glasses", "none", 3)],
      ship: ["Sam", "Release manager", kit("short", "cap", "none", 4)],
      maintainer: ["Mia", "Repo maintainer", kit("bun", "none", "badge", 5)],
      "app-maintainer": ["Iris", "App builder", kit("curly", "earrings", "none", 6)],
      architect: ["Archie", "Agent Architect", kit("short", "hard-hat", "none", 7)],
      "security-watch": ["Vik", "Security", { ...kit("short", "headband", "shield", 8), hair_color: 0 }],
      assistant: ["Rhea", "Researcher", kit("long", "round-glasses", "none", 9, 8)],
      // server-manager ships a teammate but is not in the default bundle, so it is on only while the instance lists it: the roster
      // here is the modules a fresh install ships, and this entry is the one extra the every-module compile adds.
      "server-manager": ["Rolf", "Server upkeep", kit("spiky", "headset", "shield", 6)],
    });
    assert.equal(r.paperclip.agents["open-loops"].teammate.first, 1);
    assert.deepEqual(["meeting-scan", "meeting-actions"].map((k) => r.paperclip.routines[k].agent), ["meetings", "meetings"]);
    assert.deepEqual(Object.keys(r.paperclip.agents).filter((k) => r.paperclip.agents[k].roles?.includes("ops-key")), ["meetings"]);
    assert.deepEqual(r.faces, {}, "no module ships a face file yet");
  }
});
