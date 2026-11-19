#!/usr/bin/env node
// Copies shared code into the services that use it. Each service is its own Docker build context, so it holds a
// byte-identical copy; scripts/test/shared.test.mjs fails when one drifts (the official modules' under modules/ included).
//   kernel/sdk/src/{caller,fence}.ts the caller assertion check and the fence, in every module server (src/aidenhq-sdk/)
//   kernel/sdk/src/executor.ts       the executor side of write kinds, in each module server with an executor
//   kernel/sdk/src/vendor/{proxy,oauth}.ts  the vendor pass-through, in each vendor connection (src/vendor/)
//   kernel/sdk/src/reviewer.ts       the reviewer side of reviewer@1, in the reviewer module's service
//   kernel/sdk/src/kernel-client.ts  the module-to-kernel client, in each module that calls the kernel
//   kernel/sdk/src/checks.ts         how check results are read, in the merge gate (codehost-github) and the grader
//   kernel/sdk/src/pin-owner.ts      who moves the product pin, in the code host's release train (the kernel's updater imports it)
//   kernel/sdk/src/judge.ts          the judges' models, cross-family choice and model call, in the reviewer and grading services
//   services/shared/review-files.mjs  the changed files as the reviewer reads them, in the reviewer module's service
//   kernel/sdk/src/source-store.ts   the shared-sources writer side, in every source writer
//   kernel/sdk/src/quality.ts        the revert and incident linker, in the board (the kernel's flow DORA imports it)
//   kernel/sdk/src/agent-paused.ts   the one paused rule (lifecycle holds), in the board, the Telegram channel and the Fleet Steward
//   services/shared/reason-codes.ts  reason codes on approvals and refusals, in the board
//   services/shared/url-setting.ts   the URL setting check, in the board (the compiler imports the original)
//   modules/apps-platform/design-system/      the design system, in the app starter and the agent computers
//   modules/apps-platform/starter/      the app starter, in the agent computers (a whole folder: SHARED_DIRS)
//   kernel/sdk/src/{types,engine-io,progress}.ts  the SDK's engine side, in every module with an sdk/ folder
//   modules/github/checks/{tests,history}.sh  a change's tests, in codehost-local's `change` check job
//   node scripts/sync-shared.mjs
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The canonicals and their copies under `root` (a product checkout). The whole-tree entries depend on which modules are
 * materialised there, so it is computed per root: the product's own, or a scratch checkout at a new modules pin.
 */
