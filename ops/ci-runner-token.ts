#!/usr/bin/env node
// Prints a one-hour registration token for a self-hosted Actions runner on an org (modules/ci): the agents org, or the
// org named as the argument (one the App is installed on, with the runners permission accepted). The App's key stays with
// codehost-github: an org-wide token narrowed to organization_self_hosted_runners comes from the kernel's
// POST /v1/codehost/token, asked with the ci module's own token (its `codehost:` grant); the runner container gets only the
// registration token. Used by ops/ci-runner.sh before each job's container.
//   node ops/ci-runner-token.ts [org]
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dotenv = existsSync(join(root, ".env")) ? Object.fromEntries(readFileSync(join(root, ".env"), "utf8").split("\n").map((l) => /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(l)).filter(Boolean).map((m): [string, string] => [m![1]!, m![2]!.replace(/^["']|["']$/g, "")])) : {};
const env = { ...dotenv, ...process.env };
const expand = (p: string) => (p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);

// The agents org, read the way the kernel reads it.
const instYaml = env.AIDENHQ_INSTANCE_DIR && join(expand(env.AIDENHQ_INSTANCE_DIR), "instance.yaml");
const setting = (k: string) => (instYaml && existsSync(instYaml) ? new RegExp(`^\\s+${k}:\\s*["']?([A-Za-z0-9_.-]+)`, "m").exec(readFileSync(instYaml, "utf8"))?.[1] : undefined);
const name = setting("instance_name") ?? env.AIDENHQ_INSTANCE_NAME;
const org = process.argv[2] || env.AIDENHQ_GITHUB_AGENTS_ORG || setting("github_agents_org") || (name ? `aidenhq-${name}` : "");
if (!org) throw new Error("no agents org: set settings.instance_name (or github_agents_org) in instance.yaml");

const key = readFileSync(join(expand(env.AIDENHQ_SECRETS_DIR ?? "~/.config/aidenhq"), "ci_token"), "utf8").trim();
const kernel = (env.AIDENHQ_KERNEL_URL ?? "http://10.231.0.1:3130").replace(/\/$/, "");
const t = await fetch(`${kernel}/v1/codehost/token`, {
  method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
  body: JSON.stringify({ repo: `${org}/*`, perms: { organization_self_hosted_runners: "write" } }), signal: AbortSignal.timeout(30_000),
});
const tb = await t.json().catch(() => ({}));
if (t.status !== 200) throw new Error(`an App token for ${org}: the kernel said ${t.status} ${tb.error?.message ?? tb.error ?? ""}`);
const r = await fetch(`https://api.github.com/orgs/${org}/actions/runners/registration-token`, {
  method: "POST",
  headers: { authorization: `Bearer ${tb.token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
  signal: AbortSignal.timeout(20_000),
});
const body = await r.json().catch(() => ({}));
if (r.status !== 201) throw new Error(`registration token for ${org}: GitHub said ${r.status} ${body.message ?? ""} (does the App have organization_self_hosted_runners: write?)`);
process.stdout.write(`${body.token}\n`);
