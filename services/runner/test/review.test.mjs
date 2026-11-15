// The reviewer's plumbing with a fake model: a refusal is retried once on the other model, then escalated; a
// DeepSeek requester never gets DeepSeek; oversize or missing diffs go back to the agent without a call; the panel needs
// two families to approve.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { CODE_CODES, DEEPSEEK, GLM, LUNA, MAX_DIFF, MAX_FILES, MODEL_CODES, fileContext, review } from "../src/review.mjs";
import { REPO_ROOT } from "../src/config.mjs";
import { padCase } from "./case-pad.mjs";
import { REVIEW_CODES } from "../../shared/reason-codes.ts";

const card = { action: "pr", rule: "outside-pr", target: "acme/app feat/x", sentence: "Open a PR", reason: "outside the agents org" };
const asker = (answers) => {
  const asked = [];
  return { asked, ask: async (model) => (asked.push(model), answers[asked.length - 1]) };
};
const ok = { content: JSON.stringify({ decision: "approve", reason: "matches the ask", second_review: false }) };
const flagged = { content: JSON.stringify({ decision: "approve", reason: "a gate fix as asked", second_review: true }) };
const no = { content: JSON.stringify({ decision: "reject", reason_code: "gate_change", reason: "it fails open", second_review: true }) };

test("the panel: code's flag or the reviewer's own needs a second family to approve; a split is the owner's", async () => {
  // Code says authority-expanding: Luna, then GLM (never DeepSeek for a DeepSeek requester, never OpenAI after Luna).
  let r = asker([ok, ok]);
  const both = await review({ card, diff: "+x", policy: "p", requesterModel: "deepseek/deepseek-flash", ask: r.ask, panel: true });
  assert.deepEqual(r.asked, [LUNA, GLM]);
  assert.equal(both.decision, "approve");
  assert.equal(both.second, GLM);
  // The first reviewer's own flag adds the second reviewer; a missing flag counts as set.
  r = asker([flagged, no]);
  const split = await review({ card, diff: "+x", policy: "p", ask: r.ask });
  assert.deepEqual([split.decision, split.code], ["escalate", "panel_split"]);
  r = asker([{ content: JSON.stringify({ decision: "approve", reason: "fine" }) }, ok]);
  assert.equal((await review({ card, diff: "+x", policy: "p", ask: r.ask })).second, GLM, "no flag in the answer: asked anyway");
  // A first reject never needs the second: back to the agent.
  r = asker([no]);
  assert.equal((await review({ card, diff: "+x", policy: "p", ask: r.ask, panel: true })).decision, "reject");
  assert.equal(r.asked.length, 1);
  // Not flagged by anyone: one reviewer decides.
  r = asker([ok]);
  const one = await review({ card, diff: "+x", policy: "p", ask: r.ask });
  assert.deepEqual([one.decision, one.second, r.asked.length], ["approve", undefined, 1]);
  // A requirement the first reviewer added is recorded before the second is asked: a second-reviewer timeout keeps it.
  const marked = [];
  r = asker([flagged]);
  const timeout = await review({ card, diff: "+x", policy: "p", onPanel: async () => marked.push("panel"), ask: async (m) => (r.asked.push(m), r.asked.length === 1 ? flagged : Promise.reject(new Error("timeout"))) });
  assert.deepEqual([timeout.code, marked], ["reviewer_failed", ["panel"]]);
  // On the retry the card carries it (the runner passes the card's panel): a first "no second review" can't drop it.
  r = asker([ok, ok]);
  assert.equal((await review({ card, diff: "+x", policy: "p", panel: true, ask: r.ask })).second, GLM);
  // Couldn't record it: no second call, retried later.
  r = asker([flagged, ok]);
  const unrecorded = await review({ card, diff: "+x", policy: "p", onPanel: async () => { throw new Error("board down"); }, ask: r.ask });
  assert.deepEqual([unrecorded.code, r.asked.length], ["reviewer_failed", 1]);
  // Earlier rejections are attached as data.
  let prompt;
  await review({ card, diff: "+x", policy: "p", previous: ["it fails open"], ask: async (_m, p) => ((prompt = p), ok) });
  assert.match(prompt.user, /<<<EARLIER_REJECTIONS\n1\. it fails open/);
});