export function sharedCopies(root = repo) {
  const files = {
  // Every module server checks the kernel's caller assertion (and fences what it must) with the SDK (lean-core 2a).
  ...Object.fromEntries(["caller.ts", "fence.ts"].map((f) => [`kernel/sdk/src/${f}`, [
    "modules/apps-platform/apps-mcp/src",
    "services/board/src",
    "modules/clickhouse/connections/clickhouse-mcp/src",
    "modules/github/connections/github-mcp/src",
    "modules/glean/connections/glean-mcp/src",
    "modules/google/connections/google-workspace-mcp/src",
    "modules/grafana/connections/grafana-mcp/src",
    "modules/hubspot/connections/hubspot-mcp/src",
    "modules/jira/connections/jira-mcp/src",
    "modules/meetings/connections/ops-mcp/src",
    "modules/slack/connections/slack-live/src",
    "modules/chat-lane/connections/lane/src",
    "modules/primer/connections/primer-mcp/src",
    "modules/slack/connections/slack-mcp/src",
    "modules/tasks/connections/tasks-mcp/src",
    // The fleet-steward service checks the caller's assertion on its connection.
    "modules/fleet-steward/service/src",
    // The grading service checks the tasks module's assertion when it files a rubric, and the owner's router on notify; the
    // grading service, the reviewer and dispatch fence their prompts' data blocks (dataBlock).
    ...(f === "caller.ts" ? ["modules/grading/service/src", "modules/owner-channel/connections/notify/src"] : ["modules/grading/service/src", "modules/ai-reviewer/service/src", "modules/dispatch/service/src"]),
  ].map((d) => `${d}/aidenhq-sdk/${f}`)])),
  // The executor side of write kinds (executor@1), in each module server that declares an executor.
  "kernel/sdk/src/executor.ts": ["modules/apps-platform/apps-mcp/src/aidenhq-sdk/executor.ts", "modules/primer/connections/primer-mcp/src/aidenhq-sdk/executor.ts", "modules/slack/connections/slack-live/src/aidenhq-sdk/executor.ts", "modules/hubspot/connections/hubspot-mcp/src/aidenhq-sdk/executor.ts", "modules/github/service/src/aidenhq-sdk/executor.ts"],
  // A change's tests (the secret scan, supply chain, lint, tests and build), run the same for a change request on this server.
  ...Object.fromEntries(["tests.sh", "history.sh"].map((f) => [`modules/github/checks/${f}`, [`modules/codehost-local/checks/${f}`]])),
  // The vendor connections' shared pass-through (owner, 2026-11-18: every connection exposes its vendor's whole MCP server),
  // in each vendor connection's src/vendor/.
  ...Object.fromEntries(["proxy.ts", "oauth.ts"].map((f) => [`kernel/sdk/src/vendor/${f}`, ["clickhouse/connections/clickhouse-mcp", "glean/connections/glean-mcp", "grafana/connections/grafana-mcp", "hubspot/connections/hubspot-mcp", "github/connections/github-mcp", "jira/connections/jira-mcp", "primer/connections/primer-mcp", "slack/connections/slack-mcp"].map((d) => `modules/${d}/src/vendor/${f}`)])),
  // The reviewer side of reviewer@1, in the reviewer module's service (its own Docker build context).
  "kernel/sdk/src/reviewer.ts": ["modules/ai-reviewer/service/src/aidenhq-sdk/reviewer.ts"],
  // The eval's pass rule: the kernel's check job and the reviewer's own eval script apply this one copy.
  "kernel/sdk/src/pass-rule.ts": ["modules/ai-reviewer/service/src/aidenhq-sdk/pass-rule.ts"],
  // The one kernel client (design: one Paperclip/kernel client): every module that calls the kernel with its own token.
  "kernel/sdk/src/kernel-client.ts": ["modules/dispatch/service/src/aidenhq-sdk/kernel-client.ts", "modules/github/service/src/aidenhq-sdk/kernel-client.ts", "modules/grading/service/src/aidenhq-sdk/kernel-client.ts", "modules/maintainer/service/src/aidenhq-sdk/kernel-client.ts", "modules/fleet-steward/service/src/aidenhq-sdk/kernel-client.ts", "modules/chat-lane/connections/lane/src/aidenhq-sdk/kernel-client.ts", "modules/channel-telegram/connections/telegram/src/aidenhq-sdk/kernel-client.ts", "modules/owner-channel/connections/notify/src/aidenhq-sdk/kernel-client.ts"],
  // The judges' shared library (design §4.4): the reviewer and the grader keep their own contracts and credentials.
  "kernel/sdk/src/judge.ts": ["modules/ai-reviewer/service/src/aidenhq-sdk/judge.ts", "modules/grading/service/src/aidenhq-sdk/judge.ts"],
  // How GitHub check results are read: the merge gate, the PR watcher and the grader.
  "kernel/sdk/src/checks.ts": ["modules/github/service/src/aidenhq-sdk/checks.ts", "modules/grading/service/src/aidenhq-sdk/checks.ts"],
  // Code churn: the code host's churn pass and backfill (codehost-local calls the original from the kernel).
  "kernel/sdk/src/churn.ts": ["modules/github/service/src/aidenhq-sdk/churn.ts"],
  // Who moves the product pin: the kernel's updater and the code host's release train ask this one function.
  "kernel/sdk/src/pin-owner.ts": ["modules/github/service/src/aidenhq-sdk/pin-owner.ts"],
  // The changed files' shaping (the eval and the reviewer's verdicts use this copy).
  "services/shared/review-files.mjs": ["modules/ai-reviewer/service/src/review-files.mjs"],
  // The reliability checklist's matcher: the CI template's (MIT), used by its code review and by the AI reviewer.
  "modules/ci/template/.github/review-checklist.mjs": ["modules/ai-reviewer/service/src/review-checklist.mjs"],
  "kernel/sdk/src/source-store.ts": [
    "modules/slack/connections/slack-live/src/source-store.ts",
    "modules/github/connections/github-mcp/src/source-store.ts",
    "modules/hubspot/connections/hubspot-mcp/src/source-store.ts",
    "modules/jira/connections/jira-mcp/src/source-store.ts",
    "modules/meetings/connections/ops-mcp/src/source-store.ts",
    "modules/google/connections/google-workspace-mcp/src/source-store.ts",
    "modules/security/scanner/src/source-store.ts",
  ],
  // Who said it: a comment posted for someone else is never the owner's words (dispatch, the grader, task_comments, the board).
  "kernel/sdk/src/for-others.ts": ["modules/dispatch/service/src/aidenhq-sdk/for-others.ts", "modules/grading/service/src/aidenhq-sdk/for-others.ts", "modules/tasks/connections/tasks-mcp/src/aidenhq-sdk/for-others.ts", "services/board/src/aidenhq-sdk/for-others.ts"],
  // Whether an agent is paused (Paperclip's lifecycle holds, never its status): the board, the Telegram channel and the Fleet Steward.
  "kernel/sdk/src/agent-paused.ts": ["services/board/src/aidenhq-sdk/agent-paused.ts", "modules/channel-telegram/connections/telegram/src/aidenhq-sdk/agent-paused.ts", "modules/fleet-steward/service/src/aidenhq-sdk/agent-paused.ts"],
  // The revert and incident linker: the board's quality report and the kernel's flow DORA (flow.ts imports the original).
  "kernel/sdk/src/quality.ts": ["services/board/src/aidenhq-sdk/quality.ts"],
  "services/shared/reason-codes.ts": ["services/board/src/reason-codes.ts"],
  "services/shared/url-setting.ts": ["services/board/src/url-setting.ts"],
  // The supply-chain checks, version picker and image scan, for app repos (the app CI template is copied into each as it is).
  "scripts/supply-chain/best-version.mjs": ["modules/ci/template/.github/supply-chain/best-version.mjs", "modules/engineering/skills/supply-chain/best-version.mjs"],
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
    readdirSync(join(root, "modules/apps-platform/design-system/presets")).map((f) => [
      `modules/apps-platform/design-system/presets/${f}`,
      [`modules/apps-platform/starter/src/styles/presets/${f}`, `services/computer/images/agent-base/design-system/presets/${f}`],
    ]),
  ),
  // The SDK's engine side (A9: no npm package yet): a copy in every module that has an sdk/ folder, so an engine runs from its
  // module folder alone (in a job's sandbox or a computer box). A new module adds the folder; nothing here changes.
  ...Object.fromEntries(
    ["types.ts", "engine-io.ts", "progress.ts"].map((f) => [
      `kernel/sdk/src/${f}`,
      readdirSync(join(root, "modules"), { withFileTypes: true }).filter((d) => d.isDirectory() && existsSync(join(root, "modules", d.name, "sdk"))).map((d) => `modules/${d.name}/sdk/${f}`),
    ]),
  ),
  };

  // Whole folders, copied after the files above (so a folder's copy carries what was synced into it). Each copy is replaced
  // every time; node_modules and dist are never copied.
  const dirs = {
    // The app starter, so the UI/UX Designer, the UI Reviewer and Engineers in agent computers scaffold from /opt/aidenhq/app-starter.
    "modules/apps-platform/starter": ["services/computer/images/agent-base/app-starter"],
  };
  return { files, dirs };
}

