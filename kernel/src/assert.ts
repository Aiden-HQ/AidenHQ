// Caller assertions: an Ed25519 key the kernel keeps (data/kernel/caller-key.pem), the JWT it signs per forwarded tool call
// (aud = the module, jti = the call, 60 s), its public half for modules (GET /v1/jwks), and the in-flight registry: an
// assertion opens /v1/cp/agent/* only while the call it was minted for is in flight (begin at forward, end when the
// module's answer ends), so a module can make several control-plane calls for one tool call and none after it.
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, sign, type KeyObject } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { verifyCaller, type Caller, type JWKS } from "../sdk/src/caller.ts";

export const TTL_S = 60;
export type CallerClaims = { agent: string; key: string; name: string; roles: string[]; task?: string; run?: string; tool: string; aud: string; kind: string };
/** What a call in flight holds: the caller's own credential (the kernel acts with it at /v1/cp/agent/*) and whom it was for. */
export type InFlight = {
  credential: string;
  /** A kernel job's own token: a module's model calls for that caller are made as the job (cp.ts createAsCaller). Never leaves the kernel. */
  bearer?: string;
  /** The kernel job making the call: its comments carry it in their tag, so a reader can tell which run wrote one. */
  job?: string;
  aud: string; run?: string; kind: string; at: number; exp: number };

const b64 = (v: unknown) => Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64url");

/** The kernel's caller key from `file`, created (0600) on first use. */
export function loadKey(file: string): KeyObject {
  if (!existsSync(file)) {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const { privateKey } = generateKeyPairSync("ed25519");
    writeFileSync(file, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600, flag: "wx" });
  }
  return createPrivateKey(readFileSync(file));
}

export function createAsserter(key: KeyObject, now = Date.now) {
  const pub = createPublicKey(key).export({ format: "jwk" });
  const kid = createHash("sha256").update(JSON.stringify(pub)).digest("base64url").slice(0, 16);
  const jwks: JWKS = { keys: [{ ...pub, kid, alg: "EdDSA", use: "sig" }] };
  const flights = new Map<string, InFlight>();

  function signCaller(c: CallerClaims): { jwt: string; jti: string } {
    const jti = randomUUID();
    const iat = Math.floor(now() / 1000);
    const body = `${b64({ alg: "EdDSA", typ: "JWT", kid })}.${b64({ iss: "aidenhq-kernel", ...c, jti, iat, exp: iat + TTL_S })}`;
    return { jwt: `${body}.${sign(null, Buffer.from(body), key).toString("base64url")}`, jti };
  }
  // A call in flight may outlive its assertion's 60 s (a fan-out or a deploy runs minutes): the kernel's own routes honour it
  // until the call's timeout, while a module's own check of the assertion (the SDK) still ends at 60 s.
  const begin = (jti: string, f: Omit<InFlight, "exp" | "at">, ttlS = TTL_S) => void flights.set(jti, { ...f, at: now(), exp: now() + Math.max(TTL_S, ttlS) * 1000 });
  const end = (jti: string) => void flights.delete(jti);

  /** The call in flight behind an assertion presented by module `aud`; undefined when forged, expired, misaddressed or ended. */
  async function inFlight(jwt: string, aud: string): Promise<{ caller: Caller; flight: InFlight } | undefined> {
    let caller: Caller;
    let jti: unknown;
    try { jti = JSON.parse(Buffer.from(jwt.split(".")[1] ?? "", "base64url").toString("utf8")).jti; } catch { return undefined; }
    const started = typeof jti === "string" ? flights.get(jti) : undefined;
    if (!started) return undefined;
    // Signature, audience and expiry checked as of the call's start: its assertion was valid when it was minted.
    try { caller = await verifyCaller({ headers: { "x-aidenhq-caller": jwt } }, jwks, aud, started.at); } catch { return undefined; }
    const flight = flights.get(caller.call);
    if (!flight || flight.aud !== aud || flight.exp <= now()) return undefined;
    return { caller, flight };
  }
  return { jwks, signCaller, begin, end, inFlight, size: () => flights.size };
}
export type Asserter = ReturnType<typeof createAsserter>;
