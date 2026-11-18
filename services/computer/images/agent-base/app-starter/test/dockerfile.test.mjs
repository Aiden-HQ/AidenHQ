// The runtime image copies only what it lists, so a module server.mjs imports but the Dockerfile does not copy crashes
// every app on start (ERR_MODULE_NOT_FOUND). Every relative import, followed transitively, must be a COPY source.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const dockerfile = readFileSync(join(root, "Dockerfile"), "utf8");
const runtime = dockerfile.slice(dockerfile.lastIndexOf("\nFROM "));
const copied = new Set(
  [...runtime.matchAll(/^COPY --from=build (.+) \.\/?\S*$/gm)].flatMap((m) => m[1].trim().split(/\s+/).map((p) => p.replace(/^\/app\//, ""))),
);

test("the runtime image copies every module server.mjs imports", () => {
  const seen = new Set(), todo = ["server.mjs"];
  while (todo.length) {
    const file = todo.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    assert.ok(copied.has(file), `${file} is imported at runtime but the runtime stage does not COPY it`);
    const src = readFileSync(join(root, file), "utf8");
    for (const m of src.matchAll(/(?:from\s+|import\s*\(?\s*)["'](\.{1,2}\/[^"']+)["']/g)) todo.push(join(dirname(file), m[1]));
  }
});