export const { files: SHARED, dirs: SHARED_DIRS } = sharedCopies(repo);
const SKIP = new Set(["node_modules", "dist"]);

/** Files under a folder, relative and sorted, without node_modules and dist. */
export function listFiles(dir, sub = "") {
  return readdirSync(join(dir, sub), { withFileTypes: true })
    .filter((e) => !SKIP.has(e.name))
    .flatMap((e) => (e.isDirectory() ? listFiles(dir, join(sub, e.name)) : [join(sub, e.name)]))
    .sort();
}

/** Copy every canonical to its places under `root`; returns how many files were written. */
export function syncShared(root = repo, copies = sharedCopies(root)) {
  let n = 0;
  for (const [canonical, places] of Object.entries(copies.files))
    for (const c of places) (mkdirSync(dirname(join(root, c)), { recursive: true }), copyFileSync(join(root, canonical), join(root, c)), n++);
  for (const [canonical, places] of Object.entries(copies.dirs))
    for (const c of places) {
      rmSync(join(root, c), { recursive: true, force: true });
      for (const f of listFiles(join(root, canonical))) {
        mkdirSync(dirname(join(root, c, f)), { recursive: true });
        copyFileSync(join(root, canonical, f), join(root, c, f));
        n++;
      }
    }
  return n;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const n = syncShared();
  console.log(`copied ${Object.keys(SHARED).length} shared files and ${Object.keys(SHARED_DIRS).length} folders to ${n} places`);
}
