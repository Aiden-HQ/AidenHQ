// A URL setting (module.yaml `type: url`, optional `host:` pattern): one check for the board (the owner's feedback as he
// types) and the compiler (the gate: an agent writes the commit). Plain TypeScript Node runs as is (scripts/modules.mjs
// imports this file directly); the board holds a synced copy (scripts/sync-shared.mjs). docs/design/settings-changes.md.

/** Query parameters whose name says they carry a credential: those belong in the vault, never in a setting. */
const SECRET_PARAM = /token|key|secret|sig|password|passwd|auth|code|session|credential/i;
export const URL_MAX = 500;

/** Whether `host` matches `pattern`: exact, or `*.example.com` for any subdomain of example.com (not example.com itself). */
export function hostMatches(host: string, pattern: string): boolean {
  const h = host.toLowerCase();
  const p = pattern.toLowerCase();
  return p.startsWith("*.") ? h.endsWith(p.slice(1)) && h.length > p.length - 1 : h === p;
}

/** Why `value` can't be this setting's URL, or null when it can. An empty value means not set, and is fine. */
export function urlSettingProblem(value: unknown, host?: string): string | null {
  if (value === "" || value == null) return null;
  if (typeof value !== "string") return "a URL is text";
  if (value.length > URL_MAX) return `at most ${URL_MAX} characters`;
  // `$` would be expanded by Docker Compose (the value lands in a compose file): `${SOME_SECRET}` would leave in a request.
  if (/[\s\x00-\x1f\x7f$]/.test(value)) return "no spaces, control characters or $";
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return "not a URL (it starts with https://)";
  }
  if (u.protocol !== "https:") return "https:// only";
  if (u.username || u.password) return "no user name or password in the URL: sign in with Connect instead";
  if (u.hash) return "no #fragment";
  // A trailing dot ("localhost.") names the same host: refuse it rather than let it slip past the checks below.
  if (u.hostname.endsWith(".")) return "a host name without a trailing dot";
  const name = u.hostname.toLowerCase();
  if (!name.includes(".") || /^\[|^[\d.]+$/.test(name) || /(^|\.)(localhost|local|internal|home|lan)$/i.test(name)) return "a public host name (not an IP address or a local name)";
  if (host && !hostMatches(name, host)) return `the host must be ${host.startsWith("*.") ? `a ${host.slice(2)} address (${host})` : host}`;
  const secret = [...u.searchParams.keys()].find((k) => SECRET_PARAM.test(k));
  if (secret) return `no credentials in the URL (the "${secret}" parameter): connections sign in with Connect, and secrets live in the vault`;
  return null;
}
