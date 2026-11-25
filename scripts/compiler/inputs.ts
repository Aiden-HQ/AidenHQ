// The compiler's host inputs, read once and only read: the product's .env (with the process's own environment over it), the
// product revision, the bundle this host last compiled (data/bundle-state.json) and the previous product's bundle, the front
// door's URLs and the retired GitHub App's id. scripts/compile.ts compiles with them, and the kernel compiles an agent's
// prospective instance tree with exactly the same ones (settings-change.ts), so both see the same modules and agents.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Obj } from "../modules.ts";

/** The product checkout's .env, under the process's environment: env(k). */
export function hostEnv(repo: string): (k: string) => string | undefined {
  const dotenv: Record<string, string> = {};
  if (existsSync(join(repo, ".env"))) {
    for (const line of readFileSync(join(repo, ".env"), "utf8").split("\n")) {
      const m = /^\s*([A-Z0-9_]+)=(.*)$/.exec(line);
      if (m) dotenv[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
    }
  }
  return (k) => process.env[k] ?? dotenv[k];
}

/** compile()'s options as this host gives them (no file is written). */
export function loadInputs(repo: string, env = hostEnv(repo)) {
  let revision: string | undefined;
  try { revision = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch {}
  // The bundle this host last compiled and what it added from it (modules.ts); the first compile after an upgrade learns the
  // previous product's bundle from the apply (AIDENHQ_OLD_BUNDLE, a JSON list).
  let bundleState: Obj | undefined; try { bundleState = JSON.parse(readFileSync(join(repo, "data", "bundle-state.json"), "utf8")); } catch {}
  let oldBundle: Obj | undefined; try { oldBundle = JSON.parse(env("AIDENHQ_OLD_BUNDLE") || "null") ?? undefined; } catch {}
  return { revision, bundleState, oldBundle, door: { publicIp: env("AIDENHQ_PUBLIC_IP"), adminUrl: env("AIDENHQ_ADMIN_URL"), boardUrl: env("BOARD_LAN_URL") } };
}
