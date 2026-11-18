// The `post` action's request signature, shared by the kernel (signs, kernel/src/outcomes.ts) and the plugin (checks,
// post.js): HMAC-SHA256 with paperclip_post_key over the company, the agent and every param but the signature, keys sorted.
// The key itself never travels.
import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Params Paperclip's action route adds before the plugin sees them (`companyId`, and `renderEnvironment`, null when the
 * caller sent none). Neither is the kernel's: the company is signed as the first element, from the action's verified
 * context, and the plugin reads neither. Left out of the signature on both sides and ignored by post.js.
 */
export const HOST_PARAMS = ["companyId", "renderEnvironment"];

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
  const rest = Object.fromEntries(Object.entries(params).filter(([k]) => k !== "sig" && !HOST_PARAMS.includes(k)));
  return createHmac("sha256", key).update(canonical([companyId, agentId, rest])).digest("hex");
}

/** @param {string} key @param {string} companyId @param {string} agentId @param {Record<string, unknown>} params */
export function verify(key, companyId, agentId, params) {
  if (!key || typeof params.sig !== "string" || !/^[0-9a-f]{64}$/.test(params.sig)) return false;
  return timingSafeEqual(Buffer.from(signature(key, companyId, agentId, params), "hex"), Buffer.from(params.sig, "hex"));
}
