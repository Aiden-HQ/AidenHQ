// The directory holding `node`, for tests that run a script under a restricted PATH. Tests run on Bun, so `process.execPath`
// names bun: the scripts under test (shell, ops/*.ts) call `node`, the production runtime.
import { execFileSync } from "node:child_process";
import { dirname } from "node:path";

export const NODE_DIR = dirname(execFileSync("sh", ["-c", "command -v node"], { encoding: "utf8" }).trim());
