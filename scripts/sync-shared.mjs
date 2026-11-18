#!/usr/bin/env node
// Copies shared code into the services that use it. Each service is its own Docker build context, so it holds a
// byte-identical copy; scripts/test/shared.test.mjs fails when one in this repository drifts, or one in the official modules
// (at modules-pin.json) when the change moves either side (checksModuleCopies); the modules' CI checks theirs against the
// product they pin (.github/ci/shared-copies.mjs).
//   kernel/sdk/src/{caller,fence}.ts the caller assertion check and the fence, in every module server (src/aidenhq-sdk/)
//   kernel/sdk/src/executor.ts       the executor side of write kinds, in each module server with an executor
//   modules/vendor-mcp/src/vendor/{proxy,oauth}.ts  the vendor pass-through, in each vendor connection (src/vendor/)
//   kernel/sdk/src/reviewer.ts       the reviewer side of reviewer@1, in the reviewer module's service
//   services/shared/review-files.mjs  the changed files as the reviewer reads them, in the reviewer module's service
//   services/shared/source-store.ts  the shared-sources writer side, in every source writer
//   services/shared/reason-codes.ts  reason codes on approvals and refusals, in the board
//   services/shared/url-setting.ts   the URL setting check, in the board and the runner (the compiler imports the original)
//   modules/apps-platform/design-system/      the design system, in the app starter and the agent computers
//   modules/apps-platform/starter/      the app starter, in the agent computers (a whole folder: SHARED_DIRS)
//   kernel/sdk/src/{types,engine-io,progress}.ts  the SDK's engine side, in every module with an sdk/ folder
//   services/shared/aidenhq-identity.mjs  apps' identity middleware, in the app template
//   node scripts/sync-shared.mjs
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const SHARED = {
  // Every module server checks the kernel's caller assertion (and fences what it must) with the SDK (lean-core 2a).
  ...Object.fromEntries(["caller.ts", "fence.ts"].map((f) => [`kernel/sdk/src/${f}`, [
    "modules/apps-platform/apps-mcp/src",
    "services/board/src",
    "modules/github/connections/github-mcp/src",
    "modules/glean/connections/glean-mcp/src",
    "modules/google/connections/google-workspace-mcp/src",
    "modules/grafana/connections/grafana-mcp/src",
    "modules/hubspot/connections/hubspot-mcp/src",
    "modules/jira/connections/jira-mcp/src",
    "modules/meetings/connections/ops-mcp/src",
    "modules/channel-slack/connections/slack/src",
    "modules/channel-telegram/connections/telegram/src",
    "modules/chat-lane/connections/lane/src",
    "modules/primer/connections/primer-mcp/src",
    "modules/slack/connections/slack-mcp/src",
    "modules/tasks/connections/tasks-mcp/src",
    // The grading service checks the tasks module's assertion when it files a rubric; it fences nothing.
    ...(f === "caller.ts" ? ["modules/grading/service/src"] : []),
  ].map((d) => `${d}/aidenhq-sdk/${f}`)])),
  // The executor side of write kinds (executor@1), in each module server that declares an executor.
  "kernel/sdk/src/executor.ts": ["modules/apps-platform/apps-mcp/src/aidenhq-sdk/executor.ts", "modules/primer/connections/primer-mcp/src/aidenhq-sdk/executor.ts", "modules/channel-slack/connections/slack/src/aidenhq-sdk/executor.ts", "modules/hubspot/connections/hubspot-mcp/src/aidenhq-sdk/executor.ts"],
  // The vendor connections' shared pass-through (owner, 2026-11-18: every connection exposes its vendor's whole MCP server),
  // whose canonical lives in the official modules (vendor-mcp/, not a module), in each vendor connection's src/vendor/.
  ...Object.fromEntries(["proxy.ts", "oauth.ts"].map((f) => [`modules/vendor-mcp/src/vendor/${f}`, ["glean/connections/glean-mcp", "grafana/connections/grafana-mcp", "hubspot/connections/hubspot-mcp", "jira/connections/jira-mcp", "primer/connections/primer-mcp", "slack/connections/slack-mcp"].map((d) => `modules/${d}/src/vendor/${f}`)])),
  // The reviewer side of reviewer@1, in the reviewer module's service (its own Docker build context).
  "kernel/sdk/src/reviewer.ts": ["modules/ai-reviewer/service/src/aidenhq-sdk/reviewer.ts"],
  // The changed files' shaping (the runner imports the canonical copy; the eval and the reviewer's verdicts use this one).
  "services/shared/review-files.mjs": ["modules/ai-reviewer/service/src/review-files.mjs"],
  // The reliability checklist's matcher: the CI template's (MIT), used by its code review and by the AI reviewer.
  "modules/ci/template/.github/review-checklist.mjs": ["modules/ai-reviewer/service/src/review-checklist.mjs"],
  "services/shared/source-store.ts": [
    "modules/channel-slack/connections/slack/src/source-store.ts",
    "modules/github/connections/github-mcp/src/source-store.ts",
    "modules/hubspot/connections/hubspot-mcp/src/source-store.ts",
    "modules/jira/connections/jira-mcp/src/source-store.ts",
    "modules/meetings/connections/ops-mcp/src/source-store.ts",
    "modules/google/connections/google-workspace-mcp/src/source-store.ts",
    "modules/security/scanner/src/source-store.ts",
  ],
  "services/shared/reason-codes.ts": ["services/board/src/reason-codes.ts"],
  "services/shared/url-setting.ts": ["services/board/src/url-setting.ts", "services/runner/src/url-setting.ts"],
  // App identity (docs/design/app-identity.md): the middleware every app copies, from the app template.
  "services/shared/aidenhq-identity.mjs": ["modules/apps-platform/starter/aidenhq-identity.mjs"],
  // The supply-chain checks, version picker and image scan, for app repos (the app CI template is copied into each as it is).
  "scripts/supply-chain/best-version.mjs": ["modules/ci/template/.github/supply-chain/best-version.mjs"],
  "scripts/supply-chain/pins.mjs": ["modules/ci/template/.github/supply-chain/pins.mjs"],
  "scripts/supply-chain/npm-age.mjs": ["modules/ci/template/.github/supply-chain/npm-age.mjs"],
  "scripts/supply-chain/image-scan.mjs": ["modules/ci/template/.github/supply-chain/image-scan.mjs"],
  // The design system: the app starter vendors its theme (tokens.css, shadcn.css), and the agent computers carry it all at
  // /opt/aidenhq/design-system. components.css and kit.js are the deprecated plain-CSS kit (its README).
  ...Object.fromEntries(
    ["tokens.css", "shadcn.css", "components.css", "kit.js", "guidelines.md", "review-checklist.md", "README.md", "LICENSE"].map((f) => [
      `modules/apps-platform/design-system/${f}`,
      [...(f === "tokens.css" || f === "shadcn.css" ? [`modules/apps-platform/starter/src/styles/${f}`] : []), `services/computer/images/agent-base/design-system/${f}`],
    ]),
  ),
  // The theme presets (one file each): an app imports the one it picks; the starter's catalog imports them all.
  ...Object.fromEntries(
    readdirSync(join(repo, "modules/apps-platform/design-system/presets")).map((f) => [
      `modules/apps-platform/design-system/presets/${f}`,
      [`modules/apps-platform/starter/src/styles/presets/${f}`, `services/computer/images/agent-base/design-system/presets/${f}`],
    ]),
  ),
  // The SDK's engine side (A9: no npm package yet): a copy in every module that has an sdk/ folder, so an engine runs from its
  // module folder alone (in a job's sandbox or a computer box). A new module adds the folder; nothing here changes.
  ...Object.fromEntries(
    ["types.ts", "engine-io.ts", "progress.ts"].map((f) => [
      `kernel/sdk/src/${f}`,
      readdirSync(join(repo, "modules"), { withFileTypes: true }).filter((d) => d.isDirectory() && existsSync(join(repo, "modules", d.name, "sdk"))).map((d) => `modules/${d.name}/sdk/${f}`),
    ]),
  ),
};

