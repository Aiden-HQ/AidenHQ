#!/usr/bin/env node
// One-off: create this instance's GitHub App ("AidenHQ <instance_name>", owned by the agents org, public so other
// orgs can install it on selected repos) through GitHub's manifest flow, and save its id and private key into the vault
// (<secrets>/github-app/{app_id,key.pem}, 0600). Run on the VM, open the printed URL on your LAN, approve on GitHub, then
// install the App on the agents org (link shown at the end) and restart the code host (docker compose restart
// codehost-github). The key is never printed.
//   node ops/github-app-setup.mjs [owner-org]     (default: the agents org, aidenhq-<instance_name> or github_agents_org)
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dotenv = existsSync(join(root, ".env")) ? Object.fromEntries(readFileSync(join(root, ".env"), "utf8").split("\n").map((l) => /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(l)).filter(Boolean).map((m) => [m[1], m[2].replace(/^["']|["']$/g, "")])) : {};
const env = { ...dotenv, ...process.env };
const expand = (p) => (p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);

// The agents org: AIDENHQ_GITHUB_AGENTS_ORG, else the instance's github_agents_org, else aidenhq-<instance_name>.
const instYaml = env.AIDENHQ_INSTANCE_DIR && join(expand(env.AIDENHQ_INSTANCE_DIR), "instance.yaml");
const setting = (k) => (instYaml && existsSync(instYaml) ? new RegExp(`^\\s+${k}:\\s*["']?([A-Za-z0-9_.-]+)`, "m").exec(readFileSync(instYaml, "utf8"))?.[1] : undefined);
const instanceName = setting("instance_name") ?? env.AIDENHQ_INSTANCE_NAME;
const org = process.argv[2] || env.AIDENHQ_GITHUB_AGENTS_ORG || setting("github_agents_org") || (instanceName ? `aidenhq-${instanceName}` : "");
if (!org) {
  console.error("No agents org: set github_agents_org under settings: in instance.yaml (or GITHUB_AGENTS_ORG in person.env before setup), or pass the org: node ops/github-app-setup.mjs <org>. The org must already exist on GitHub and be owned by you.");
  process.exit(1);
}

const host = env.AIDENHQ_SETUP_HOST;
if (!host) {
  console.error("Set AIDENHQ_SETUP_HOST to this host's address on your LAN or tailnet (where your browser can reach port 8765).");
  process.exit(1);
}
const port = 8765;
// A one-time secret path (printed below): anything else on the LAN gets a 404.
const secret = randomBytes(16).toString("hex");
const base = `http://${host}:${port}/${secret}`;
const state = randomBytes(16).toString("hex");
const out = join(expand(env.AIDENHQ_SECRETS_DIR ?? "~/.config/aidenhq"), "github-app");
const manifest = {
  name: `AidenHQ ${instanceName ?? org}`,
  url: `https://github.com/${org}`,
  hook_attributes: { url: "https://example.invalid", active: false },
  redirect_url: `${base}/callback`,
  public: true, // other orgs (e.g. your company's) install it on selected repos; it acts only where installed
  default_permissions: { repository_creation: "write", contents: "write", pull_requests: "write", workflows: "write", actions: "write", metadata: "read", checks: "read", statuses: "write", issues: "read", organization_projects: "read", organization_self_hosted_runners: "write" },
  default_events: [],
};
const esc = (s) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const page = (body) => `<!doctype html><meta charset="utf-8"><title>AidenHQ GitHub App</title><body style="font:16px system-ui;max-width:640px;margin:40px auto">${body}</body>`;

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${host}:${port}`);
  const send = (status, body) => res.writeHead(status, { "content-type": "text/html; charset=utf-8" }).end(page(body));
  if (url.pathname === `/${secret}/` || url.pathname === `/${secret}`) {
    return send(200, `<h2>Create the AidenHQ GitHub App for <code>${esc(org)}</code></h2>
<p>Permissions: creating repositories, contents, pull requests, workflows, actions (write: the merge queue re-runs a check that failed for infrastructure reasons) and commit statuses (write; statuses carry the design-review check), org self-hosted runners (write, for CI registration), checks (read). Owned by <code>${esc(org)}</code>.</p>
<form method="post" action="https://github.com/organizations/${encodeURIComponent(org)}/settings/apps/new?state=${state}">
<input type="hidden" name="manifest" value="${esc(JSON.stringify(manifest))}"><button type="submit">Create on GitHub</button></form>`);
  }
  if (url.pathname !== `/${secret}/callback`) return send(404, "Not found");
  if (url.searchParams.get("state") !== state) return send(400, "State mismatch: start again from the first page.");
  try {
    const r = await fetch(`https://api.github.com/app-manifests/${encodeURIComponent(url.searchParams.get("code") ?? "")}/conversions`, {
      method: "POST",
      headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
    });
    const app = await r.json();
    if (r.status !== 201) throw new Error(`GitHub said ${r.status} ${app.message ?? ""}`);
    // Only an App owned by the expected org is saved.
    if (String(app.owner?.login).toLowerCase() !== org.toLowerCase()) throw new Error(`the App is owned by ${app.owner?.login}, not ${org}: nothing saved`);
    mkdirSync(out, { recursive: true, mode: 0o700 });
    writeFileSync(join(out, "key.pem"), app.pem, { mode: 0o600 });
    writeFileSync(join(out, "app_id"), `${app.id}\n`, { mode: 0o600 });
    // The agents org, recorded once beside the App: the kernel's @agents codehost grants resolve from it alone, never from a
    // setting a later change could move (kernel/src/codehost.ts).
    if (!dotenv.AIDENHQ_GITHUB_AGENTS_ORG) appendFileSync(join(root, ".env"), `AIDENHQ_GITHUB_AGENTS_ORG=${org}\n`);
    const install = `https://github.com/apps/${app.slug}/installations/new`;
    console.log(`Saved App ${app.id} (${app.slug}) to ${out}. Now install it: ${install}`);
    send(200, `<h2>Saved</h2><p>App <code>${esc(app.slug)}</code> (id ${app.id}) is in the vault. Last step: <a href="${esc(install)}">install it on ${esc(org)}</a> (All repositories), then restart the code host (<code>docker compose restart codehost-github</code>). Other orgs (e.g. your company's): an owner there opens the same link and picks the repositories the fleet may change.</p>`);
    setTimeout(() => process.exit(0), 2000);
  } catch (err) {
    send(500, `Failed: ${esc(String(err.message))}`);
  }
});
server.listen(port, "0.0.0.0", () => console.log(`Open ${base}/ (creates "${manifest.name}" owned by ${org}; saves to ${out})`));
