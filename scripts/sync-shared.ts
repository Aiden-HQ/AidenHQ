#!/usr/bin/env node
// Copies shared code into the services that use it. Each service is its own Docker build context, so it holds a
// byte-identical copy; scripts/test/shared.test.ts fails when one drifts (the official modules' under modules/ included).
//   kernel/sdk/src/{caller,fence}.ts the caller assertion check and the fence, in every module server (src/aidenhq-sdk/)
//   kernel/sdk/src/executor.ts       the executor side of write kinds, in each module server with an executor
//   kernel/sdk/src/tools-client.ts   the box's one MCP client, in the engineer image (lib/tools.ts)
//   kernel/sdk/src/vendor/{proxy,oauth,needs}.ts  the vendor pass-through, in each vendor connection (src/vendor/); needs.ts
//                                    (the needs_owner answer) also in google-workspace-mcp (src/aidenhq-sdk/)
//   kernel/sdk/src/reviewer.ts       the reviewer side of reviewer@1, in the reviewer module's service
//   kernel/sdk/src/kernel-client.ts  the module-to-kernel client, in each module that calls the kernel
//   kernel/sdk/src/checks.ts         how check results are read, in the merge gate (codehost-github) and the grader
//   kernel/sdk/src/paperclip.ts      the one Paperclip HTTP client (lanes through the kernel, or direct), in the board, tasks-mcp and ops-mcp
//   kernel/sdk/src/maintained-repos.ts  maintainer_repos and its per-repo duties, in github-mcp and the code host (src/aidenhq-sdk/)
//   kernel/sdk/src/attribution.ts    the AidenHQ commit trailer and text footer, in github-mcp and the code host (src/aidenhq-sdk/)
//   kernel/sdk/src/box-bundle.ts     a job's branch from its box's bundle, never its .git, in the code host (src/aidenhq-sdk/)
//   kernel/sdk/src/pin-owner.ts      who moves the product pin, in the code host's release train (the kernel's updater imports it)
//   kernel/sdk/src/instance-paths.ts what an apply may land, in the code host (src/aidenhq-sdk/; the kernel and codehost-local import it)
//   kernel/sdk/src/tiers.ts          risk tiers (facts, rules, classify), in code review's service and recipe, the engineer image and the CI template
//   kernel/sdk/src/judge.ts          the judges' models, cross-family choice and model call, in the reviewer, grading and code-review services
//   services/shared/review-files.ts  the changed files as the reviewer reads them, in the reviewer module's service
//   kernel/sdk/src/source-store.ts   the shared-sources writer side, in every source writer
//   kernel/sdk/src/quality.ts        the revert and incident linker, in the board (the kernel's flow DORA imports it)
//   kernel/sdk/src/task-state-types.ts  a task's state as the kernel serves it, in the board
//   kernel/sdk/src/agent-paused.ts   the one paused rule (lifecycle holds), in the board, the Telegram channel and the Fleet Steward
//   services/shared/reason-codes.ts  reason codes on approvals and refusals, in the board
//   services/shared/url-setting.ts   the URL setting check, in the board (the compiler imports the original)
//   modules/apps-platform/design-system/      the design system, in the app starter and the agent computers
//   modules/apps-platform/starter/      the app starter, in the agent computers (a whole folder: SHARED_DIRS)
//   modules/design/eval/                the UI review's regression set, in the agent computers (/opt/aidenhq/design-eval)
//   kernel/sdk/src/{types,engine-io,progress}.ts  the SDK's engine side, in every module with an sdk/ folder
//   modules/engine-opencode/{plugins.json,package.json,package-lock.json}  opencode's curated, locked plugin set, in the session image
//   modules/github/checks/{tests,history}.sh  a change's tests, in codehost-local's `change` check job
//   modules/code-review/recipe/{brief,engines,deepsec,proc,review-checklist,scope,self-review}.ts  an Engineer's pre-publish review, in the engineer image
//   modules/ci/template/.github/{code-review,review-tools,review-checklist}.ts  the review core, in the code review recipe
//   node scripts/sync-shared.ts
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
    // The fleet-steward and code-review services check the caller's assertion on their connections.
    "modules/fleet-steward/service/src",
    "modules/code-review/service/src",
    // The design service checks the caller's assertion on its connection.
    "modules/design/service/src",
    // The grading service checks the tasks module's assertion when it files a rubric, and the owner's router on notify; the
    // grading service, the reviewer and dispatch fence their prompts' data blocks (dataBlock).
    ...(f === "caller.ts" ? ["modules/grading/service/src", "modules/owner-channel/connections/notify/src", "modules/ship/service/src", "modules/maintainer/service/src", "modules/sessions/service/src"] : ["modules/grading/service/src", "modules/ai-reviewer/service/src", "modules/dispatch/service/src", "modules/warehouse/search/src"]),
  ].map((d) => `${d}/aidenhq-sdk/${f}`)])),
  // The module MCP endpoint (tools and a Fleet page view): ship's, the Maintainer's and code review's.
  "modules/ship/service/src/mcp.ts": ["modules/maintainer/service/src/mcp.ts", "modules/code-review/service/src/mcp.ts", "modules/sessions/service/src/mcp.ts", "modules/design/service/src/mcp.ts"],
  // The Fleet pages' shared kit (the common styles and bridge script), inlined into each module's page.html when it is served (mcp.ts pageHtml).
  ...Object.fromEntries(["page-kit.css", "page-kit.js"].map((f) => [`services/shared/${f}`, [`modules/ship/service/src/${f}`, `modules/maintainer/service/src/${f}`, `modules/code-review/service/src/${f}`, `modules/design/service/src/${f}`]])),
  // The box's one MCP client (code mode): the engineer image's /opt/aidenhq/lib/tools.ts, which the in-box `aidenhq` CLI and a
  // session's generated tool files import.
  "kernel/sdk/src/tools-client.ts": ["services/computer/images/engineer/lib/tools.ts"],
  // The executor side of write kinds (executor@1), in each module server that declares an executor.
  "kernel/sdk/src/executor.ts": ["modules/apps-platform/apps-mcp/src/aidenhq-sdk/executor.ts", "modules/primer/connections/primer-mcp/src/aidenhq-sdk/executor.ts", "modules/slack/connections/slack-live/src/aidenhq-sdk/executor.ts", "modules/hubspot/connections/hubspot-mcp/src/aidenhq-sdk/executor.ts", "modules/github/service/src/aidenhq-sdk/executor.ts", "modules/code-review/service/src/aidenhq-sdk/executor.ts"],
  // A change's tests (the secret scan, supply chain, lint, tests and build), run the same for a change request on this server.
  ...Object.fromEntries(["tests.sh", "history.sh"].map((f) => [`modules/github/checks/${f}`, [`modules/codehost-local/checks/${f}`]])),
  // The vendor connections' shared pass-through (owner, 2026-11-18: every connection exposes its vendor's whole MCP server),
  // in each vendor connection's src/vendor/.
  ...Object.fromEntries(["proxy.ts", "oauth.ts", "needs.ts"].map((f) => [`kernel/sdk/src/vendor/${f}`, [...["clickhouse/connections/clickhouse-mcp", "glean/connections/glean-mcp", "grafana/connections/grafana-mcp", "hubspot/connections/hubspot-mcp", "github/connections/github-mcp", "jira/connections/jira-mcp", "primer/connections/primer-mcp", "slack/connections/slack-mcp"].map((d) => `modules/${d}/src/vendor/${f}`),
    // The needs_owner answer, in the one hand-written connection without the vendor proxy.
    ...(f === "needs.ts" ? ["modules/google/connections/google-workspace-mcp/src/aidenhq-sdk/needs.ts"] : [])]])),
  // The reviewer side of reviewer@1, in the reviewer module's service (its own Docker build context).
  "kernel/sdk/src/reviewer.ts": ["modules/ai-reviewer/service/src/aidenhq-sdk/reviewer.ts"],
  // The instance-details scan: the reviewer's code check, and the code-review service that removes them before it files.
  "kernel/sdk/src/instance-details.ts": ["modules/ai-reviewer/service/src/aidenhq-sdk/instance-details.ts", "modules/code-review/service/src/aidenhq-sdk/instance-details.ts"],
  // The eval's pass rule: the kernel's check job and the reviewer's own eval script apply this one copy.
  "kernel/sdk/src/pass-rule.ts": ["modules/ai-reviewer/service/src/aidenhq-sdk/pass-rule.ts"],
  // The one kernel client (design: one Paperclip/kernel client): every module that calls the kernel with its own token.
  "kernel/sdk/src/kernel-client.ts": ["modules/dispatch/service/src/aidenhq-sdk/kernel-client.ts", "modules/github/service/src/aidenhq-sdk/kernel-client.ts", "modules/grading/service/src/aidenhq-sdk/kernel-client.ts", "modules/maintainer/service/src/aidenhq-sdk/kernel-client.ts", "modules/code-review/service/src/aidenhq-sdk/kernel-client.ts", "modules/design/service/src/aidenhq-sdk/kernel-client.ts", "modules/ship/service/src/aidenhq-sdk/kernel-client.ts", "modules/sessions/service/src/aidenhq-sdk/kernel-client.ts", "modules/fleet-steward/service/src/aidenhq-sdk/kernel-client.ts", "modules/chat-lane/connections/lane/src/aidenhq-sdk/kernel-client.ts", "modules/channel-telegram/connections/telegram/src/aidenhq-sdk/kernel-client.ts", "modules/owner-channel/connections/notify/src/aidenhq-sdk/kernel-client.ts"],
  // Risk tiers: code review classifies PRs (its service) and leaves out the same generated files and lockfiles (its recipe, which
  // the engineer image's self-review runs too); the CI template classifies an app repo's PR itself.
  "kernel/sdk/src/tiers.ts": ["modules/code-review/service/src/aidenhq-sdk/tiers.ts", "modules/code-review/recipe/tiers.ts", "services/computer/images/engineer/code-review/tiers.ts", "modules/ci/template/.github/tiers.ts"],
  // The judges' shared library (design §4.4): the reviewer and the grader keep their own contracts and credentials.
  "kernel/sdk/src/judge.ts": ["modules/ai-reviewer/service/src/aidenhq-sdk/judge.ts", "modules/grading/service/src/aidenhq-sdk/judge.ts"],
  // How GitHub check results are read: the merge gate, the PR watcher and the grader.
  "kernel/sdk/src/checks.ts": ["modules/github/service/src/aidenhq-sdk/checks.ts", "modules/grading/service/src/aidenhq-sdk/checks.ts", "modules/ship/service/src/aidenhq-sdk/checks.ts"],
  // The one parser of maintainer_repos (per-repo duties): github-mcp's Maintainer tools and the code host's PR watch read.
  "kernel/sdk/src/maintained-repos.ts": ["modules/github/connections/github-mcp/src/aidenhq-sdk/maintained-repos.ts", "modules/github/service/src/aidenhq-sdk/maintained-repos.ts", "modules/maintainer/service/src/aidenhq-sdk/maintained-repos.ts", "modules/ship/service/src/aidenhq-sdk/maintained-repos.ts"],
  // What closed an issue (the newest ClosedEvent): the code host's issue read for the grader and github-mcp's github_issue_read.
  "kernel/sdk/src/closed-event.ts": ["modules/github/connections/github-mcp/src/aidenhq-sdk/closed-event.ts", "modules/github/service/src/aidenhq-sdk/closed-event.ts", "modules/grading/service/src/aidenhq-sdk/closed-event.ts"],
  "kernel/sdk/src/attribution.ts": ["modules/github/connections/github-mcp/src/aidenhq-sdk/attribution.ts", "modules/github/service/src/aidenhq-sdk/attribution.ts", "modules/ship/service/src/aidenhq-sdk/attribution.ts"],
  // Code churn: the code host's churn pass and backfill (codehost-local calls the original from the kernel).
  "kernel/sdk/src/churn.ts": ["modules/github/service/src/aidenhq-sdk/churn.ts"],
  // A job's branch from its box's bundle, read the one no-follow way: the code host (codehost-local imports the original).
  "kernel/sdk/src/box-bundle.ts": ["modules/github/service/src/aidenhq-sdk/box-bundle.ts"],
  // Who moves the product pin: the kernel's updater and the code host's release train ask this one function.
  "kernel/sdk/src/pin-owner.ts": ["modules/github/service/src/aidenhq-sdk/pin-owner.ts"],
  // What an apply may land and a settings write may touch: the kernel's apply and both code hosts (codehost-local imports the original).
  "kernel/sdk/src/instance-paths.ts": ["modules/github/service/src/aidenhq-sdk/instance-paths.ts"],
  // The changed files' shaping: the code host's plan shapes them for the reviewer, which (and its eval) reads this copy.
  "services/shared/review-files.ts": ["modules/ai-reviewer/service/src/review-files.ts", "modules/github/service/src/review-files.ts"],
  // The reliability checklist's matcher: the CI template's (MIT), used by its code review and by the AI reviewer.
  "modules/ci/template/.github/review-checklist.ts": ["modules/code-review/recipe/review-checklist.ts"],
  // The review core (the CI reviewer's codex runner, its brief and parse, and its read-only repo tools): CI's code-review job
  // and the code review module's recipe run the same code (canonical in the CI template, MIT, copied as is into app repos).
  ...Object.fromEntries(["code-review.ts", "review-tools.ts"].map((f) => [`modules/ci/template/.github/${f}`, [`modules/code-review/recipe/${f}`]])),
  "kernel/sdk/src/source-store.ts": [
    "modules/slack/connections/slack-live/src/source-store.ts",
    "modules/github/connections/github-mcp/src/source-store.ts",
    "modules/hubspot/connections/hubspot-mcp/src/source-store.ts",
    "modules/jira/connections/jira-mcp/src/source-store.ts",
    "modules/meetings/connections/ops-mcp/src/source-store.ts",
    "modules/google/connections/google-workspace-mcp/src/source-store.ts",
    "modules/security/scanner/src/source-store.ts",
    "modules/warehouse/search/src/source-store.ts",
  ],
  // Who said it: a comment posted for someone else is never the owner's words (dispatch, the grader, task_comments, the board).
  "kernel/sdk/src/for-others.ts": ["modules/dispatch/service/src/aidenhq-sdk/for-others.ts", "modules/grading/service/src/aidenhq-sdk/for-others.ts", "modules/tasks/connections/tasks-mcp/src/aidenhq-sdk/for-others.ts", "services/board/src/aidenhq-sdk/for-others.ts"],
  // Whether an agent is paused (Paperclip's lifecycle holds, never its status): the board, the Telegram channel and the Fleet Steward.
  // The one Paperclip client: the board (owner lane), the task tools (agent lane) and ops-mcp (its own key).
  "kernel/sdk/src/paperclip.ts": ["services/board/src/aidenhq-sdk/paperclip.ts", "modules/tasks/connections/tasks-mcp/src/aidenhq-sdk/paperclip.ts", "modules/meetings/connections/ops-mcp/src/aidenhq-sdk/paperclip.ts"],
  "kernel/sdk/src/agent-paused.ts": ["services/board/src/aidenhq-sdk/agent-paused.ts", "modules/channel-telegram/connections/telegram/src/aidenhq-sdk/agent-paused.ts", "modules/fleet-steward/service/src/aidenhq-sdk/agent-paused.ts"],
  // The revert and incident linker: the board's quality report and the kernel's flow DORA (flow.ts imports the original).
  "kernel/sdk/src/quality.ts": ["services/board/src/aidenhq-sdk/quality.ts"],
  // A task's state as GET /v1/tasks/state serves it: the kernel computes it, the board reads it (and its web shows it).
  "kernel/sdk/src/task-state-types.ts": ["services/board/src/aidenhq-sdk/task-state-types.ts"],
  "services/shared/reason-codes.ts": ["services/board/src/reason-codes.ts"],
  "services/shared/url-setting.ts": ["services/board/src/url-setting.ts"],
  // A teammate's name and kit face: one rule for compile, the board and the kernel (docs/configuration.md "teammate").
  "services/shared/teammate-name.ts": ["services/board/src/teammate-name.ts"],
  "services/shared/face-kit.ts": ["services/board/src/face-kit.ts"],
  // A rubric criterion claiming a file's contents lack something: refused wherever a rubric is written (the grading service
  // files and amends; the task tools validate a delegation and an amendment before they send it).
  "services/shared/absence.ts": ["modules/grading/service/src/absence.ts", "modules/tasks/connections/tasks-mcp/src/absence.ts"],
  // The task a delegation was asked to be filed under when the control plane placed it elsewhere (Paperclip's agent
  // task-tree cap): the kernel's delegator, notices and dispatch read it, and the task tools group siblings by it.
  "services/shared/requested-parent.ts": ["modules/tasks/connections/tasks-mcp/src/requested-parent.ts", "modules/dispatch/service/src/requested-parent.ts", "modules/grading/service/src/requested-parent.ts"],
  // The supply-chain checks, version picker and image scan, for app repos (the app CI template is copied into each as it is).
  "scripts/supply-chain/best-version.ts": ["modules/ci/template/.github/supply-chain/best-version.ts", "modules/engineering/skills/supply-chain/best-version.ts", "modules/github/service/src/best-version.ts"],
  "scripts/supply-chain/pins.ts": ["modules/ci/template/.github/supply-chain/pins.ts"],
  "scripts/supply-chain/npm-age.ts": ["modules/ci/template/.github/supply-chain/npm-age.ts"],
  "scripts/supply-chain/image-scan.ts": ["modules/ci/template/.github/supply-chain/image-scan.ts"],
  // An Engineer's review of its own change before it publishes (self-review.ts) runs the check's codex-native engine and brief from the
  // engineer image: its context is its own folder, so it holds the copy (/opt/aidenhq/code-review).
  ...Object.fromEntries(["brief.ts", "engines.ts", "deepsec.ts", "proc.ts", "review-checklist.ts", "scope.ts", "self-review.ts"].map((f) => [`modules/code-review/recipe/${f}`, [`services/computer/images/engineer/code-review/${f}`]])),
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
  // opencode's curated plugin set: the session image installs exactly this list (its build context is the image folder).
  // Its package.json and package-lock.json pin the plugins' whole tree: the image runs `npm ci` on them.
  "modules/engine-opencode/plugins.json": ["services/computer/images/session/plugins.json"],
  "modules/engine-opencode/package.json": ["services/computer/images/session/package.json"],
  "modules/engine-opencode/package-lock.json": ["services/computer/images/session/package-lock.json"],
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
    // The UI review's regression set, so the UI Reviewer runs `node /opt/aidenhq/design-eval/run.ts <suite>` in its computer.
    "modules/design/eval": ["services/computer/images/agent-base/design-eval"],
  };
  return { files, dirs };
}

export const { files: SHARED, dirs: SHARED_DIRS } = sharedCopies(repo);
const SKIP = new Set(["node_modules", "dist"]);

/** Files under a folder, relative and sorted, without node_modules and dist. */
export function listFiles(dir: string, sub = ""): string[] {
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
