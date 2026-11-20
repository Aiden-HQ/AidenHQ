// The public front door's certificate (settings.exposure: public; scripts/front-door.ts): a verified TLS handshake with
// the host's own https://<ip>, as a browser makes it (no SNI for an IP). Caddy renews the 160-hour certificate itself; when
// it has under 48 hours left, or fails to verify, the owner hears it, at most once every 12 hours.
import tls from "node:tls";

export type CertProbe = (ip: string) => Promise<{ validTo: number } | { error: string }>;

export const probeCert: CertProbe = (ip) =>
  new Promise((resolve) => {
    const s = tls.connect({ host: ip, port: 443, timeout: 15_000 }, () => {
      const validTo = Date.parse(s.getPeerCertificate().valid_to);
      s.end();
      resolve({ validTo });
    });
    s.on("error", (e) => resolve({ error: e.message }));
    s.on("timeout", () => (s.destroy(), resolve({ error: "no answer in 15 seconds" })));
  });

const HOUR = 3_600_000;

/** `ip()`: the front door's address while exposure is public, else undefined (nothing to check). */
export function createCertWatch(o: { ip: () => string | undefined; notify: (line: string) => void; probe?: CertProbe; now?: () => number }) {
  let told = -Infinity;
  return {
    async tick() {
      const ip = o.ip();
      if (!ip) return;
      const r = await (o.probe ?? probeCert)(ip);
      const now = (o.now ?? Date.now)();
      const left = "error" in r ? -1 : (r.validTo - now) / HOUR;
      const problem = "error" in r ? `fails to verify (${r.error})` : left < 48 ? `expires in ${Math.max(0, Math.floor(left))} hours` : "";
      if (!problem || now - told < 12 * HOUR) return;
      told = now;
      o.notify(`The board's HTTPS certificate for https://${ip} ${problem}. Caddy renews it by itself, so this means it can't: check that tcp 443 still reaches this host from the Internet, and Caddy's log (docker compose logs caddy).`);
    },
  };
}
