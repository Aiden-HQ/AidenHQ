// The answer claim (answers.ts): once per open owner wait, never for a replaced one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createAnswers } from "../src/answers.ts";

const SINCE = "2026-11-24T10:00:00.000Z";
const owner = { who: "owner", why: "owner_wait", ref: "wait:t1", since: SINCE };
function setup(row = { task: "t1", wait_since: SINCE, attention: [owner] }) {
  const s = { row: row as { task: string; wait_since?: string; attention: unknown[] } | undefined };
  return { s, answers: createAnswers({ db: new DatabaseSync(":memory:"), states: { read: () => ({ tasks: s.row ? [s.row] : [] }) } as never }) };
}

test("claim succeeds once for the open owner wait", () => {
  const { answers } = setup();
  assert.equal(answers.claim("t1", SINCE, "board"), "ok");
  assert.equal(answers.claim("t1", SINCE, "telegram"), "taken");
});

test("claim refuses a stale wait", () => {
  const { s, answers } = setup();
  assert.equal(answers.claim("t1", "2026-11-24T09:00:00.000Z", "board"), "stale");
  s.row = { task: "t1", attention: [] };
  assert.equal(answers.claim("t1", SINCE, "board"), "stale");
});

test("release lets the same wait be claimed again", () => {
  const { answers } = setup();
  assert.equal(answers.claim("t1", SINCE, "board"), "ok");
  answers.release("t1", SINCE, "telegram");
  assert.equal(answers.claim("t1", SINCE, "telegram"), "taken");
  answers.release("t1", SINCE, "board");
  assert.equal(answers.claim("t1", SINCE, "board"), "ok");
});
