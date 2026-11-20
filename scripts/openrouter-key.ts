#!/usr/bin/env node
// One OpenRouter key per person, with a monthly spend limit, made with OpenRouter's provisioning API.
//   OPENROUTER_MANAGEMENT_KEY=... node scripts/openrouter-key.ts create <name> <limit USD>
//   OPENROUTER_MANAGEMENT_KEY=... node scripts/openrouter-key.ts revoke          (offboarding)
//   AIDENHQ_SECRETS_DIR=... node scripts/openrouter-key.ts check                 (does OpenRouter accept the key on file?)
// Writes openrouter_key (the key) and openrouter_key_hash (its id, for revoking) into AIDENHQ_SECRETS_DIR. create does
// nothing when openrouter_key is already set. The management key comes from the environment only and is never written.
// Privacy (ZDR) is an account setting at OpenRouter: a new key follows the account it's made in.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const API = "https://openrouter.ai/api/v1/keys";

async function call(fetchImpl, managementKey, method, url, body) {
  const res = await fetchImpl(url, {
    method,
    headers: { authorization: `Bearer ${managementKey}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`OpenRouter answered ${res.status}: ${json?.error?.message ?? "no detail"}`);
  return json;
}

/** A new key with a monthly limit in USD. */
export async function createKey({ fetch: fetchImpl = fetch, managementKey, name, limitUsd }) {
  const j = await call(fetchImpl, managementKey, "POST", API, { name, limit: limitUsd, limit_reset: "monthly" });
  if (!j.key || !j.data?.hash) throw new Error("OpenRouter's answer had no key");
  return { key: j.key, hash: j.data.hash };
}

export async function revokeKey({ fetch: fetchImpl = fetch, managementKey, hash }) {
  await call(fetchImpl, managementKey, "DELETE", `${API}/${encodeURIComponent(hash)}`);
}

/** Asks OpenRouter about a key: ok (label, remaining limit), rejected (401/403, with its message) or unreachable. */
export async function checkKey({ fetch: fetchImpl = fetch, key }) {
  let res;
  try {
    res = await fetchImpl("https://openrouter.ai/api/v1/key", { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000) });
  } catch (e) {
    return { status: "unreachable", message: e.message };
  }
  const json = await res.json().catch(() => ({}));
  const message = json?.error?.message ?? "no detail";
  if (res.status === 401 || res.status === 403) return { status: "rejected", message };
  if (!res.ok) return { status: "unreachable", message: `OpenRouter answered ${res.status}: ${message}` };
  return { status: "ok", label: json.data?.label, remaining: json.data?.limit_remaining ?? null };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const [cmd, name, limit] = process.argv.slice(2);
  const dir = process.env.AIDENHQ_SECRETS_DIR;
  const managementKey = process.env.OPENROUTER_MANAGEMENT_KEY;
  const die = (m) => { console.error(`openrouter-key: ${m}`); process.exit(1); };
  if (!dir) die("set AIDENHQ_SECRETS_DIR");
  const file = (n) => join(dir, n);
  const read = (n) => (existsSync(file(n)) ? readFileSync(file(n), "utf8").trim() : "");
  try {
    if (cmd === "create") {
      if (read("openrouter_key")) { console.log("OpenRouter key already set; nothing to do"); process.exit(0); }
      if (!managementKey) die("set OPENROUTER_MANAGEMENT_KEY (an OpenRouter management key)");
      const usd = Number(limit);
      if (!name || !(usd > 0)) die("usage: create <name> <limit USD>");
      const { key, hash } = await createKey({ managementKey, name, limitUsd: usd });
      writeFileSync(file("openrouter_key"), key, { mode: 0o600 });
      writeFileSync(file("openrouter_key_hash"), hash, { mode: 0o600 });
      console.log(`OpenRouter key ${name} created (limit $${usd} a month)`);
    } else if (cmd === "revoke") {
      const hash = read("openrouter_key_hash");
      if (!hash) die("no openrouter_key_hash on file");
      if (!managementKey) die("set OPENROUTER_MANAGEMENT_KEY");
      await revokeKey({ managementKey, hash });
      console.log("OpenRouter key revoked");
    } else if (cmd === "check") {
      const key = read("openrouter_key");
      if (!key) die("no openrouter_key on file");
      const r = await checkKey({ key });
      if (r.status === "rejected") die(`OpenRouter rejected the key in ${file("openrouter_key")}: ${r.message}; fix it and re-run setup`);
      if (r.status === "unreachable") console.error(`openrouter-key: WARNING: could not verify the key (${r.message}); continuing`);
      else console.log(`OpenRouter key ok${r.label ? ` (${r.label})` : ""}${r.remaining != null ? `, $${r.remaining} left` : ", no spend limit"}`);
    } else die("usage: create <name> <limit USD> | revoke | check");
  } catch (e) {
    die(e.message);
  }
}
