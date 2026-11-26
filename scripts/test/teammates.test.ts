// Teammates (docs/configuration.md "teammate"): the block through compile into the compiled agent, the faces folder and the
// catalog (modules that are off included), and every refusal that keeps a name addressable and a shipped face safe to serve.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { compile } from "../modules.ts";

const mods = join(dirname(fileURLToPath(import.meta.url)), "fixtures/mods");
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><defs><linearGradient id="g"/></defs><circle cx="5" cy="5" r="4" fill="url(#g)"/><use href="#g"/></svg>';
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]);
const KIT = { hair: "bun", accessory: "none", body: "badge", skin: 5, hair_color: 5, palette: 5 };

type Agent = { name: string; teammate?: unknown; department?: string; files?: Record<string, string | Buffer> };
/** A product module `name` with these agents (frontmatter `teammate:`), listed in the fixture marketplace. */
function module(dir: string, name: string, agents: Record<string, Agent>) {
  const root = join(dir, "modules", name);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "module.yaml"), YAML.stringify({ name, description: `${name} module`, agents: Object.fromEntries(Object.entries(agents).map(([k, a]) => [k, { connections: { tasks: ["t"] }, ...(a.department ? { department: a.department } : {}) }])) }));
  for (const [k, a] of Object.entries(agents)) {
    mkdirSync(join(root, "agents", k), { recursive: true });
    const meta = { name: a.name, description: `${a.name} does things.`, title: a.name, reportsTo: "boss", ...(a.teammate !== undefined ? { teammate: a.teammate } : {}) };
    writeFileSync(join(root, "agents", k, "AGENTS.md"), `---\n${YAML.stringify(meta)}---\n\n${a.name} handbook\n`);
    for (const [f, body] of Object.entries(a.files ?? {})) writeFileSync(join(root, "agents", k, f), body);
  }
  const file = join(dir, "modules", "marketplace.json");
  const m = JSON.parse(readFileSync(file, "utf8"));
  m.plugins.push({ name, source: `./${name}` });
  writeFileSync(file, JSON.stringify(m));
}

/**
 * The fixture product plus `tm` (Hal, a teammate with a shipped face, and Pal, hidden staff), `tmoff` (off: Ida, with a PNG face,
 * a department and a rank) and `tmbad` (off, a broken block); an instance listing `tm`, with one local teammate (Bud, a kit face).
 */
function setup({ hal = {}, pal = {}, files = {}, overrides = {}, bud = {}, link = false }: { hal?: object; pal?: object; files?: Record<string, string | Buffer>; overrides?: object; bud?: object; link?: boolean } = {}) {
  const product = mkdtempSync(join(tmpdir(), "tm-product-"));
  cpSync(mods, product, { recursive: true });
  module(product, "tm", {
    hal: { name: "Hal", teammate: { job: "Helper", sample: "Filed 3 things: 2 are yours.", staff: ["pal", "ghost?"], face: "face.svg", ...hal }, files: { "face.svg": SVG, ...files } },
    pal: { name: "Pal", ...pal },
  });
  if (link) { writeFileSync(join(product, "outside.svg"), SVG); rmSync(join(product, "modules/tm/agents/hal/face.svg")); symlinkSync(join(product, "outside.svg"), join(product, "modules/tm/agents/hal/face.svg")); }
  module(product, "tmoff", { ida: { name: "Ida", department: "engineering", teammate: { job: "Idler", sample: "Nothing yet.", face: "face.png", first: 3 }, files: { "face.png": PNG } } });
  module(product, "tmbad", { bad: { name: "Bad", teammate: { job: "Broken", nonsense: true } } });
  const inst = mkdtempSync(join(tmpdir(), "tm-inst-"));
  writeFileSync(join(inst, "instance.yaml"), YAML.stringify({ product: "0".repeat(40), modules: ["core", "tm"], settings: { timezone: "Europe/London", owner_name: "Sam", owner_email: "me@example.com" }, overrides }));
  mkdirSync(join(inst, "modules", "mine", "agents", "bud"), { recursive: true });
  writeFileSync(join(inst, "modules", "mine", "module.yaml"), YAML.stringify({ name: "mine", description: "Mine", agents: { bud: { name: "Bud", description: "Bud does my things.", model: "m1", teammate: { job: "My helper", sample: "Done.", face: KIT }, ...bud } } }));
  writeFileSync(join(inst, "modules", "mine", "agents", "bud", "AGENTS.md"), "Bud handbook\n");
  return { product, inst };
}
const run = (o = {}) => { const { product, inst } = setup(o); return compile(product, inst); };

