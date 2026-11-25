// Stand-ins for the kernel's model gateway and a connection's MCP proxy, for the fresh-session e2e test.
import { createServer, type Server } from "node:http";

const listen = (s: Server, port: number) => new Promise<Server>((r) => s.listen(port, "127.0.0.1", () => r(s)));

/** The gateway's model list (GET /api/v1/models): each model's real window, as the stand-in serves it. */
export const MODELS = ["~deepseek/deepseek-flash-latest", "moonshotai/kimi-k3.1-pro", "m1"].map((id) => ({ id, object: "model", context_length: id.startsWith("~deepseek") ? 1_000_000 : 262_144, max_completion_tokens: 65_536 }));

/** An OpenAI-compatible gateway that answers every chat with one line. `seen` holds each request's bearer. */
export async function fakeGateway(port: number) {
  const seen: { auth?: string; model?: string; effort?: string }[] = [];
  const s = await listen(createServer((req, res) => {
    let b = "";
    req.on("data", (d) => (b += d));
    req.on("end", () => {
      const j = b ? JSON.parse(b) : {};
      if (req.method === "GET" && /\/models(\?|$)/.test(req.url ?? "")) {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ object: "list", data: MODELS }));
      }
      seen.push({ auth: req.headers.authorization, model: j.model, effort: j.reasoning_effort });
      if (!req.url?.endsWith("/chat/completions")) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { "content-type": "text/event-stream" });
      const c = (o: unknown) => res.write(`data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 1, model: j.model, choices: [o] })}\n\n`);
      c({ index: 0, delta: { role: "assistant", content: "ok" } });
      c({ index: 0, delta: {}, finish_reason: "stop" });
      res.end("data: [DONE]\n\n");
    });
  }), port);
  return { seen, close: () => s.close() };
}
