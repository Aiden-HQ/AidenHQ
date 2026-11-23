// The write-review decision over its combinations: every record kind x ai_review_code x requester x reviewer answer
// (approve, or a failed review) reaches a terminal state within a few review passes, and no pass is refused twice with the
// same reason (a fail-closed gate that loops jams its card for hours with nothing alerting).
import { mock, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRecords } from "../src/records.ts";
import { createWrites } from "../src/writes.ts";
import { createResolver } from "../src/net.ts";
import { RETRY_MS } from "../src/tier.ts";

mock.timers.enable({ apis: ["Date"], now: Date.now() });

const PASSES = 3; // a first review, its one retry, and one more
const MANDATORY = "acme/app";
const kinds = ["github.pr", "github.push", "code-review.post"];
const requesters = {
  agent: { agent: "ag-ada", key: "ada", name: "Ada", roles: [], kind: "job" },
  service: { agent: "", key: "code-review", name: "code-review", roles: [], kind: "module", module: "code-review" },
};
const modes = ["all", "unless_code_review_mandatory", "none"];

for (const kind of kinds) for (const failing of [true, false]) for (const mode of modes) for (const who of Object.keys(requesters)) {
  test(`${kind} reviewer_failing=${failing} ai_review_code=${mode} requester=${who} reaches a terminal outcome`, async () => {
    const records = openRecords(join(mkdtempSync(join(tmpdir(), "review-gates-")), "kernel.db"));
    // The model reviewer approves, or every review fails (the kernel then fails open after one retry).
    let asked = 0;
    const writes = createWrites({
      records, secret: () => "", resolver: createResolver(), connections: () => ({}), replay: async () => ({ ok: false, text: "" }),
      registry: () => ({ [kind]: { module: kind.split(".")[0]!, floor: 0, tools: [] } }), reviewCode: () => ({ mode, mandatory: [MANDATORY] }),
      reviews: { request: async () => { asked++; if (failing) throw new Error("timeout"); return { decision: "approve", code: "clean", reason: "fine", model: "~acme/model-a" }; } } as never,
      onTask: { open: async () => true, notify: async () => {} },
    });
    const r = records.file({
      kind, module: kind.split(".")[0]!, args: {}, targets: kind.startsWith("github.") ? { [`${MANDATORY} feat`]: { repo: MANDATORY } } : {}, executor: { module: kind.split(".")[0]! }, policy: "p",
      card: { sentence: "Do it.", changes: "c", reads: "r", cost: "none", details: "+x" }, requester: requesters[who as keyof typeof requesters], task: "TASK-1", tier: 1, merit: 1, rule: null, state: "review",
    });
    const refusals: string[] = [];
    for (let pass = 0; pass < PASSES && records.get(r.id)!.state === "review"; pass++) {
      if (writes.retryAt(r.id)) mock.timers.tick(RETRY_MS);
      const out = await writes.review(r.id, { request: { card: {} } });
      if (out.refused) assert.ok(!refusals.includes(out.refused), `refused the same way twice: ${out.refused}`);
      if (out.refused) refusals.push(out.refused);
    }
    const state = records.get(r.id)!.state;
    assert.notEqual(state, "review", `still in review after ${PASSES} passes (refusals: ${refusals.join(" | ")})`);
    // The reviewer approves, so the record is approved (then claimed, done, failed or stale by its executor: this fixture's kind
    // has none to plan it again), never the owner's or rejected.
    assert.ok(["approved", "claimed", "done", "failed", "stale"].includes(state), state);
    // A push or PR on a repo code review gates is code's approval, unasked; everything else is asked (twice when it fails).
    const code = kind.startsWith("github.") && mode !== "all";
    assert.equal(asked, code ? 0 : failing ? 2 : 1, `reviewer calls (${state})`);
  });
}
