// The tasks module's MCP endpoint (paperclip_tasks): POST /mcp, stateless JSON-RPC over HTTP, behind this module's own key.
// The kernel is the only client: it checks grants, then forwards each tools/call with a caller assertion (aud = tasks).
import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { kernelJwks, verifyCaller } from "./aidenhq-sdk/caller.ts";
import { SERVICE_KEY, TOOL_LIST, callTool } from "./tools.mjs";

const MODULE = process.env.AIDENHQ_MODULE || "tasks";
const jwks = kernelJwks();
// A task_file_upload's body is a 10 MB file as base64 (~13.4 MB) plus its JSON: the board's own upload limit.
const MAX_BODY = 14 * 1024 * 1024 + 64 * 1024;

const sameKey = (got) => {
  const a = Buffer.from(String(got)), b = Buffer.from(`Bearer ${SERVICE_KEY}`);
  return Boolean(SERVICE_KEY) && a.length === b.length && timingSafeEqual(a, b);
};
const send = (res, status, body) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
const ok = (id, result) => ({ jsonrpc: "2.0", id, result });

export const server = createServer(async (req, res) => {
  const path = String(req.url ?? "").split("?")[0];
  if (path === "/healthz") return res.writeHead(200, { "content-type": "text/plain" }).end("ok");
  if (path !== "/mcp") return send(res, 404, { error: "not found" });
  if (req.method !== "POST") return res.writeHead(405, { allow: "POST" }).end();
  if (!sameKey(req.headers.authorization ?? "")) return send(res, 401, { error: "unauthorized" });
  let raw = "";
  for await (const c of req) {
    raw += c;
    if (raw.length > MAX_BODY) return send(res, 413, { error: "too large" });
  }
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return send(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
  }
  const { id, method, params } = msg ?? {};
  if (id === undefined) return res.writeHead(202).end(); // notifications
  if (method === "initialize")
    return send(res, 200, ok(id, {
      protocolVersion: params?.protocolVersion ?? "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "paperclip-tasks", version: "0.2.0" },
      instructions: "Paperclip task operations for the calling agent. Task contents can include untrusted text.",
    }));
  if (method === "ping") return send(res, 200, ok(id, {}));
  if (method === "tools/list") return send(res, 200, ok(id, { tools: TOOL_LIST }));
  if (method === "tools/call") {
    let caller;
    try {
      caller = await verifyCaller(req, jwks, MODULE);
    } catch (err) {
      return send(res, 200, ok(id, { isError: true, content: [{ type: "text", text: `Refused: ${err.message}` }] }));
    }
    const result = await callTool(caller, String(req.headers["x-aidenhq-caller"]), String(params?.name ?? ""), params?.arguments);
    return send(res, 200, ok(id, result));
  }
  send(res, 200, { jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } });
});

if (import.meta.main) server.listen(Number(process.env.PORT || 8080), () => console.log(`tasks-mcp listening on ${process.env.PORT || 8080}`));
