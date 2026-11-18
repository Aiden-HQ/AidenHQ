#!/usr/bin/env node
// Copies shared code where an import can't reach it: a Docker build context, a template copied into app repos, an agent
// computer's image. Each copy is byte-identical; scripts/test/shared.test.mjs fails when one drifts. Module servers import
// the SDK from npm instead (@aidenhq/sdk, kernel/sdk/README.md).
//   kernel/sdk/src/caller.ts, executor.ts  in the two images that install no dependencies (grading, codehost-github)
//   kernel/sdk/src/reviewer.ts       the reviewer side of reviewer@1, in the reviewer module's service
//   kernel/sdk/src/judge.ts          the judges' models, cross-family choice and model call, in the reviewer and grading services
//   services/shared/review-files.mjs  the changed files as the reviewer reads them, in the reviewer module's service
//   services/shared/reason-codes.ts  reason codes on approvals and refusals, in the board
//   services/shared/url-setting.ts   the URL setting check, in the board and the runner (the compiler imports the original)
//   modules/apps-platform/design-system/      the design system, in the app starter and the agent computers
//   modules/apps-platform/starter/      the app starter, in the agent computers (a whole folder: SHARED_DIRS)
//   kernel/sdk/src/{types,engine-io,progress}.ts  the SDK's engine side, in every module with an sdk/ folder
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
  // Module servers import the SDK from npm (@aidenhq/sdk). These two images install no dependencies, so they keep a copy.
  "kernel/sdk/src/caller.ts": ["modules/grading/service/src/aidenhq-sdk/caller.ts"],
  "kernel/sdk/src/executor.ts": ["modules/codehost-github/service/src/aidenhq-sdk/executor.ts"],
  // The reviewer side of reviewer@1, in the reviewer module's service (its own Docker build context).
  "kernel/sdk/src/reviewer.ts": ["modules/ai-reviewer/service/src/aidenhq-sdk/reviewer.ts"],
  // The judges' shared library (design §4.4): the reviewer and the grader keep their own contracts and credentials.
  "kernel/sdk/src/judge.ts": ["modules/ai-reviewer/service/src/aidenhq-sdk/judge.ts", "modules/grading/service/src/aidenhq-sdk/judge.ts"],
  // The changed files' shaping (the runner imports the canonical copy; the eval and the reviewer's verdicts use this one).
  "services/shared/review-files.mjs": ["modules/ai-reviewer/service/src/review-files.mjs"],
  // The reliability checklist's matcher: the CI template's (MIT), used by its code review and by the AI reviewer.
  "modules/ci/template/.github/review-checklist.mjs": ["modules/ai-reviewer/service/src/review-checklist.mjs"],
  "services/shared/reason-codes.ts": ["services/board/src/reason-codes.ts"],
  "services/shared/url-setting.ts": ["services/board/src/url-setting.ts", "services/runner/src/url-setting.ts"],
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
