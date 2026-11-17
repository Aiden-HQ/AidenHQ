// docs/modules.md documents every module.yaml key the loader knows, and no other (CLAUDE.md: a contract change updates the guide).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MANIFEST_KEYS } from "../../kernel/src/loader/authority.ts";

const doc = readFileSync(new URL("../../docs/modules.md", import.meta.url), "utf8");
// Each key is the first cell of a table row: | `key` | or | `a`, `b` |.
const documented = new Set([...doc.matchAll(/^\| ((?:`[a-z_]+`(?:, )?)+) \|/gm)].flatMap((m) => [...m[1].matchAll(/`([a-z_]+)`/g)].map((k) => k[1])));

test("docs/modules.md has a row for every manifest key, and none the loader doesn't know", () => {
  assert.deepEqual([...MANIFEST_KEYS].filter((k) => !documented.has(k)), [], "keys missing from docs/modules.md");
  const known = new Set([...MANIFEST_KEYS]);
  const rowsInKeyTables = doc.split("## module.yaml, key by key")[1].split("\n## ")[0];
  const extra = [...rowsInKeyTables.matchAll(/^\| ((?:`[a-z_]+`(?:, )?)+) \|/gm)].flatMap((m) => [...m[1].matchAll(/`([a-z_]+)`/g)].map((k) => k[1])).filter((k) => !known.has(k));
  assert.deepEqual(extra, [], "docs/modules.md documents keys the loader refuses");
});
