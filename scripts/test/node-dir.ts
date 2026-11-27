// The directory holding the real `node`, for tests that run a script under a restricted PATH and a replaced HOME. Tests run
// on Bun, so `process.execPath` names bun: the scripts under test (shell, ops/*.ts) call `node`, the production runtime.
// Node reports its own executable, resolved here while the real HOME is still set, so a version-manager shim that needs HOME
// is never what the tests' PATH points at.
import { execFileSync } from "node:child_process";
import { dirname } from "node:path";

export const NODE_DIR = dirname(execFileSync("node", ["-p", "process.execPath"], { encoding: "utf8" }).trim());
