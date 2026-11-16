import { generateKeyPairSync, sign } from "node:crypto";

// A throwaway kernel key, served as the JWKS through the global fetch; any other URL goes on to the real fetch.
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
process.env.AIDENHQ_KERNEL_URL = "http://kernel.test";
const realFetch = globalThis.fetch;
globalThis.fetch = ((url: Parameters<typeof fetch>[0], init?: RequestInit) =>
  String(url) === "http://kernel.test/v1/jwks" ? Promise.resolve(Response.json({ keys: [publicKey.export({ format: "jwk" })] })) : realFetch(url, init)) as typeof fetch;

const b64 = (v: unknown) => Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64url");

/** The kernel's X-AidenHQ-Caller header for agent `id`, signed with the throwaway key. */
export function asAgent(id: string, claims: Record<string, unknown> = {}): Record<string, string> {
  const head = b64({ alg: "EdDSA", typ: "JWT" });
  const body = b64({ agent: id, key: id, name: id, roles: [], tool: "t", jti: "call-1", aud: "tasks", exp: Math.floor(Date.now() / 1000) + 60, ...claims });
  return { "x-aidenhq-caller": `${head}.${body}.${sign(null, Buffer.from(`${head}.${body}`), privateKey).toString("base64url")}` };
}
