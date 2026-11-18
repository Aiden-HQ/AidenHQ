// Paperclip task events to the kernel's wake inbox (kernel/src/wakes.ts): ids only, no state. Plain JS, no build; mounted
// read-only into the paperclip container at /opt/aidenhq-events (compose.yaml) and installed by setup (scripts/paperclip-events.mjs).
export default {
  id: "aidenhq.events",
  apiVersion: 1,
  version: "0.1.0", // keep equal to package.json: setup reinstalls when it changes
  displayName: "AidenHQ wake events",
  description: "Tells the AidenHQ kernel which task changed, so its wake inbox scans it now instead of at the next poll.",
  author: "AidenHQ",
  categories: ["automation"],
  capabilities: ["events.subscribe", "http.outbound"],
  entrypoints: { worker: "./worker.js" },
};
