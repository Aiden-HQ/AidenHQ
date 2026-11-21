// The grader's reads go through the kernel's typed read op; a missing file or job is null.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createGithub } from "../service/src/github.ts";

const fake = (answer: (body: any) => string | Promise<string>) => {
  const calls: { path: string; body: any }[] = [];
  const kernel = async (_method: string, path: string, body: any) => (calls.push({ path, body }), answer(body));
  const text = async (path: string, body: any) => {
    calls.push({ path, body });
    try { return await answer(body); } catch (e) { throw e; }
  };
  return { gh: createGithub({ kernel, text }), calls };
};

test("a file and a job log are read through the read op at the exact commit, and a missing one is null", async () => {
  const { gh, calls } = fake((b) => {
    if (b.kind === "file" && b.ref === "a".repeat(40)) return "{\"suites\":[]}";
    if (b.kind === "log" && b.id === 42) return "Shard 1: kernel#1\n##[group]kernel#1 (exit 0, 33s)";
    throw new Error("kernel POST /v1/codehost/read → 404");
  });
  assert.equal(await gh.file("acme/app", ".github/ci/areas.json", "a".repeat(40)), "{\"suites\":[]}");
  assert.deepEqual(calls.at(-1), { path: "/v1/codehost/read", body: { repo: "acme/app", kind: "file", path: ".github/ci/areas.json", ref: "a".repeat(40) } });
  assert.equal(await gh.file("acme/app", ".github/ci/areas.json", "b".repeat(40)), null, "no map is no evidence");
  assert.match(String(await gh.jobLog("acme/app", 42, 64_000)), /kernel#1/);
  assert.deepEqual(calls.at(-1), { path: "/v1/codehost/read", body: { repo: "acme/app", kind: "log", id: 42, bytes: 64_000 } });
  assert.equal(await gh.jobLog("acme/app", 7, 64_000), null);
});

test("a path that walks out, or a ref that isn't a full commit, is refused before any read", async () => {
  const { gh, calls } = fake(() => "x");
  await assert.rejects(() => gh.file("acme/app", "../etc/passwd", "a".repeat(40)));
  await assert.rejects(() => gh.file("acme/app", ".github/ci/areas.json", "main"));
  assert.equal(calls.length, 0);
});
