// The `post` action's request signature, shared by the kernel (signs, kernel/src/outcomes.ts) and the plugin (checks,
// post.js): HMAC-SHA256 with paperclip_post_key over the company, the agent and every param but the signature, keys sorted.
// The key itself never travels.
import { createHmac, timingSafeEqual } from "node:crypto";

/** Accepted clock skew between the kernel and the plugin, either way. */
export const SKEW_MS = 60_000;

const canonical = (v) => Array.isArray(v) ? `[${v.map(canonical).join(",")}]`
  : v && typeof v === "object" ? `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`
  : JSON.stringify(v ?? null);

/**
 * @param {string} key @param {string} companyId @param {string} agentId @param {Record<string, unknown>} params
 * @returns {string} hex HMAC of the request (params' own `sig` is left out)
 */
export function signature(key, companyId, agentId, params) {
  const { sig: _sig, ...rest } = params;
  return createHmac("sha256", key).update(canonical([companyId, agentId, rest])).digest("hex");
}

/** @param {string} key @param {string} companyId @param {string} agentId @param {Record<string, unknown>} params */
export function verify(key, companyId, agentId, params) {
  if (!key || typeof params.sig !== "string" || !/^[0-9a-f]{64}$/.test(params.sig)) return false;
  return timingSafeEqual(Buffer.from(signature(key, companyId, agentId, params), "hex"), Buffer.from(params.sig, "hex"));
}
