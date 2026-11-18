#!/usr/bin/env node
// kernel/sdk's prepack: Node won't strip types under node_modules, so `npm pack` ships JavaScript. Writes kernel/sdk/dist/
// (src/ and bin/ with their types stripped and `.ts` imports renamed `.js`). The third-party twin
// installs the local tarball (fixtures/twin). Published by .github/workflows/sdk-publish.yml on an `sdk-v*` tag.
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const sdk = fileURLToPath(new URL("../kernel/sdk/", import.meta.url));
rmSync(join(sdk, "dist"), { recursive: true, force: true });
for (const dir of ["src", "bin"]) {
  mkdirSync(join(sdk, "dist", dir), { recursive: true });
  for (const f of readdirSync(join(sdk, dir)).filter((f) => f.endsWith(".ts"))) {
    const js = stripTypeScriptTypes(readFileSync(join(sdk, dir, f), "utf8")).replace(/(from\s+["']\.{1,2}\/[^"']+)\.ts(["'])/g, "$1.js$2");
    writeFileSync(join(sdk, "dist", dir, f.replace(/\.ts$/, ".js")), js, { mode: dir === "bin" ? 0o755 : 0o644 });
  }
}
