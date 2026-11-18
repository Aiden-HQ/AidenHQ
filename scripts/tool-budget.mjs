#!/usr/bin/env node
// Per agent: how many tools it is granted and how big their schemas are (the model sees them every turn).
//   node scripts/tool-budget.mjs [--config config/paperclip.yaml] [--defs tools.json] [--save-defs tools.json]
//                                [--assume 170] [--map apps-mcp=10.231.0.15,...] [--json]
// Tool definitions come from each server's `tools/list` (HTTP, anonymous; stdio for the tasks bridge), or from a
// --defs file saved earlier with --save-defs (run it on the host, where the connection hosts resolve; --map
// rewrites a compose service name to an address when running outside the compose network).
// A server that can't be listed (401: its bearer token is not in this shell) counts its tools at --assume N tokens each
// and the row's `unknown` column says how many. Export the AIDENHQ_*_MCP_TOKEN vars on the host for exact numbers.
// Tokens are bytes / 4 of the JSON {name, description, inputSchema}: an estimate, good for ranking and before/after.
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tokens = (v) => Math.ceil(Buffer.byteLength(typeof v === "string" ? v : JSON.stringify(v)) / 4);

async function httpList(url, bearer) {
  let id = 0;
  const rpc = async (method, params) => {
    const res = await fetch(url, { method: "POST", signal: AbortSignal.timeout(15000), headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
    const text = await res.text();
    if (!res.ok) throw new Error(`${res.status} ${text.slice(0, 120)}`);
    const json = JSON.parse(text.startsWith("event:") || text.startsWith("id:") ? text.split("\n").find((l) => l.startsWith("data:")).slice(5) : text);
    if (json.error) throw new Error(JSON.stringify(json.error));
    return json.result;
  };
  await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "tool-budget", version: "0" } });
  return (await rpc("tools/list", {})).tools;
}

function stdioList(command, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(command, args, { stdio: ["pipe", "pipe", "ignore"], env: { PATH: process.env.PATH } });
    const t = setTimeout(() => { p.kill(); reject(new Error("timeout")); }, 15000);
    createInterface({ input: p.stdout }).on("line", (l) => {
      let m; try { m = JSON.parse(l); } catch { return; }
      if (m.id === 2) { clearTimeout(t); p.kill(); resolve(m.result.tools); }
    });
    p.on("error", reject);
    const send = (o) => p.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...o }) + "\n");
    send({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "tool-budget", version: "0" } } });
    send({ method: "notifications/initialized" });
    send({ id: 2, method: "tools/list", params: {} });
  });
}

export async function fetchDefs(servers, map = {}) {
  const defs = {};
  for (const [name, s] of Object.entries(servers)) {
    try {
      let tools;
      if (s.url) {
        let url = s.url;
        for (const [h, ip] of Object.entries(map)) url = url.replace(`//${h}:`, `//${ip}:`);
        tools = await httpList(url, s.auth ? (process.env[s.auth.toUpperCase()] ?? "") : ""); // its service key, e.g. GLEAN_SERVICE_KEY
      } else {
        // The bridge runs at /opt/aidenhq in the Paperclip container; here it is in the checkout.
        const args = (s.args ?? []).map((a) => a.replace("/opt/aidenhq/", join(root, "services/paperclip-tasks-mcp/")));
        tools = await stdioList(s.command, args);
      }
      defs[name] = Object.fromEntries(tools.map((t) => [t.name, { name: t.name, description: t.description ?? "", inputSchema: t.inputSchema ?? {} }]));
    } catch (e) {
      console.error(`${name}: tools/list failed (${e.message})`);
    }
  }
  return defs;
}

/** Rows per agent from the compiled config and tool definitions (pure: tested). */
export function budget(cfg, defs, readText = () => "", assume = 0) {
  const rows = [];
  for (const [key, a] of Object.entries(cfg.agents ?? {})) {
    let n = 0, tok = 0, unknown = 0;
    const per = {};
    for (const [srv, list] of Object.entries(a.enabled_tools ?? {})) {
      for (const t of list) {
        const d = defs[srv]?.[t];
        if (!d) { unknown++; n++; tok += assume; continue; }
        const k = tokens(d);
        n++; tok += k; per[`${srv}.${t}`] = k;
      }
    }
    const handbook = a.instructions ? tokens(readText(a.instructions)) : 0;
    rows.push({ agent: key, profile: a.profile, model: a.model ?? "", tools: n, tool_tokens: tok, unknown, handbook_tokens: handbook, heaviest: Object.entries(per).sort((x, y) => y[1] - x[1]).slice(0, 5) });
  }
  return rows.sort((x, y) => y.tool_tokens - x.tool_tokens);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const opt = (n) => { const i = argv.indexOf(`--${n}`); return i < 0 ? undefined : argv[i + 1]; };
  const cfg = parse(readFileSync(opt("config") ?? join(root, "config/paperclip.yaml"), "utf8"));
  const map = Object.fromEntries((opt("map") ?? "").split(",").filter(Boolean).map((p) => p.split("=")));
  const defs = opt("defs") ? JSON.parse(readFileSync(opt("defs"), "utf8")) : await fetchDefs(cfg.mcp_servers ?? {}, map);
  if (opt("save-defs")) writeFileSync(opt("save-defs"), JSON.stringify(defs));
  const rows = budget(cfg, defs, (f) => { try { return readFileSync(f, "utf8"); } catch { return ""; } }, Number(opt("assume") ?? 0));
  if (argv.includes("--json")) console.log(JSON.stringify(rows, null, 1));
  else {
    console.log("agent\tprofile\ttools\ttool_tokens\thandbook_tokens\tunknown\theaviest");
    for (const r of rows) console.log([r.agent, r.profile, r.tools, r.tool_tokens, r.handbook_tokens, r.unknown, r.heaviest.map(([t, k]) => `${t}:${k}`).join(" ")].join("\t"));
    console.log("\nserver\ttools\ttokens (all tools)");
    for (const [s, d] of Object.entries(defs)) console.log(`${s}\t${Object.keys(d).length}\t${tokens(Object.values(d))}`);
  }
}
