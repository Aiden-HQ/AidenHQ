// Agents' identity at apps (docs/design/app-identity.md): app_api and app_view send X-AidenHQ-Identity, a short-lived Ed25519
// JWT apps-mcp signs with its own key (the vault's identity/apps.pem; issuer aidenhq-apps, which apps accept only for
// `agent:<key>` subjects). Each token names exactly what it may do: app_api one method on one path, app_view reads.
import { createHash, createPrivateKey, createPublicKey, sign, type KeyObject } from "node:crypto";
import { readFileSync, statSync } from "node:fs";

export const IDENTITY_HEADER = "x-aidenhq-identity";
export const TTL_S = 300;
export interface Scope { role: "admin" | "member"; methods: string[]; path?: string }
/** Signs an agent's token for one app. */
export type Sign = (app: string, agent: string, scope: Scope) => string;

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");

/** A signer reading the key file (re-read when it changes); kid as scripts/identity.mjs computes it. */
export function agentSigner(file: string, now: () => number = Date.now): Sign {
  let cached: { key: KeyObject; kid: string } | undefined, mtime = -1;
  const key = () => {
    let m: number;
    try {
      m = statSync(file).mtimeMs;
    } catch {
      throw new Error(`apps-mcp has no identity key (${file}): run ops/apply-config.sh, which creates it`);
    }
    if (m !== mtime) {
      const k = createPrivateKey(readFileSync(file, "utf8"));
      const x = createPublicKey(k).export({ format: "jwk" }).x!;
      cached = { key: k, kid: createHash("sha256").update(Buffer.from(x, "base64url")).digest("base64url").slice(0, 16) };
      mtime = m;
    }
    return cached!;
  };
  return (app, agent, scope) => {
    const { key: k, kid } = key();
    const iat = Math.floor(now() / 1000);
    const body = `${b64({ alg: "EdDSA", kid, typ: "JWT" })}.${b64({ iss: "aidenhq-apps", aud: app, sub: `agent:${agent}`, kind: "agent", email: "", name: agent, role: scope.role, methods: scope.methods, ...(scope.path ? { path: scope.path } : {}), idp: "apps-mcp", iat, exp: iat + TTL_S })}`;
    return `${body}.${sign(null, Buffer.from(body), k).toString("base64url")}`;
  };
}