// Whole folders, copied after the files above (so a folder's copy carries what was synced into it). Each copy is replaced
// every time; node_modules and dist are never copied.
export const SHARED_DIRS = {
  // The app starter, so the UI/UX Designer, the UI Reviewer and Engineers in agent computers scaffold from /opt/aidenhq/app-starter.
  "modules/apps-platform/starter": ["services/computer/images/agent-base/app-starter"],
};
const SKIP = new Set(["node_modules", "dist"]);

/**
 * Whether a change must compare the official modules' copies with this repo's canonicals: when it moves either side of
 * the deployed pair, i.e. it touches modules-pin.json or a canonical file with a copy under modules/. `changed` is the
 * list of changed paths, or "all" (a push to main: always compare).
 */
export function checksModuleCopies(changed) {
  if (changed === "all") return true;
  const moved = new Set(["modules-pin.json", ...Object.entries(SHARED).filter(([, copies]) => copies.some((c) => c.startsWith("modules/"))).map(([canonical]) => canonical)]);
  return changed.some((f) => moved.has(f));
}

/** Files under a folder, relative and sorted, without node_modules and dist. */
export function listFiles(dir, sub = "") {
  return readdirSync(join(dir, sub), { withFileTypes: true })
    .filter((e) => !SKIP.has(e.name))
    .flatMap((e) => (e.isDirectory() ? listFiles(dir, join(sub, e.name)) : [join(sub, e.name)]))
    .sort();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let n = 0;
  for (const [canonical, copies] of Object.entries(SHARED))
    for (const c of copies) (mkdirSync(dirname(join(repo, c)), { recursive: true }), copyFileSync(join(repo, canonical), join(repo, c)), n++);
  for (const [canonical, copies] of Object.entries(SHARED_DIRS))
    for (const c of copies) {
      rmSync(join(repo, c), { recursive: true, force: true });
      for (const f of listFiles(join(repo, canonical))) {
        mkdirSync(dirname(join(repo, c, f)), { recursive: true });
        copyFileSync(join(repo, canonical, f), join(repo, c, f));
        n++;
      }
    }
  console.log(`copied ${Object.keys(SHARED).length} shared files and ${Object.keys(SHARED_DIRS).length} folders to ${n} places`);
}
