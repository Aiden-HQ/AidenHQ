import { test } from "node:test";
import assert from "node:assert/strict";
import { findPrs } from "../src/merge-queue.mjs";

test("findPrs: GitHub links and org/repo#n, and this server's change requests in either form", () => {
  assert.deepEqual(findPrs("merge https://github.com/acme/app/pull/4, codehost:local/expense-tracker/change/3 and local/notes#2 (acme/app#4 again)"), [
    { repo: "acme/app", number: 4, url: "https://github.com/acme/app/pull/4" },
    { repo: "local/expense-tracker", number: 3, url: "codehost:local/expense-tracker/change/3" },
    { repo: "local/notes", number: 2, url: "codehost:local/notes/change/2" },
  ]);
});
