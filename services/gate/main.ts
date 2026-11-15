// The gate's process: reads the compiled config (GATE_CONFIG, mounted read-only) again whenever it changes and listens on
// 127.0.0.1 only (host networking: cloudflared and the apps' loopback ports are on the host).
import { readFileSync, statSync } from "node:fs";
import { createGate, type GateConfig } from "./gate.ts";

const file = process.env.GATE_CONFIG ?? "/config/gate.json";
let cfg: GateConfig, mtime = -1;
const config = (): GateConfig => {
  const m = statSync(file).mtimeMs;
  if (m !== mtime) {
    cfg = JSON.parse(readFileSync(file, "utf8")) as GateConfig; // compiled by scripts/edge.mjs at the owner's apply
    mtime = m;
  }
  return cfg;
};
const { port } = config();
createGate({ config }).listen(port, "127.0.0.1", () => console.log(JSON.stringify({ msg: "gate listening", port })));
