// The kernel's Paperclip plugin: task events to its wake inbox (kernel/src/wakes.ts; ids only, no state), and the `post`
// action, the kernel's writes as an agent without a Paperclip run (post.js, kernel/src/outcomes.ts). Plain JS, no build; mounted
// read-only into the paperclip container at /opt/aidenhq-events (compose.yaml) and installed by setup (scripts/paperclip-events.ts).
export default {
  id: "aidenhq.events",
  apiVersion: 1,
  version: "0.4.1", // a label, kept equal to package.json; setup reinstalls on the files' content hash
  displayName: "AidenHQ kernel",
  description: "Tells the AidenHQ kernel which task changed, and writes on tasks as an agent, for the kernel (a job's outcome and its writes).",
  author: "AidenHQ",
  categories: ["automation"],
  capabilities: ["events.subscribe", "http.outbound", "issues.read", "issues.create", "issues.update", "issue.comments.read", "issue.comments.create"],
  entrypoints: { worker: "./worker.js" },
};
