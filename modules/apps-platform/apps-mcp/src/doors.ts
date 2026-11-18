// App doors (docs/design/app-doors.md in the product): without the apps' tailnet node or settings.edge, the gate serves
// every exposed app at <app>.<base> to AidenHQ admins (`localhost` over http on loopback, or <ip-with-dashes>.sslip.io
// behind Caddy). apps-mcp writes which apps it serves and on which loopback port (the doors file, beside the previews
// file the gate already reads), and gives each app its door URL only once that door really opens.
import { readFileSync } from "node:fs";
import { connect } from "node:tls";

/** The door compile configured in the gate's config (config/gate.json `doors` and `origin`), or none. Read on every use. */
export interface Door { base: string; scheme: "http" | "https"; port?: number }
export function readDoor(gateFile: string | undefined): Door | undefined {
  if (!gateFile) return undefined;
  try {
    const g = JSON.parse(readFileSync(gateFile, "utf8")) as { doors?: { base?: unknown }; origin?: { scheme?: unknown; port?: unknown } };
    if (typeof g.doors?.base !== "string" || !g.doors.base) return undefined;
    return { base: g.doors.base, scheme: g.origin?.scheme === "http" ? "http" : "https", ...(Number.isInteger(g.origin?.port) ? { port: g.origin!.port as number } : {}) };
  } catch {
    return undefined;
  }
}

export const doorHost = (door: Door, app: string) => `${app}.${door.base}`;
export const doorUrl = (door: Door, app: string) => `${door.scheme}://${doorHost(door, app)}${door.port ? `:${door.port}` : ""}`;

/** A public door's IPv4, from its sslip.io base (203-0-113-7.sslip.io → 203.0.113.7); undefined for any other base. */
export function doorIp(base: string): string | undefined {
  const m = /^(\d{1,3})-(\d{1,3})-(\d{1,3})-(\d{1,3})\.sslip\.io$/.exec(base);
  return m ? m.slice(1).join(".") : undefined;
}

/**
 * Does `host` answer on `ip`:443 with a certificate for it that Node's roots trust? This handshake is also what makes Caddy
 * order the certificate (on-demand, after the gate's door-ask), so it both starts and proves the door.
 */
export type TlsCheck = (host: string, ip: string) => Promise<boolean>;
export const tlsCheck: TlsCheck = (host, ip) =>
  new Promise((resolve) => {
    const s = connect({ host: ip, port: 443, servername: host, timeout: 30_000, ALPNProtocols: ["http/1.1"] }, () => {
      resolve(s.authorized);
      s.end();
    });
    s.on("error", () => resolve(false));
    s.on("timeout", () => (resolve(false), s.destroy()));
  });

export const WAITING_FOR_CERTIFICATE =
  "Waiting for its HTTPS certificate: sslip.io names share one Let's Encrypt limit with everyone who uses sslip.io, so this can take days. Ask Aiden for your own domain or Tailscale.";
export const NO_DOOR =
  "No browser door on this server yet: apps open through Tailscale's apps node, a shared host (settings.edge), or the gate's door on a local or public install. Ask Aiden.";
export const NOT_SERVED = "Its door opens once it has deployed healthy.";

/**
 * Whether each public door's certificate works, checked at most every `retryMs` while it fails and every `okMs` once it
 * works. `ready` answers from the last check and starts a new one in the background when that one is stale.
 */
export function certificates(check: TlsCheck, now: () => number = Date.now, retryMs = 5 * 60_000, okMs = 3600_000) {
  const seen = new Map<string, { ok: boolean; at: number; running?: boolean }>();
  return (host: string, ip: string): boolean => {
    const s = seen.get(host);
    if (!s?.running && (!s || now() - s.at > (s.ok ? okMs : retryMs))) {
      seen.set(host, { ok: s?.ok ?? false, at: s?.at ?? 0, running: true });
      void check(host, ip).then((ok) => seen.set(host, { ok, at: now() }), () => seen.set(host, { ok: false, at: now() }));
    }
    return s?.ok ?? false;
  };
}
