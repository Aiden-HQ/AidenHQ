#!/usr/bin/env node
// The host's own tailnet name serves Paperclip, the board and Grafana only: a browser sends that name's cookies (the board's
// session) to every port of it, so agent-built apps live on their own node (compose.yaml apps-edge), never here.
//   node scripts/host-serve.ts check   prints what else the host's `tailscale serve` has; exit 1 if anything
//   node scripts/host-serve.ts prune   turns every such route off (ops/apply-config.sh; e.g. an app port served here before)
//   node scripts/host-serve.ts door    serves the module door (https 8447 → the gate) while config/gate.json has one and the
//                                      host doesn't serve it yet (apply, in tailscale exposure)
// Without tailscale on this host: check says so (exit 0), prune does nothing.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Paperclip, the board (local, LAN), the monitoring module's Grafana and the gate's module door: trusted, signed-in services
// only (never an agent-built app: the gate serves module services alone on this name, scripts/edge.ts).
const OK = new Set(["http://127.0.0.1:3100", "http://127.0.0.1:3120", "http://127.0.0.1:3121", "http://127.0.0.1:3131", "http://127.0.0.1:3130"]);
const DOOR = "8447"; // scripts/edge.ts DOOR_PORT

/** Ports the host serves that aren't HTTPS to Paperclip or the board, each with why; plus funnel, which prune leaves (loud). */
interface Served { TCP?: Record<string, { HTTPS?: boolean; TCPForward?: string }>; Web?: Record<string, { Handlers?: Record<string, { Proxy?: string; Path?: string }> }>; AllowFunnel?: Record<string, boolean> }

export function strays(s: Served) {
  const bad = new Map<string, { tcp: boolean; why: string }>();
  for (const [port, t] of Object.entries(s.TCP ?? {})) if (!t.HTTPS) bad.set(port, { tcp: true, why: `tcp ${port}${t.TCPForward ? ` -> ${t.TCPForward}` : ""}` });
  for (const [hostPort, w] of Object.entries(s.Web ?? {}))
    for (const [path, h] of Object.entries(w.Handlers ?? {}))
      if (!OK.has(String(h.Proxy ?? "").replace(/\/$/, ""))) bad.set(hostPort.split(":").pop()!, { tcp: false, why: `${hostPort}${path} -> ${h.Proxy ?? h.Path ?? "text"}` });
  const funnel = Object.entries(s.AllowFunnel ?? {}).filter(([, on]) => on).map(([hp]) => `funnel ${hp}`);
  return { ports: [...bad.entries()].map(([port, b]) => ({ port, ...b })), funnel };
}

const ts = (...args: string[]) => execFileSync("tailscale", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const cmd = process.argv[2]!;
  if (!["check", "prune", "door"].includes(cmd)) { console.error("usage: host-serve.ts check|prune|door"); process.exit(2); }
  let s;
  try { s = JSON.parse(ts("serve", "status", "--json") || "{}"); } catch {
    console.log("tailscale serve status unavailable on this host");
    process.exit(0);
  }
  const { ports, funnel } = strays(s);
  if (cmd === "door") {
    // Only while the gate serves a module door (config/gate.json, compiled by scripts/edge.ts).
    let gate: { hosts?: Record<string, { door?: boolean }> } = {};
    try { gate = JSON.parse(readFileSync("config/gate.json", "utf8")); } catch {}
    const wanted = Object.values(gate.hosts ?? {}).some((h) => h.door);
    if (wanted && !Object.keys(s.Web ?? {}).some((hp) => hp.endsWith(`:${DOOR}`))) {
      try {
        ts("serve", "--bg", `--https=${DOOR}`, "http://127.0.0.1:3130");
        console.log(`  host tailscale serve: the module door on ${DOOR}`);
      } catch (e) {
        console.error(`  host tailscale serve: couldn't serve the module door on ${DOOR} (${String((e as Error).message).trim()}); run: tailscale serve --bg --https=${DOOR} http://127.0.0.1:3130`);
      }
    }
  } else if (cmd === "prune") {
    for (const p of ports) {
      ts("serve", p.tcp ? `--tcp=${p.port}` : `--https=${p.port}`, "off");
      console.log(`  host tailscale serve: turned off ${p.why}`);
    }
    if (funnel.length) console.error(`  host tailscale serve: funnel is on (${funnel.join(", ")}); turn it off by hand`);
  } else {
    const all = [...ports.map((p) => p.why), ...funnel];
    console.log(all.join(", "));
    process.exit(all.length ? 1 : 0);
  }
}
