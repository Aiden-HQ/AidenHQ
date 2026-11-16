// The gate's process: reads the compiled config (GATE_CONFIG, mounted read-only) again whenever it changes and listens on
// 127.0.0.1 (host networking: cloudflared and the apps' loopback ports are on the host), plus `front` (the tailnet address a
// front door reaches) when the config has one, plus cloudflared's unix socket (`socket`): the one listener whose
// CF-Connecting-IP is believed, since only cloudflared and the gate mount its directory.
import { chmodSync, readFileSync, rmSync, statSync } from "node:fs";
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
const { port, front, socket } = config();
createGate({ config }).listen(port, "127.0.0.1", () => console.log(JSON.stringify({ msg: "gate listening", port })));
if (front) createGate({ config }).listen(front.port, front.address, () => console.log(JSON.stringify({ msg: "gate listening (front)", address: front.address, port: front.port })));
if (socket) {
  rmSync(socket, { force: true }); // a stale socket from the last run
  const tunnel = createGate({ config, fromTunnel: true });
  tunnel.listen(socket, () => {
    chmodSync(socket, 0o600); // cloudflared runs as the same user
    console.log(JSON.stringify({ msg: "gate listening (tunnel)", socket }));
  });
}
