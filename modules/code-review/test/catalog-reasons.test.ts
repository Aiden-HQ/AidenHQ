// The option catalog's words and why an option can't run on a repo (service/src/catalog.ts): what the repo review form lists last, greyed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadCatalog, whyNot } from "../service/src/catalog.ts";

const catalog = loadCatalog(readFileSync(new URL("../service/src/catalog.json", import.meta.url), "utf8"));
const opt = (id: string) => catalog.find((o) => o.id === id)!;

test("every option has a proper name and a description, and an option tied to a stack says what it needs", () => {
  assert.equal(opt("sec.tob-audit").name, "Trail of Bits security audit");
  assert.ok(catalog.every((o) => !/^[a-z]+\.[a-z0-9-]+$/.test(o.name)));
});

test("whyNot: a missing stack, a pull-request-only option, an unavailable engine; undefined when it can run", () => {
  assert.equal(whyNot(opt("sec.govulncheck"), ["main.go"], "one_off"), "Needs Go (go.mod)");
  assert.equal(whyNot(opt("sec.govulncheck"), ["go.mod"], "one_off"), undefined);
  assert.equal(whyNot(opt("cor.codegenie"), ["go.mod"], "one_off"), "Runs on pull requests only");
  assert.match(whyNot(opt("sec.codex-security"), [], "one_off")!, /Codex Security engine/);
  assert.equal(whyNot(opt("sec.tob-audit"), [], "one_off"), undefined);
});
