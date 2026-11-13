#!/usr/bin/env node
// Copies shared code into the services that use it. Each service is its own Docker build context, so it holds a
// byte-identical copy; scripts/test/shared.test.mjs fails when one drifts.
//   services/shared/agent-auth.ts    run identity and grants, in every service that checks callers
//   services/shared/source-store.ts  the shared-sources writer side, in every source writer
//   services/shared/reason-codes.ts  reason codes on approvals and refusals, in the board
//   services/shared/url-setting.ts   the URL setting check, in the board (the compiler imports the original)
//   node scripts/sync-shared.mjs
import { copyFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const SHARED = {
  "services/shared/agent-auth.ts": [
    "services/apps-mcp/src/agent-auth.ts",
    "services/board/src/agent-auth.ts",
    "modules/github/connections/github-mcp/src/agent-auth.ts",
    "modules/glean/connections/glean-mcp/src/agent-auth.ts",
    "modules/google/connections/google-workspace-mcp/src/agent-auth.ts",
    "modules/jira/connections/jira-mcp/src/agent-auth.ts",
    "modules/meetings/connections/ops-mcp/src/agent-auth.ts",
    "modules/owner-channel/connections/slack-live-mcp/src/agent-auth.ts",
    "modules/primer/connections/primer-mcp/src/agent-auth.ts",
    "modules/slack/connections/slack-mcp/src/agent-auth.ts",
  ],
  "services/shared/source-store.ts": [
    "modules/owner-channel/connections/slack-live-mcp/src/source-store.ts",
    "modules/github/connections/github-mcp/src/source-store.ts",
    "modules/jira/connections/jira-mcp/src/source-store.ts",
    "modules/meetings/connections/ops-mcp/src/source-store.ts",
    "modules/google/connections/google-workspace-mcp/src/source-store.ts",
    "modules/security/scanner/src/source-store.ts",
  ],
  "services/shared/reason-codes.ts": ["services/board/src/reason-codes.ts"],
  "services/shared/url-setting.ts": ["services/board/src/url-setting.ts"],
  // The supply-chain checks and version picker, for app repos (the app CI template is copied into each as it is).
  "scripts/supply-chain/best-version.mjs": ["modules/core/templates/ci/.github/supply-chain/best-version.mjs"],
  "scripts/supply-chain/pins.mjs": ["modules/core/templates/ci/.github/supply-chain/pins.mjs"],
  "scripts/supply-chain/npm-age.mjs": ["modules/core/templates/ci/.github/supply-chain/npm-age.mjs"],
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let n = 0;
  for (const [canonical, copies] of Object.entries(SHARED)) for (const c of copies) (copyFileSync(join(repo, canonical), join(repo, c)), n++);
  console.log(`copied ${Object.keys(SHARED).length} shared files to ${n} places`);
}
