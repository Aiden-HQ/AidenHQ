#!/usr/bin/env node
// kernel/sdk's prepack: Node won't strip types under node_modules, so `bun pm pack` ships JavaScript. Writes kernel/sdk/dist/:
// src/ and bin/ compiled by tsc (`.ts` imports renamed `.js`), with declarations beside them so modules typecheck against
// it. Needs kernel/sdk's dev dependencies (`bun install` there). The third-party twin installs the local tarball
// (fixtures/twin). Published by .github/workflows/sdk-publish.yml on an `sdk-v*` tag.
import { execFileSync } from "node:child_process";
import { chmodSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const sdk = fileURLToPath(new URL("../kernel/sdk/", import.meta.url));
const dist = join(sdk, "dist");
rmSync(dist, { recursive: true, force: true });
execFileSync(join(sdk, "node_modules/.bin/tsc"), ["-p", "tsconfig.json", "--noEmit", "false", "--declaration", "--rootDir", ".", "--outDir", "dist"], { cwd: sdk, stdio: "inherit" });
// tsc renames `.ts` imports in the JavaScript only.
for (const f of (readdirSync(dist, { recursive: true }) as string[]).filter((f) => f.endsWith(".d.ts")))
  writeFileSync(join(dist, f), readFileSync(join(dist, f), "utf8").replace(/(from\s+["']\.{1,2}\/[^"']+)\.ts(["'])/g, "$1.js$2"));
for (const f of readdirSync(join(dist, "bin")).filter((f) => f.endsWith(".js"))) chmodSync(join(dist, "bin", f), 0o755);
