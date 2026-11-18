// Paperclip sandbox provider for agent computers: every lease is a gVisor box started by the host launcher.
// Plain JS, no build; mounted read-only into the paperclip container at /opt/aidenhq-computer (compose.yaml) and installed by setup.
export default {
  id: "aidenhq.computer",
  apiVersion: 1,
  version: "0.1.4", // keep equal to package.json: setup reinstalls when it changes
  displayName: "AidenHQ computers",
  description: "Each agent run in its own gVisor computer, started by the AidenHQ launcher on the host.",
  author: "AidenHQ",
  categories: ["automation"],
  capabilities: ["environment.drivers.register", "http.outbound", "issues.read", "issues.update", "issue.comments.create", "events.subscribe"],
  entrypoints: { worker: "./worker.js" },
  environmentDrivers: [{
    driverKey: "aidenhq-computer",
    kind: "sandbox_provider",
    displayName: "AidenHQ computer (gVisor)",
    description: "A gVisor container per run; image, limits and mounts are the launcher's.",
    sandboxCapabilities: { reusableLeases: true },
    configSchema: { type: "object", properties: {
      reuseLease: { type: "boolean", default: true },
      timeoutMs: { type: "number", default: 3_600_000 },
      launcherUrl: { type: "string", default: "http://10.231.0.1:8199" },
    } },
  }],
};
