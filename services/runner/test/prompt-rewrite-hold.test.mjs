// The shared rule an Engineer reads before opening an app PR: while a large rewrite is open, the files it replaces are
// held (small fixes into the page layer it replaces cost the rewrite a rebase and a fresh code and design review).
import { test } from "node:test";
import assert from "node:assert/strict";
import { firstPrompt } from "../src/prompt.mjs";

const prompt = () =>
  firstPrompt({ user: "Dana", task: { identifier: "PEN-1", title: "A fix", description: "" }, workspace: "/w", repos: [], instructions: "Do it." });

test("an open large rewrite holds the files it replaces", () => {
  const p = prompt();
  assert.match(p, /\*\*Large rewrites hold the files they replace\.\*\*/);
  assert.match(p, /waits until the rewrite merges, or targets the rewrite branch/);
  assert.match(p, /do not open a second PR into the default branch against those files/);
  assert.match(p, /re-confirmed as still needed against the new code before it is redone/);
  assert.match(p, /routes, delegates or nudges app work checks for an open large rewrite first/);
});
