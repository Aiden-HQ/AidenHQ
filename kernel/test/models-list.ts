// A stub of OpenRouter's public models list (GET /api/v1/models), the gateway's only source of prices: `models` by id, in USD
// per million tokens as the tests write them ({ in, out, cached_in?, max_output? }). Returns the list's URL (the gateway's
// modelsUrl), a close() and how often it was fetched. Unref'd: a test file may keep one for all its tests.
import http from "node:http";

type Stub = { in: number; out: number; cached_in?: number; max_output?: number };

export async function modelsList(models: Record<string, Stub>): Promise<{ url: string; close: () => void; fetches: () => number }> {
  let n = 0;
  const data = Object.entries(models).map(([id, p]) => ({
    id,
    pricing: { prompt: String(p.in / 1e6), completion: String(p.out / 1e6), input_cache_read: String((p.cached_in ?? p.in) / 1e6) },
    top_provider: { max_completion_tokens: p.max_output ?? 4096 },
  }));
  const s = http.createServer((_req, res) => { n++; res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data })); });
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  s.unref();
  return { url: `http://127.0.0.1:${(s.address() as { port: number }).port}/api/v1/models`, close: () => s.close(), fetches: () => n };
}
