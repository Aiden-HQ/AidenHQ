// The local code host's registration and its merge refusals, as rules (src/kinds.ts, src/refuse.ts): a local-only install has
// codehost-local's kinds without GitHub, and a merge never lands a change whose head moved, whose checks aren't green on
// this head and base, or whose base moved under it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { LOCAL_KINDS } from "../src/host.ts";
import { baseMoved, checksNotGreen, headMoved } from "../src/refuse.ts";

const SHA = (n: string) => n.repeat(40).slice(0, 40);
const url = "codehost:local/hello/change/1";

test("codehost-local registers push, pr, merge and close (and create_repo), owned by its own module and executed in process", () => {
  const kinds = Object.keys(LOCAL_KINDS).sort();
  assert.deepEqual(kinds, ["codehost-local.close", "codehost-local.create_repo", "codehost-local.merge", "codehost-local.pr", "codehost-local.push"]);
  for (const k of Object.values(LOCAL_KINDS)) {
    assert.equal(k.module, "codehost-local");
    // The module's own executor, in the kernel's process: no service URL and no service key, so nothing of GitHub.
    assert.equal(k.executor, undefined);
    assert.equal(k.floor, 0);
    // Every kind carries its args schema and its card, so a plan validates and the reviewer reads a diff.
    assert.ok(k.args, "an args schema");
    assert.deepEqual(k.card, { target: "{{target}}", sentence: "{{sentence}}", details: "{{diff}}" });
  }
  // Its args name only this server's org: a local kind can't act on a GitHub repo.
  assert.match(JSON.stringify(LOCAL_KINDS["codehost-local.merge"]!.args), /\^local\//);
});

test("a local merge refuses a head that moved, a check missing or not green on that head, and a base that moved", () => {
  // head-moved: the merge is bound to the head it was asked for; the change's head is another one.
  assert.equal(headMoved(url, SHA("a"), SHA("a")), undefined);
  const moved = headMoved(url, SHA("b"), SHA("a"));
  assert.match(String(moved), /head-moved/);
  assert.match(String(moved), new RegExp(SHA("a").slice(0, 12)));

  // checks-not-green: no check at all, a red one, one that couldn't run, or one still running past the wait.
  assert.equal(checksNotGreen([{ ok: true, pending: false }, { ok: true, pending: false }], false), undefined);
  assert.equal(checksNotGreen([{ ok: true, pending: false }, { ok: false, pending: true }], false), undefined, "a running check is not refused at plan time");
  assert.match(String(checksNotGreen([], true)), /checks-not-green/);
  assert.match(String(checksNotGreen([{ ok: false, pending: false, summary: "exit 1" }], true)), /checks-not-green: a required check failed/);
  assert.match(String(checksNotGreen([{ ok: false, pending: false, missing: true }], true)), /couldn't run/);
  assert.match(String(checksNotGreen([{ ok: false, pending: true }], true)), /didn't finish in time/);

  // conflict: the compare-and-swap on the base ref finds it moved.
  assert.equal(baseMoved(url, SHA("c"), SHA("c")), undefined);
  assert.match(String(baseMoved(url, SHA("c"), SHA("d"))), /conflict/);
});
