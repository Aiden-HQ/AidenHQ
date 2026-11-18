// `database: warehouse`: each deploy makes sure the app has its own login on the shared warehouse. Role and schema are
// app_<name> (the role owns only its schema; no other grants), and the connection URL is the app's DATABASE_URL secret in
// the vault (plus any declared *_DATABASE_URL), mounted by the usual secrets mechanism. The password is generated once and
// never rotated: a stored URL is reused; a new one is only made when the URL file is missing (first deploy, or lost).
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { PREVIEW_NAME, type App } from "./registry.js";

// The warehouse module app's postgres container (compose project app-warehouse), on the apps_warehouse network.
export const WAREHOUSE = { container: "app-warehouse-postgres-1", port: 5432, db: "warehouse" };

/** Registry names are [a-z][a-z0-9-]: one plain postgres identifier. */
export const dbName = (app: string): string => {
  const n = `app_${app.replace(/-/g, "_")}`;
  if (!/^app_[a-z][a-z0-9_]{0,58}$/.test(n)) throw new Error(`bad app name for a database: ${app}`);
  return n;
};

export interface DbDeps {
  secretsDir: string; // the vault's apps/ dir (read-write here)
  sql: (script: string) => Promise<void>; // runs as the warehouse superuser; must fail on any error
}

/** Writes a secret file the vault way (one value, no newline, 0644), atomically, only under <secretsDir>/<app>/. */
export function put(dir: string, key: string, value: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o755 });
  const tmp = `${dir}/.${key}.tmp`;
  writeFileSync(tmp, value, { mode: 0o644 });
  renameSync(tmp, `${dir}/${key}`);
}

export async function provisionDatabase(app: App, d: DbDeps): Promise<void> {
  const role = dbName(app.name);
  const dir = `${d.secretsDir}/${app.name}`;
  const file = `${dir}/DATABASE_URL`;
  const fresh = !existsSync(file);
  const pw = fresh ? randomBytes(24).toString("hex") : (() => {
    try {
      return decodeURIComponent(new URL(readFileSync(file, "utf8").trim()).password);
    } catch {
      return "";
    }
  })();
  if (!/^[0-9a-f]{48}$/.test(pw)) throw new Error(`apps/${app.name}/DATABASE_URL in the vault isn't a URL this platform wrote; delete it to get a new login`);
  // A fresh password also resets an existing role's (the earlier file was lost or never written).
  const sql = `DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${role}') THEN CREATE ROLE ${role} LOGIN PASSWORD '${pw}';${fresh ? `\n  ELSE ALTER ROLE ${role} PASSWORD '${pw}';` : ""}
  END IF;
END $$;
CREATE SCHEMA IF NOT EXISTS ${role} AUTHORIZATION ${role};
REVOKE ALL ON SCHEMA ${role} FROM PUBLIC;
GRANT CONNECT ON DATABASE ${WAREHOUSE.db} TO ${role};
ALTER ROLE ${role} SET search_path = ${role};
`;
  await d.sql(sql).catch((e) => {
    throw new Error(`warehouse login for ${app.name}: ${String((e as Error).message).replaceAll(pw, "***")}`);
  });
  const url = `postgres://${role}:${pw}@${WAREHOUSE.container}:${WAREHOUSE.port}/${WAREHOUSE.db}`;
  // Aliases the app asked for (e.g. ROADMAP_DATABASE_URL): written when missing, rewritten with a fresh password.
  for (const k of app.secrets.filter((k) => k !== "DATABASE_URL" && k.endsWith("DATABASE_URL"))) if (fresh || !existsSync(`${dir}/${k}`)) put(dir, k, url);
  if (fresh) put(dir, "DATABASE_URL", url); // last: its presence means everything above happened
}

/**
 * A preview's login and everything it owns (its schema) are dropped when the preview goes (previews.ts). Only a preview's:
 * the registry reserves the -pr-<n> names, so this can never reach an app's live schema.
 */
export function dropPreviewDatabase(app: string): string {
  if (!PREVIEW_NAME.test(app)) throw new Error(`${app} is not a preview`);
  const role = dbName(app);
  return `DO $$ BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = '${role}') THEN
    EXECUTE 'DROP OWNED BY ${role} CASCADE';
    EXECUTE 'DROP ROLE ${role}';
  END IF;
END $$;
`;
}
