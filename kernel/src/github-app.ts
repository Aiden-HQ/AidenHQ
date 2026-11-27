// The instance's optional GitHub App (docs/design/github-identity.md), made through GitHub's manifest flow from the kernel's admin
// pages (admin.ts /setup/github-app): a signed-in owner picks the account or org that owns it, GitHub hands back a one-time code,
// and the kernel converts it and writes the App's id and key into the github module's own vault dir
// (`modules/github/github-app/{app_id,key.pem}`, 0600), which the github process reads at /state. Who the App is (its slug, its
// bot) is read from GitHub, never stored. The key goes from GitHub to the vault and nowhere else: never the board, never a chat.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** An org or user login GitHub accepts. */
export const ORG = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;

/**
 * The App's manifest: public (any org may install it on its repos), no webhook. Every GitHub write goes as the App wherever its
 * installation has accepted the permissions the write needs (github-mcp client.ts OPS), so it asks for the writes the fleet makes:
 * contents and workflows (pushes, signed commits, merges, releases), pull requests, issues (comments, labels, assignees), commit
 * statuses, actions (re-runs, dispatch), and organization projects; checks and metadata to read. Never administration or
 * self-hosted runners: repo creation and runner registration stay the owner's. An install made before a permission was asked
 * keeps its old set until its owner accepts the new one on GitHub; until then the ops that need it go as the owner there.
 */
export function manifest(name: string, redirect: string) {
  return {
    name,
    url: "https://aidenhq.ai",
    hook_attributes: { url: "https://example.invalid", active: false },
    redirect_url: redirect,
    public: true,
    default_permissions: { contents: "write", workflows: "write", pull_requests: "write", issues: "write", statuses: "write", actions: "write", checks: "read", metadata: "read", organization_projects: "write" },
    default_events: [],
  };
}

export type MadeApp = { id: number; slug: string; pem: string; owner: string };

/** GitHub's one-time code as the App it made. */
export async function convert(code: string, fetchImpl: typeof fetch = fetch): Promise<MadeApp> {
  if (!/^[\w-]{1,200}$/.test(code)) throw new Error("GitHub sent no code");
  const r = await fetchImpl(`https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`, {
    method: "POST", headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" }, signal: AbortSignal.timeout(15_000),
  });
  const app = (await r.json().catch(() => ({}))) as { id?: number; slug?: string; pem?: string; owner?: { login?: string }; message?: string };
  if (r.status !== 201) throw new Error(`GitHub said ${r.status} ${String(app.message ?? "").slice(0, 200)}`);
  if (typeof app.id !== "number" || !app.slug || !app.pem?.includes("PRIVATE KEY")) throw new Error("GitHub's answer had no App key");
  return { id: app.id, slug: app.slug, pem: app.pem, owner: String(app.owner?.login ?? "") };
}

/** Writes the App's id and key into `dir` (the github module's vault dir), each file in place (a container sees an in-place write), 0600. */
export function saveApp(app: MadeApp, dir: string) {
  const to = join(dir, "github-app");
  mkdirSync(to, { recursive: true, mode: 0o700 });
  writeFileSync(join(to, "key.pem"), app.pem, { mode: 0o600 });
  writeFileSync(join(to, "app_id"), `${app.id}\n`, { mode: 0o600 });
}

/** Removes the App from `dir`: every write goes as the owner from the next one. (The App itself stays on GitHub.) */
export function removeApp(dir: string) {
  rmSync(join(dir, "github-app"), { recursive: true, force: true });
}
