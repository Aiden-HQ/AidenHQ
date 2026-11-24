// The gate's process: reads the compiled config (GATE_CONFIG, mounted read-only) again whenever it changes and listens on
// 127.0.0.1 (host networking: cloudflared and the apps' loopback ports are on the host), plus `front` (the tailnet address a
// front door reaches) when the config has one, plus cloudflared's unix socket (`socket`): the one listener whose
// CF-Connecting-IP is believed, since only cloudflared and the gate mount its directory.
import { chmodSync, rmSync } from "node:fs";
import { createConfigReader } from "./config-reader.ts";
import { createGate, type GateConfig } from "./gate.ts";
import { createTestListenerReconciler } from "./test-listener.ts";

// The compiled config: re-read on every change, with a mid-write read tolerated for a moment (config-reader.ts). A config the
// gate can't read at all refuses the request (gate.ts's own 503), never serves a stale access policy.
const config = createConfigReader(process.env.GATE_CONFIG ?? "/config/gate.json");
const { port, front, socket } = config();
/**
 * The test-user canary's listener (test-listener.ts): bound exactly while the compile wrote both settings.edge.test_user and
 * its address. `config()` re-reads the file on every change, so a settings-only apply that turns the test user on (or off)
 * binds (or closes) it in place, without waiting for an unrelated restart. With no test user nothing is bound.
 */
const testListener = createTestListenerReconciler({ config });
testListener.reconcile();
setInterval(() => testListener.reconcile(), 5000).unref();
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