test("a refusal goes to the other model; the model that decided is named", async () => {
  const { asked, ask } = asker([{ content: "", refusal: "I can't help with exploits" }, ok]);
  assert.deepEqual(await review({ card, diff: "+x", policy: "p", ask }), { decision: "approve", code: "in_scope", reason: "matches the ask", model: DEEPSEEK, flag: false });
  assert.deepEqual(asked, [LUNA, DEEPSEEK]);
});

test("unsure escalates to the owner, coded reviewer_unsure, with its reason", async () => {
  const { ask } = asker([{ content: JSON.stringify({ decision: "unsure", reason_code: "reviewer_unsure", reason: "the diff is cut short" }) }]);
  assert.deepEqual(await review({ card, diff: "+x", policy: "p", ask }), { decision: "escalate", code: "reviewer_unsure", reason: "the diff is cut short", model: LUNA, flag: true });
});

test("the reviewer's codes are exactly the shared REVIEW_CODES (services/shared/reason-codes.ts)", () => {
  assert.deepEqual([...new Set([...MODEL_CODES, ...CODE_CODES])].sort(), [...REVIEW_CODES].sort());
});

test("both refuse (or answer off-schema): escalated as 'reviewer refused'", async () => {
  const { ask } = asker([{ content: "Sure! Looks fine." }, { content: JSON.stringify({ decision: "maybe", reason: "x" }) }]);
  assert.equal((await review({ card, diff: "+x", policy: "p", ask })).reason, "reviewer refused");
});

test("a DeepSeek requester is reviewed by Luna only, an OpenAI requester by DeepSeek only", async () => {
  const { asked, ask } = asker([{ refusal: "no" }]);
  const v = await review({ card, diff: "+x", policy: "p", requesterModel: "openrouter/~deepseek/deepseek-flash-latest", ask });
  assert.deepEqual(asked, [LUNA]);
  assert.equal(v.decision, "escalate");
  const glm = asker([ok]);
  await review({ card, diff: "+x", policy: "p", requesterModel: "openai/gpt-6-luna", ask: glm.ask });
  assert.deepEqual(glm.asked, [DEEPSEEK], "an OpenAI requester is reviewed by DeepSeek only");
});

test("too large or missing: back to the agent; a failed call: reviewer_failed (the runner retries it)", async () => {
  const never = async () => assert.fail("not asked");
  const big = await review({ card, diff: "x".repeat(MAX_DIFF + 1), policy: "p", ask: never });
  assert.deepEqual([big.decision, big.code], ["reject", "too_large"]);
  assert.match(big.reason, new RegExp(`the diff is ${MAX_DIFF + 1} characters, over the ${MAX_DIFF}-character limit`), "the size and the limit, not \"can't read\"");
  assert.equal((await review({ card, diff: "", policy: "p", ask: never })).decision, "reject");
  const failed = await review({ card, diff: "+x", policy: "p", ask: async () => { throw new Error("timeout"); } });
  assert.match(failed.reason, /failed \(timeout\)/);
  assert.equal(failed.code, "reviewer_failed");
});

