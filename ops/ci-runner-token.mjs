#!/usr/bin/env node
// Prints a one-hour registration token for a self-hosted Actions runner on the agents org (modules/ci), minted from the
// instance's GitHub App with an installation token narrowed to organization_self_hosted_runners. The App's key stays
// on the host: the runner container gets only this token. Used by ops/ci-runner.sh before each job's container.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { appClient } from "../services/runner/src/github-app.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dotenv = existsSync(join(root, ".env")) ? Object.fromEntries(readFileSync(join(root, ".env"), "utf8").split("\n").map((l) => /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(l)).filter(Boolean).map((m) => [m[1], m[2].replace(/^["']|["']$/g, "")])) : {};
const env = { ...dotenv, ...process.env };
const expand = (p) => (p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);

// The agents org, read the way ops/github-app-setup.mjs and the runner read it.
const instYaml = env.AIDENHQ_INSTANCE_DIR && join(expand(env.AIDENHQ_INSTANCE_DIR), "instance.yaml");
const setting = (k) => (instYaml && existsSync(instYaml) ? new RegExp(`^\\s+${k}:\\s*["']?([A-Za-z0-9_.-]+)`, "m").exec(readFileSync(instYaml, "utf8"))?.[1] : undefined);
const name = setting("instance_name") ?? env.AIDENHQ_INSTANCE_NAME;
const org = env.AIDENHQ_GITHUB_AGENTS_ORG || setting("github_agents_org") || (name ? `aidenhq-${name}` : "");
if (!org) throw new Error("no agents org: set settings.instance_name (or github_agents_org) in instance.yaml");

const dir = join(expand(env.AIDENHQ_SECRETS_DIR ?? "~/.config/aidenhq"), "github-app");
const app = appClient({ appId: readFileSync(join(dir, "app_id"), "utf8").trim(), key: readFileSync(join(dir, "key.pem"), "utf8") });
const token = await app.token(org, { permissions: { organization_self_hosted_runners: "write" } });
const r = await fetch(`https://api.github.com/orgs/${org}/actions/runners/registration-token`, {
  method: "POST",
  headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
  signal: AbortSignal.timeout(20_000),
});
const body = await r.json().catch(() => ({}));
if (r.status !== 201) throw new Error(`registration token for ${org}: GitHub said ${r.status} ${body.message ?? ""} (does the App have organization_self_hosted_runners: write?)`);
process.stdout.write(`${body.token}\n`);
