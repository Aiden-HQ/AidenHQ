// Tailnet exposure on the apps' own Tailscale node (the apps-edge sidecar in compose.yaml), never the host's: a browser
// sends a host's cookies to every port of it, so apps on the board's hostname could read the board's session.
// apps-mcp writes the node's whole serve config (TS_SERVE_CONFIG, re-read by containerboot when it changes) from the
// registry: https://<apps node>:<port> → edge-<app> (the app's publishing service) on the app's own network, which the
// sidecar joins.
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { edgeAlias } from "./policy.js";
import type { App } from "./registry.js";

// A shared app (share.host) has one door, the gate: never a tailnet route.
export const exposes = (app: App): app is App & { port: number } => !!app.port && app.expose && !app.share?.host;

/**
 * Is the apps' tailnet node really this instance's door? Compile writes config/apps-node (`tailnet` only with exposure
 * tailscale and the node's key or state present), and APPS_URL_BASE names the node. Read on every use; anything else
 * (missing, unreadable, `none`, no URL base) is no node: fail closed.
 */
export function tailnetNode(file: string | undefined, urlBase: string): boolean {
  if (!file || !urlBase) return false;
  try {
    return readFileSync(file, "utf8").trim() === "tailnet";
  } catch {
    return false;
  }
}

/**
 * Token-less callers are anonymous (AIDENHQ_ANONYMOUS=tailnet) only for an exposed, unshared app behind a real apps node,
 * where the tailnet is the perimeter. Without one, the only ways in are the host's loopback and Docker bridges, so any host
 * process would be anonymous: every app requires a signed identity (docs/design/app-identity.md).
 */
export function anonymousCallers(app: App, node: boolean): boolean {
  return node && exposes(app);
}
export const GATE_PORT = 3130; // the gate (modules/apps-platform/gate) on the host's loopback; scripts/modules.ts uses the same
const RESERVED = new Set([443, 3100, 3120, 3121, 3122, 3129, GATE_PORT, 3132, 8090, 8443]); // core services (3129: the kernel's sign-in listener), the gate (3132: its test-only listener), and the board's tailnet ports
export const EDGE_CONTAINER = "aidenhq-apps-edge"; // compose.yaml container_name

export function checkPort(app: App): void {
  if (app.port && RESERVED.has(app.port)) throw new Error(`port ${app.port} is reserved for the platform`);
}

/** Where an exposed app answers inside Docker: the container publishing the registry port, and its container-side port. */
export interface EdgeTarget { port: number; host: string; target: number }

/**
 * The service publishing app.port in the sandboxed compose, by the alias policy.ts gives it on the app's own network
 * (edge-<app>; container names can collide across apps). None without that alias (deployed before it): not served.
 */
export function edgeTarget(app: App & { port: number }, compose: { services?: Record<string, any> }): EdgeTarget | undefined {
  const host = edgeAlias(app.name);
  for (const s of Object.values(compose.services ?? {}))
    for (const p of s.ports ?? [])
      if (Number(p.published) === app.port && s.networks?.[`app-${app.name}`]?.aliases?.includes(host)) return { port: app.port, host, target: Number(p.target) };
  return undefined;
}

/** The sidecar's serve config: HTTPS on each app's port, proxied to its container. `{}` clears every route. */
export function serveConfig(targets: EdgeTarget[]) {
  const sorted = [...targets].sort((a, b) => a.port - b.port);
  return {
    ...(sorted.length ? { TCP: Object.fromEntries(sorted.map((t) => [String(t.port), { HTTPS: true }])) } : {}),
    ...(sorted.length ? { Web: Object.fromEntries(sorted.map((t) => [`\${TS_CERT_DOMAIN}:${t.port}`, { Handlers: { "/": { Proxy: `http://${t.host}:${t.target}` } } }])) } : {}),
  };
}

/** Writes the serve config when it changed. Atomic: containerboot exits on a half-written file. */
export function writeServeConfig(dir: string, targets: EdgeTarget[]): boolean {
  const file = `${dir}/serve.json`;
  const next = `${JSON.stringify(serveConfig(targets), null, 1)}\n`;
  try {
    if (readFileSync(file, "utf8") === next) return false;
  } catch {}
  writeFileSync(`${file}.tmp`, next, { mode: 0o644 });
  renameSync(`${file}.tmp`, file);
  return true;
}
