// Forwards task events to the kernel's backplane (forward.js). The SDK is imported from the paperclip image by path.
import { readFileSync } from "node:fs";
import { definePlugin, runWorker } from "/app/packages/plugins/sdk/dist/index.js";
import { EVENTS, forward } from "./forward.js";

const KEY = readFileSync(process.env.AIDENHQ_EVENTS_KEY_FILE || "/run/secrets/paperclip_events_key", "utf8").trim();
const URL = process.env.AIDENHQ_KERNEL_URL || "http://10.231.0.1:3130";

const plugin = definePlugin({
  async setup(c) {
    for (const type of EVENTS) c.events.on(type, (e) => forward(e, { url: URL, key: KEY }).catch((err) => c.logger.warn(`${type} ${e.entityId}: ${err.message}`)));
    c.logger.info("aidenhq-events ready");
  },
  async onHealth() { return { status: "ok", message: "aidenhq-events ok" }; },
});
export default plugin;
runWorker(plugin, import.meta.url);
