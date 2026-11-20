#!/usr/bin/env node
// Prints a one-hour registration token for a self-hosted Actions runner on an org (modules/ci): the fleet org
// (github_fleet_org in instance.yaml), or the org named as the argument. It comes from the kernel's
// POST /v1/codehost/runner_token, asked with the ci module's own token (its `codehost:` grant) and run as the owner inside
// the github module; the runner container gets only the registration token. Used by ops/ci-runner.sh before each job's container.
//   node ops/ci-runner-token.ts [org]
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dotenv = existsSync(join(root, ".env")) ? Object.fromEntries(readFileSync(join(root, ".env"), "utf8").split("\n").map((l) => /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(l)).filter(Boolean).map((m): [string, string] => [m![1]!, m![2]!.replace(/^["']|["']$/g, "")])) : {};
const env = { ...dotenv, ...process.env };
const expand = (p: string) => (p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);

// The fleet org, read the way the kernel reads it.
const instYaml = env.AIDENHQ_INSTANCE_DIR && join(expand(env.AIDENHQ_INSTANCE_DIR), "instance.yaml");
const setting = (k: string) => (instYaml && existsSync(instYaml) ? new RegExp(`^\\s+${k}:\\s*["']?([A-Za-z0-9_.-]+)`, "m").exec(readFileSync(instYaml, "utf8"))?.[1] : undefined);
const org = process.argv[2] || setting("github_fleet_org") || "";
if (!org) throw new Error("no org: name one, or set settings.github_fleet_org in instance.yaml");

const key = readFileSync(join(expand(env.AIDENHQ_SECRETS_DIR ?? "~/.config/aidenhq"), "ci_token"), "utf8").trim();
const kernel = (env.AIDENHQ_KERNEL_URL ?? "http://10.231.0.1:3130").replace(/\/$/, "");
const r = await fetch(`${kernel}/v1/codehost/runner_token`, {
  method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
  body: JSON.stringify({ org }), signal: AbortSignal.timeout(30_000),
});
const body = await r.json().catch(() => ({}));
if (r.status !== 200 || !body.token) throw new Error(`registration token for ${org}: the kernel said ${r.status} ${body.error?.message ?? body.error ?? ""}`.trim());
process.stdout.write(`${body.token}\n`);
