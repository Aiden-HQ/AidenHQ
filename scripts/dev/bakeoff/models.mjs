#!/usr/bin/env node
// Resolve the bake-off model ids and their ZDR status from OpenRouter at run time (only the wanted families are
// named here). A model is usable only if a real request with provider.zdr=true succeeds; otherwise it is excluded.
//   OPENROUTER_API_KEY=... node models.mjs > models.json
const key = process.env.OPENROUTER_API_KEY;
if (!key) { console.error("OPENROUTER_API_KEY not set"); process.exit(1); }
const get = async (p) => (await fetch(`https://openrouter.ai/api/v1${p}`, { headers: { authorization: `Bearer ${key}` } })).json();
const WANT = [
  { key: "haiku55", match: /^anthropic\/claude-haiku-5\.5$/, harnesses: ["codex", "claude"] },
  { key: "sonnet55", match: /^anthropic\/claude-sonnet-5\.5$/, harnesses: ["codex", "claude"] },
  { key: "deepseek", match: /^~deepseek\/deepseek-flash-latest$/, harnesses: ["codex"] },
  { key: "kimi", match: /^moonshotai\/kimi-k3\.1-pro$/, harnesses: ["codex"] },
];
const all = (await get("/models")).data;
const zdrTags = new Set((await get("/endpoints/zdr")).data.map((e) => e.tag));
const out = [];
for (const w of WANT) {
  const m = all.find((x) => w.match.test(x.id));
  if (!m) { out.push({ key: w.key, excluded: "not listed on OpenRouter" }); continue; }
  const ep = (await get(`/models/${m.id}/endpoints`)).data?.endpoints ?? [];
  const zdrEndpoints = ep.filter((e) => zdrTags.has(e.tag)).map((e) => e.tag);
  // Definitive check: a tiny request that may only be served by ZDR endpoints.
  const r = await fetch("https://openrouter.ai/api/v1/chat/completions", { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ model: m.id, max_tokens: 16, messages: [{ role: "user", content: "Say ok." }], provider: { zdr: true, data_collection: "deny" } }) });
  const j = await r.json();
  const ok = r.ok && j.choices;
  out.push({ key: w.key, id: m.id, name: m.name, harnesses: w.harnesses, price: { in: Number(m.pricing.prompt), out: Number(m.pricing.completion), cacheRead: Number(m.pricing.input_cache_read ?? 0) },
    zdrEndpoints, zdr: !!ok, ...(ok ? { probeProvider: j.provider } : { excluded: `no ZDR endpoint: ${j.error?.message ?? r.status}` }) });
}
console.log(JSON.stringify({ at: new Date().toISOString(), models: out }, null, 2));
