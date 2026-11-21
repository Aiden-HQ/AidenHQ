// The option catalog: the file loads, every entry is pinned and licensed, and a repo's paths pick the options that fit.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { detect, loadCatalog, toolSpec } from "../recipe/catalog.ts";

const text = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../catalog.json"), "utf8");
const catalog = loadCatalog(text);

test("catalog loads; ids unique; recommended within modes; every entry has a version and a licence", () => {
  assert.equal(new Set(catalog.map((o) => o.id)).size, catalog.length);
  for (const o of catalog) {
    assert.ok(o.recommended.every((m) => o.modes.includes(m)), o.id);
    assert.ok(o.source.repo && o.source.version && o.source.licence, o.id);
  }
  const o = JSON.parse(text)[0];
  assert.throws(() => loadCatalog(JSON.stringify([o, o])), /duplicate id/);
  assert.throws(() => loadCatalog(JSON.stringify([{ ...o, recommended: ["continuous"], modes: ["one_off"] }])), /recommended/);
  assert.throws(() => loadCatalog(JSON.stringify([{ ...o, source: { repo: "x/y", licence: "MIT" } }])), /pinned version/);
});

test("detect: package.json + go.mod -> knip and govulncheck, not vulture; recommended per mode", () => {
  const { available, recommended } = detect(["package.json", "go.mod", "src/a.ts"], catalog, "one_off");
  const ids = available.map((o) => o.id);
  assert.ok(ids.includes("maint.knip") && ids.includes("sec.govulncheck") && ids.includes("cor.oxlint"));
  assert.ok(!ids.includes("maint.vulture") && !ids.includes("cor.actionlint"));
  assert.ok(recommended.includes("sec.govulncheck") && recommended.includes("maint.knip") && !recommended.includes("sec.deepsec"));
  assert.ok(detect(["x.py"], catalog, "one_off").available.some((o) => o.id === "maint.vulture"));
  // continuous: only options that run on a change
  assert.ok(!detect(["package.json"], catalog, "continuous").available.some((o) => o.id === "maint.scc"));
});

test("hidden options are never offered", () => {
  assert.ok(catalog.some((o) => o.id === "sec.codex-security" && o.hidden));
  for (const mode of ["one_off", "continuous"] as const) assert.ok(!detect(["package.json", "go.mod", "a.sol", "a.py"], catalog, mode).available.some((o) => o.hidden));
});

test("toolSpec carries only the tool entries' run fields", () => {
  const spec = toolSpec(catalog);
  assert.ok(spec["sec.gitleaks"].cmd.startsWith("gitleaks ") && spec["maint.ruff-unused"].severity === "nit");
  assert.equal(spec["sec.deepsec"], undefined);
  assert.ok(JSON.stringify(spec).length < 16_000, "fits a json spec field");
});