test("changed files go to the reviewer whole, as fenced data; inert media is named with type and size, not escalated", async () => {
  const routes = { name: "acme/app src/routes.ts", text: "export const NEEDS_TOKEN = [\"/api/agent\"];" };
  const files = fileContext([routes, { name: "acme/app public/logo.png", text: "\u0000PNG" + "x".repeat(2000) }, { name: "acme/app fonts/inter.woff2", text: "wOF2\u0000" }]);
  assert.deepEqual(files.leftOut, []);
  const { asked, ask } = asker([ok]);
  let prompt;
  await review({ card, diff: "+x", files, policy: "p", ask: async (m, p) => ((prompt = p), ask(m)) });
  assert.match(prompt.user, /<<<FILES\n#### acme\/app src\/routes.ts\nexport const NEEDS_TOKEN/);
  assert.match(prompt.user, /acme\/app public\/logo.png: binary, not shown; png file, about 2 KB/);
  assert.equal(asked.length, 1);
});

// The reported bug: a card whose changed set is large plain text was rejected as unreadable, so the agent could never
// get the change approved, however small its diff. Plain text over the budget is named with its size and the limit,
// and the reviewer judges it on the diff.
test("plain text over the whole-file budget reaches a verdict naming its size and the limit, judged from the diff", async () => {
  const files = fileContext([
    { name: "acme/app modules/core/templates/app/package-lock.json", text: "{\n" + "  \"x\": 1,\n".repeat(25_000) + "}\n" },
    { name: "acme/app README.md", text: "# App starter\n" },
  ]);
  assert.deepEqual(files.leftOut, [], "large plain text is never unreadable");
  assert.equal(files.oversized.length, 1);
  const { asked, ask } = asker([ok]);
  let prompt;
  const v = await review({ card, diff: "+x", files, policy: "p", ask: async (m, p) => ((prompt = p), ask(m)) });
  assert.equal(v.decision, "approve");
  assert.equal(asked.length, 1);
  assert.match(prompt.user, /package-lock\.json: \d+-character text file, larger on its own than the 200000-character budget/);
  assert.match(v.reason, new RegExp(`Judged from the DIFF, not in full: .*package-lock\\.json \\(\\d+ characters\\) did not fit the ${MAX_FILES}-character budget`));
  assert.doesNotMatch(v.reason, /can't read/);
});

// The incident itself: the app starter's two byte-identical lockfiles, 121,215 characters each, changed together.
test("the paired 121,215-character app-starter lockfiles reach a verdict naming their size, not \"can't read\"", async () => {
  const lock = (name, n = 121_215) => ({ name, text: ("{\n  \"lockfileVersion\": 3,\n" + "  \"node_modules/x\": { \"version\": \"1.0.0\" },\n".repeat(n)).slice(0, n - 2) + "}\n" });
  const pair = [lock("Aiden-HQ/AidenHQ modules/core/templates/app/package-lock.json"), lock("Aiden-HQ/AidenHQ services/computer/images/agent-base/app-starter/package-lock.json")];
  assert.equal(pair[0].text.length, 121_215);
  assert.equal(pair[1].text, pair[0].text, "the app-starter copies are byte-identical");
  const files = fileContext(pair);
  assert.deepEqual(files.leftOut, [], "both are plain text: neither sends the card back");
  assert.equal(files.oversized.length, 1, "the second one no longer fits the budget");
  const { asked, ask } = asker([ok]);
  let prompt;
  const v = await review({ card, diff: "+x", files, policy: "p", ask: async (m, p) => ((prompt = p), ask(m)) });
  assert.equal(v.decision, "approve");
  assert.equal(asked.length, 1);
  assert.match(prompt.user, /services\/computer\/images\/agent-base\/app-starter\/package-lock\.json: 121215-character text file/);
  assert.match(v.reason, /Judged from the DIFF, not in full: .*121215 characters/);
  assert.doesNotMatch(v.reason, /can't read/);
});

test("the real app-starter lockfiles are byte-identical, and the pair still reaches a verdict", async () => {
  const names = ["modules/core/templates/app/package-lock.json", "services/computer/images/agent-base/app-starter/package-lock.json"];
  const texts = names.map((n) => readFileSync(join(REPO_ROOT, n), "utf8"));
  assert.equal(texts[1], texts[0], "the two copies are byte-identical");
  const files = fileContext(names.map((name, i) => ({ name: `Aiden-HQ/AidenHQ ${name}`, text: texts[i] })));
  assert.deepEqual(files.leftOut, []);
  const { asked, ask } = asker([ok]);
  const v = await review({ card, diff: "+x", files, policy: "p", ask });
  assert.equal(v.decision, "approve");
  assert.equal(asked.length, 1);
  assert.ok(texts[0].length > MAX_FILES / 2, "each is over half the budget, so the second cannot be shown whole");
  assert.match(v.reason, new RegExp(`Judged from the DIFF, not in full: .*${texts[0].length} characters`));
});

test("an executable or opaque binary, or a file never read, goes back to the agent naming it and what to do", async () => {
  const elf = "\u007fELF\u0000";
  const files = fileContext([
    { name: "acme/app lib/native.so", text: elf },
    { name: "acme/app public/cat.png", text: elf }, // an ELF dressed as an image
    { name: "acme/app vendor/blob.dat", text: "\u0000\u0001" },
    { name: "acme/app big.ts", text: "y".repeat(MAX_FILES + 1) },
    { name: "acme/app past-the-cap.ts", text: null },
  ]);
  assert.deepEqual(files.leftOut, [
    "acme/app lib/native.so (binary, 5 bytes)",
    "acme/app public/cat.png (binary, 5 bytes)",
    "acme/app vendor/blob.dat (binary, 2 bytes)",
    "acme/app past-the-cap.ts (not read, size unknown)",
  ], "only what cannot be read is left out; the big text file is reviewed on the diff");
  assert.equal(files.oversized.length, 1);
  const never = async () => assert.fail("not asked");
  const v = await review({ card, diff: "+x", files, policy: "p", ask: never });
  assert.deepEqual([v.decision, v.code], ["reject", "files_not_shown"]);
  assert.match(v.reason, /- acme\/app lib\/native\.so \(binary, 5 bytes\)/);
  assert.match(v.reason, new RegExp(`Plain text is read up to ${MAX_FILES} characters per changed file`));
  assert.match(v.reason, /Take the binary out of the change, or split the change so every changed file is plain text within that limit, and file the card again/);
  assert.doesNotMatch(v.reason, /big\.ts/, "plain text over the budget is not named as unreadable");
});

// Every blocking file is named, one line each with its size: "and N more" sent the agent back without knowing which
// file to fix, and a comma-joined list is harder to act on than a list. The count says how many.
test("a rejection names every blocking file on its own line, with its size and the count", async () => {
  const binaries = Array.from({ length: 14 }, (_, i) => ({ name: `acme/app native/lib-${String(i).padStart(2, "0")}.so`, text: "\u007fELF\u0000" }));
  const v = await review({ card, diff: "+x", files: fileContext(binaries), policy: "p", ask: async () => assert.fail("not asked") });
  assert.deepEqual([v.decision, v.code], ["reject", "files_not_shown"]);
  assert.match(v.reason, /^changed files the reviewer can't read \(14 files\)\./);
  const lines = v.reason.split("\n").filter((l) => l.startsWith("- "));
  assert.equal(lines.length, 14, "one line per blocking file, all of them");
  for (const { name } of binaries) {
    const line = lines.find((l) => l.includes(name));
    assert.ok(line, `names ${name}`);
    assert.match(line, new RegExp(`${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\(binary, 5 bytes\\)$`), `has the size: ${line}`);
  }
  assert.doesNotMatch(v.reason, /and \d+ more/);
  // The board keeps 2,000 characters of a note: the limit and the next step come before the list, so a crop at the tail
  // never takes them.
  assert.ok(v.reason.indexOf("file the card again") < v.reason.indexOf("\n- "), "the limit and the next step lead the note");
});

test("a real ELF beside the paired lockfiles is the file named as blocking", async () => {
  const lock = "{\n  \"lockfileVersion\": 3\n}\n".padEnd(121_215, " ");
  const files = fileContext([
    { name: "Aiden-HQ/AidenHQ modules/core/templates/app/package-lock.json", text: lock },
    { name: "Aiden-HQ/AidenHQ services/computer/images/agent-base/app-starter/package-lock.json", text: lock },
    { name: "Aiden-HQ/AidenHQ services/computer/images/agent-base/agent-browser", text: "\u007fELF\u0000\u0001" },
  ]);
  const v = await review({ card, diff: "+x", files, policy: "p", ask: async () => assert.fail("not asked") });
  assert.deepEqual([v.decision, v.code], ["reject", "files_not_shown"]);
  assert.match(v.reason, /agent-browser \(binary, 6 bytes\)/);
  assert.doesNotMatch(v.reason, /package-lock\.json/);
});

// A planted case is a changed file in every PR that edits it: one over the diff cap (150,000 characters) would make its
// own PR unreviewable, which is what happened to the fixture this rule was added for. Keep every case far below that.
test("no planted reviewer case file is over 32,000 bytes on disk", () => {
  const dir = join(REPO_ROOT, "services/runner/test/reviewer-cases");
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".json"))) {
    const size = statSync(join(dir, f)).size;
    assert.ok(size <= 32_000, `${f} is ${size} bytes on disk (limit 32000): generated text belongs in padTo, not in the file`);
  }
});

// The case that reproduces the incident, small on disk: each file pads to the real lockfile's 121,215 characters, and the
// pair is byte-identical, as the app starter's two copies are.
test("case 36 pads to the 121,215-character app-starter lockfile pair from a small file", () => {
  const path = join(REPO_ROOT, "services/runner/test/reviewer-cases/36-clean-paired-lockfile-bump.json");
  assert.ok(statSync(path).size <= 32_000);
  const { files } = padCase(JSON.parse(readFileSync(path, "utf8")));
  assert.deepEqual(files.map((f) => f.text.length), [121_215, 121_215]);
  assert.equal(files[1].text, files[0].text);
  assert.deepEqual(fileContext(files).leftOut, [], "the pair is plain text: nothing is unreadable");
});
