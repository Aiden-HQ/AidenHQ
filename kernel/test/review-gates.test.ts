// The write-review decision over its combinations: every record kind x panel x ai_review_code x requester reaches a terminal
// state within a few review passes, and no pass is refused twice with the same reason (a fail-closed gate that loops, as
// ai_review_code's code approval did on a panel record, jams its card for hours with nothing alerting).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRecords } from "../src/records.ts";
import { createWrites } from "../src/writes.ts";
import { createResolver } from "../src/net.ts";

const PASSES = 3; // a first review, a panel's second, and one more
const MANDATORY = "acme/app";
const kinds = ["github.pr", "github.push", "code-review.post"];
const requesters = {
  agent: { agent: "ag-ada", key: "ada", name: "Ada", roles: [], kind: "job" },
  service: { agent: "", key: "code-review", name: "code-review", roles: [], kind: "module", module: "code-review" },
};
const modes = ["all", "unless_code_review_mandatory", "none"];

for (const kind of kinds) for (const panel of [true, false]) for (const mode of modes) for (const who of Object.keys(requesters)) {
  test(`${kind} panel=${panel} ai_review_code=${mode} requester=${who} reaches a terminal outcome`, async () => {
    const records = openRecords(join(mkdtempSync(join(tmpdir(), "review-gates-")), "kernel.db"));
    // The model reviewer approves; asked as a panel it brings its second approval (what ai-reviewer's panelVotes returns).
    const asked: boolean[] = [];
    const writes = createWrites({
      records, secret: () => "", resolver: createResolver(), connections: () => ({}), replay: async () => ({ ok: false, text: "" }),
      registry: () => ({ [kind]: { module: kind.split(".")[0]!, floor: 0, tools: [] } }), reviewCode: () => ({ mode, mandatory: [MANDATORY] }),
      reviews: { request: async (q: { panel?: boolean }) => (asked.push(Boolean(q.panel)), { decision: "approve", code: "in_scope", reason: "fine", model: "~acme/model-a", ...(q.panel ? { second: "~acme/model-b", whole: true } : {}) }) } as never,
      onTask: { open: async () => true, notify: async () => {} },
    });
    const r = records.file({
      kind, module: kind.split(".")[0]!, args: {}, targets: kind.startsWith("github.") ? { [`${MANDATORY} feat`]: { repo: MANDATORY } } : {}, executor: { module: kind.split(".")[0]! }, policy: "p",
      card: { sentence: "Do it.", changes: "c", reads: "r", cost: "none", details: "+x" }, requester: requesters[who as keyof typeof requesters], task: "TASK-1", tier: 1, merit: 1, panel, review_first: null, rule: null, state: "review",
    });
    const refusals: string[] = [];
    for (let pass = 0; pass < PASSES && records.get(r.id)!.state === "review"; pass++) {
      const out = await writes.review(r.id, { input: { tier: 1, rule: "x", reason: "x" }, request: { card: {} } });
      if (out.refused) assert.ok(!refusals.includes(out.refused), `refused the same way twice: ${out.refused}`);
      if (out.refused) refusals.push(out.refused);
    }
    const state = records.get(r.id)!.state;
    assert.notEqual(state, "review", `still in review after ${PASSES} passes (refusals: ${refusals.join(" | ")})`);
    // The reviewer approves, so the record is approved (then claimed, done or failed by its executor), never the owner's or rejected.
    assert.ok(["approved", "claimed", "done", "failed"].includes(state), state);
    // A push or PR on a repo code review gates (and never a panel record) is code's approval, unasked; everything else is asked as a panel exactly when it is one.
    const code = !panel && kind.startsWith("github.") && mode !== "all";
    assert.deepEqual(asked, code ? [] : [panel], `reviewer calls (${state})`);
  });
}