test("a teammate's block compiles into the agent, its face into the faces folder, and every module's teammates into the catalog", () => {
  const r = run({ overrides: { agents: { hal: { name: "Nova" } } } });
  assert.deepEqual(r.paperclip.agents.hal.teammate, { job: "Helper", sample: "Filed 3 things: 2 are yours.", staff: ["pal"], controls: ["tm"], face: "hal.svg" });
  assert.equal(r.paperclip.agents.pal.teammate, undefined);
  assert.deepEqual(r.paperclip.agents.bud.teammate.face, KIT);
  assert.equal(readFileSync(r.faces["hal.svg"], "utf8"), SVG);
  const cat = (m: string) => r.catalog.find((c: { name: string }) => c.name === m).teammates;
  assert.deepEqual(cat("tm"), [{ key: "hal", name: "Nova", job: "Helper", sample: "Filed 3 things: 2 are yours.", description: "Hal does things.", department: "general", face: "hal.svg", first: null }]);
  assert.deepEqual(cat("tmoff"), [{ key: "ida", name: "Ida", job: "Idler", sample: "Nothing yet.", description: "Ida does things.", department: "engineering", face: "ida.png", first: 3 }]);
  assert.ok(r.faces["ida.png"], "a module that is off still ships its face");
  assert.deepEqual(cat("tmbad"), []);
  assert.ok(r.warnings.some((w: string) => /module tmbad: agent bad: its teammate is left out/.test(w)), r.warnings.join("\n"));
});

test("compile refuses a name that isn't addressable, a rename of a hidden agent, bad staff and controls, and an unsafe or malformed face", () => {
  const refuses = (o: object, re: RegExp) => assert.throws(() => run(o), re, String(re));
  refuses({ bud: { name: "HAL" } }, /name "HAL": HAL is already an agent's name/);
  refuses({ bud: { name: "Budster" }, overrides: { agents: { hal: { name: "bud" } } } }, /agent hal: name "bud": bud is an agent's key/);
  refuses({ overrides: { agents: { hal: { name: "Pal" } } } }, /Pal is already an agent's name/);
  refuses({ overrides: { agents: { hal: { name: "N".repeat(25) } } } }, /a name is 1 to 24 letters/);
  refuses({ overrides: { agents: { hal: { name: "Maya  Lee" } } } }, /a name is 1 to 24 letters/);
  refuses({ bud: { teammate: { job: "J", sample: "S", face: "bud.svg" } } }, /a local agent's teammate\.face is a kit spec/);
  refuses({ overrides: { agents: { pal: { name: "Nova" } } } }, /override agents\.pal\.name: only a teammate is renamed/);
  refuses({ hal: { staff: ["bud"] } }, /teammate\.staff names bud, a teammate/);
  refuses({ hal: { staff: ["ghost"] } }, /teammate\.staff names ghost, which is not an enabled agent/);
  refuses({ hal: { controls: ["tmoff"] } }, /teammate\.controls names tmoff, which is not an enabled module/);
  refuses({ hal: { face: "../x.svg" } }, /teammate\.face: a file name/);
  refuses({ link: true }, /face face\.svg is outside the agent's folder/);
  refuses({ files: { "face.svg": `<svg>${" ".repeat(201 * 1024)}</svg>` } }, /face face\.svg is over 200 KB/);
  refuses({ files: { "face.svg": "<svg><script>alert(1)</script></svg>" } }, /face face\.svg contains <script/);
  refuses({ files: { "face.svg": '<svg onload="alert(1)"/>' } }, /face face\.svg contains an on…= handler/);
  refuses({ files: { "face.svg": '<svg><image href="https://example.com/x.png"/></svg>' } }, /an href not starting #/);
  refuses({ bud: { teammate: { job: "J", sample: "S", face: { ...KIT, accessory: "monocle" } } } }, /face accessory is one of/);
  refuses({ bud: { teammate: { job: "J", sample: "S", face: { ...KIT, wings: true } } } }, /a face spec has no wings/);
  refuses({ bud: { teammate: { job: "J", sample: "S", face: { ...KIT, skin: 12 } } } }, /face skin is a whole number from 0 to 9/);
});
