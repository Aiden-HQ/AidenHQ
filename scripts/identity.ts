// App identity keys (docs/design/app-identity.md, Keys and rotation). The vault's identity/ dir holds the signers' Ed25519
// private keys, gate.pem (the gate: people), apps.pem (apps-mcp: agents) and test.pem (the kernel: a test user's sign-in at a
// gated app the owner names), and keys.json, the public keys every app and the gate verify with. Compile runs this on every
// apply: a missing private key is created, and keys.json is rewritten in place (apps mount it as a single file, which pins the
// inode) from every gate*.pem, apps*.pem and test*.pem present, so a renamed old key (gate.old.pem) stays trusted until it is
// deleted.
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const ISSUERS = { gate: "aidenhq-gate", apps: "aidenhq-apps", test: "aidenhq-test" };

/** kid: the first 16 characters of the base64url SHA-256 of the raw public key. */
export const kidOf = (publicKey: KeyObject) => createHash("sha256").update(Buffer.from(publicKey.export({ format: "jwk" }).x!, "base64url")).digest("base64url").slice(0, 16);

/** Ensures identity/{gate,apps,test}.pem and writes identity/keys.json; returns the names of the keys it created. */
export function ensureIdentityKeys(secretsDir: string) {
  const dir = join(secretsDir, "identity");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const made: string[] = [];
  for (const name of Object.keys(ISSUERS)) {
    const f = join(dir, `${name}.pem`);
    if (existsSync(f)) continue;
    writeFileSync(f, generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
    made.push(`identity/${name}.pem`);
  }
  const keys = readdirSync(dir).filter((f) => /^(gate|apps|test)[A-Za-z0-9._-]*\.pem$/.test(f)).sort().map((f) => {
    const pub = createPublicKey(createPrivateKey(readFileSync(join(dir, f), "utf8")));
    const { kty, crv, x } = pub.export({ format: "jwk" });
    return { kty, crv, x, kid: kidOf(pub), iss: ISSUERS[/^(gate|apps|test)/.exec(f)![1] as keyof typeof ISSUERS], use: "sig", alg: "EdDSA" };
  });
  const text = JSON.stringify({ keys }, null, 2) + "\n";
  const out = join(dir, "keys.json");
  if (!existsSync(out) || readFileSync(out, "utf8") !== text) writeFileSync(out, text, { mode: 0o644 }); // in place: same inode
  return made;
}
