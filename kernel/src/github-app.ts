// The github module's advanced part: this instance's GitHub App ("AidenHQ <instance_name>", owned by the agents org, public so
// other orgs install it on selected repos), made through GitHub's manifest flow from the kernel's admin pages (admin.ts
// /setup/github-app): a signed-in admin names the org, GitHub hands back a one-time code, and the kernel converts it and
// writes the App's id and key into the vault (github-app/{app_id,key.pem}, 0600) and the agents org into the host's .env
// (AIDENHQ_GITHUB_AGENTS_ORG). The key goes from GitHub to the vault and nowhere else: never the board, never github-mcp.
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** An org or user login GitHub accepts. */
export const ORG = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;

/** The App's manifest: what the fleet's code host needs (repository creation, contents, PRs, workflows, Actions re-runs, statuses, org runners). */
export function manifest(org: string, name: string, redirect: string) {
  return {
    name,
    url: `https://github.com/${org}`,
    hook_attributes: { url: "https://example.invalid", active: false },
    redirect_url: redirect,
    public: true, // other orgs (e.g. your company's) install it on selected repos; it acts only where installed
    default_permissions: { repository_creation: "write", contents: "write", pull_requests: "write", workflows: "write", actions: "write", metadata: "read", checks: "read", statuses: "write", issues: "read", organization_projects: "read", organization_self_hosted_runners: "write" },
    default_events: [],
  };
}

export type MadeApp = { id: number; slug: string; pem: string; owner: string };

/** GitHub's one-time code as the App it made; only an App owned by `org` is accepted. */
export async function convert(code: string, org: string, fetchImpl: typeof fetch = fetch): Promise<MadeApp> {
  if (!/^[\w-]{1,200}$/.test(code)) throw new Error("GitHub sent no code");
  const r = await fetchImpl(`https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`, {
    method: "POST", headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" }, signal: AbortSignal.timeout(15_000),
  });
  const app = (await r.json().catch(() => ({}))) as { id?: number; slug?: string; pem?: string; owner?: { login?: string }; message?: string };
  if (r.status !== 201) throw new Error(`GitHub said ${r.status} ${String(app.message ?? "").slice(0, 200)}`);
  const owner = String(app.owner?.login ?? "");
  if (owner.toLowerCase() !== org.toLowerCase()) throw new Error(`the App is owned by ${owner}, not ${org}: nothing saved`);
  if (typeof app.id !== "number" || !app.slug || !app.pem?.includes("PRIVATE KEY")) throw new Error("GitHub's answer had no App key");
  return { id: app.id, slug: app.slug, pem: app.pem, owner };
}

/** Writes the App into the vault and records the agents org on the host, once (a later App never moves the org). */
export function saveApp(app: MadeApp, { secretsDir, envFile }: { secretsDir: string; envFile: string }) {
  const dir = join(secretsDir, "github-app");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const [name, value] of [["key.pem", app.pem], ["app_id", `${app.id}\n`]] as const) {
    const tmp = join(dir, `.${name}.${process.pid}.tmp`);
    writeFileSync(tmp, value, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, join(dir, name));
  }
  const env = existsSync(envFile) ? readFileSync(envFile, "utf8") : "";
  if (!/^AIDENHQ_GITHUB_AGENTS_ORG=/m.test(env)) appendFileSync(envFile, `${env && !env.endsWith("\n") ? "\n" : ""}AIDENHQ_GITHUB_AGENTS_ORG=${app.owner}\n`);
}
