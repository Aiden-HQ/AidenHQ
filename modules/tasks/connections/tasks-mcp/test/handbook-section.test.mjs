// handbook_section: an agent reads its own on-demand sections (setup's sections/<agent id>.json), never another agent's.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "sections-"));
process.env.AIDENHQ_SECTIONS_DIR = dir;
writeFileSync(join(dir, "me.json"), JSON.stringify({ "engineering.delegating": "\n\n## Handing work to an Engineer\n" }));
writeFileSync(join(dir, "other.json"), JSON.stringify({ "acme.secret": "not yours" }));
const { bridge, parse } = await import("./helpers.mjs");

test("an agent reads its own on-demand section and nothing else", async () => {
  const b = bridge({ handler: (req, res) => res.end(JSON.stringify(req.url === "/api/agents/me" ? { id: "me" } : {})), agents: { me: { key: "chief-of-staff" } } });
  assert.deepEqual(parse(await b.call("handbook_section", { id: "engineering.delegating" })).out, { id: "engineering.delegating", text: "\n\n## Handing work to an Engineer\n" });
  assert.match(parse(await b.call("handbook_section", { id: "acme.secret" })).error, /no on-demand section "acme\.secret" for you; yours: engineering\.delegating/);
});
