#!/usr/bin/env node
// The contract kit: `aidenhq-module-test <module dir>` runs the module's engines through engine@1.
import { resolve } from "node:path";
import { engineKit } from "../src/kit.ts";

const dir = resolve(process.argv[2] ?? ".");
await engineKit(dir);
console.log(`${dir}: engine@1 kit passed`);
