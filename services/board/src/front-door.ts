/**
 * The public front door's certificate (settings.exposure public: Caddy on <ip>:443, scripts/front-door.mjs). Let's Encrypt
 * IP certificates last about 160 hours and Caddy renews them early; if renewal keeps failing, the board goes dark when the
 * certificate lapses. Every hour the board opens a TLS connection to its own address, verified against Node's trust store,
 * and tells the owner when the certificate has under 48 hours left or can't be verified at all. Once per 12 hours at most.
 */
import tls from "node:tls";

const HOUR = 3_600_000;
export const WARN_MS = 48 * HOUR;
const REPEAT_MS = 12 * HOUR;

/** The certificate's expiry at host:443, verified (a self-signed or expired one throws). */
export function certExpiry(host: string, port = 443, ca?: string | Buffer): Promise<Date> {
  return new Promise((resolve, reject) => {
    const s = tls.connect({ host, port, ca, timeout: 15_000 }, () => {
      const valid = new Date(s.getPeerCertificate().valid_to);
      s.end();
      resolve(valid);
    });
    s.on("timeout", () => s.destroy(new Error("timed out")));
    s.on("error", reject);
  });
}

/** The owner's line for one check, or null when the certificate is fine. */
export function certProblem(host: string, expiry: Date | Error, now = Date.now()): string | null {
  if (expiry instanceof Error) return `🔒 **The board's HTTPS certificate can't be verified** at https://${host} (${expiry.message}). Caddy renews it on its own; check \`docker compose logs caddy\` on the server.`;
  const left = expiry.getTime() - now;
  if (left >= WARN_MS) return null;
  return `🔒 **The board's HTTPS certificate expires in ${Math.max(0, Math.floor(left / HOUR))} hours** (https://${host}): Caddy hasn't renewed it. Check \`docker compose logs caddy\` on the server; when it lapses the board is unreachable until it renews.`;
}

/** Hourly check with a 12-hour quiet period after each line. */
export function startCertWatch(host: string, notify: (line: string) => void, check = () => certExpiry(host)): () => Promise<void> {
  let told = 0;
  const run = async () => {
    const line = certProblem(host, await check().catch((e: Error) => e));
    if (line && Date.now() - told >= REPEAT_MS) {
      told = Date.now();
      notify(line);
    }
  };
  setInterval(() => void run(), HOUR).unref();
  setTimeout(() => void run(), 10 * 60_000).unref(); // after a fresh install's first issuance has had its time
  return run;
}
