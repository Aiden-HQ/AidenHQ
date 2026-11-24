// The host's settings, as every kernel entry point reads them: the process env over the checkout's .env, the vault dir
// (secrets read at use, cached by file signature), and the config and data dirs.
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const dotenv: Record<string, string> = {};
if (existsSync(path.join(repo, ".env"))) {
  for (const line of readFileSync(path.join(repo, ".env"), "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)=(.*)$/.exec(line);
    if (m) dotenv[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
}
export function env(k: string): string | undefined;
export function env(k: string, d: string): string;
export function env(k: string, d?: string) { return process.env[k] ?? dotenv[k] ?? d; }
const secretsDir = env("AIDENHQ_SECRETS_DIR");
if (!secretsDir) throw new Error("AIDENHQ_SECRETS_DIR is not set (.env)");
export const configDir = path.resolve(repo, env("AIDENHQ_CONFIG_DIR", "config"));
export const dataDir = path.resolve(repo, env("AIDENHQ_DATA_DIR", "data"));
// A secret is re-read only when its file's mtime, ctime, size, mode or inode changed (a rotation, or a replacement that keeps the mtime), so
// a per-call lookup costs one stat. A missing or unreadable file is "" and is never cached.
const cached = new Map<string, { sig: string; value: string }>();
export const secret = (n: string) => {
  const file = path.join(secretsDir, n);
  try {
    const st = statSync(file);
    const sig = `${st.mtimeMs}:${st.ctimeMs}:${st.size}:${st.ino}:${st.mode}`;
    const hit = cached.get(n);
    if (hit?.sig === sig) return hit.value;
    const value = readFileSync(file, "utf8").trim();
    cached.set(n, { sig, value });
    return value;
  } catch { cached.delete(n); return ""; }
};
