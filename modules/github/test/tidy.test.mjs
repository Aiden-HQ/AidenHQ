// A job's head the service kept (refs/ws/<task>/<branch> in its cache clone, noted in an index with the date: the runner's
// refs/reviewed/…) is pruned after its retention, leaving every branch alone, and a ref that is already gone leaves the index.
// The runner's reviewed-refs.test.mjs, against the service's cache layout.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { noteKept, pruneReviewedRefs, startTidy } from "../service/src/tidy.ts";

const sh = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "a", GIT_AUTHOR_EMAIL: "a@example.com", GIT_COMMITTER_NAME: "a", GIT_COMMITTER_EMAIL: "a@example.com" } }).trim();
const DAY = 86_400_000;

function setup(t) {
  const root = mkdtempSync(join(tmpdir(), "codehost-tidy-"));
  const cacheDir = join(root, "cache");
  const bare = join(cacheDir, "ws", "acme", "api.git"); // <cache>/ws/<org>/<name>.git, lowercase
  mkdirSync(bare, { recursive: true });
  sh(bare, "init", "--quiet", "--bare", "-b", "main");
  const work = join(root, "work");
  sh(root, "init", "--quiet", "-b", "main", work);
  const commit = (name) => { writeFileSync(join(work, name), `${name}\n`); sh(work, "add", name); sh(work, "commit", "--quiet", "-m", name); return sh(work, "rev-parse", "HEAD"); };
  const keep = (ref, sha, at) => { sh(work, "push", "--quiet", bare, `+${sha}:${ref}`); noteKept(cacheDir, { repo: "Acme/Api", ref, now: at }); };
  return { cacheDir, bare, work, commit, keep, has: (ref) => { try { return sh(bare, "rev-parse", "--verify", "--quiet", ref).length > 0; } catch { return false; } } };
}

test("a kept head is pruned after 30 days, a ref kept again takes the newer date, and a missing ref leaves the index", async (t) => {
  const { cacheDir, bare, work, commit, keep, has } = setup(t);
  const a = commit("a.txt");
  const b = commit("b.txt");
  sh(work, "push", "--quiet", bare, `${a}:refs/heads/main`);
  keep("refs/ws/TASK-1/feat/old", a, new Date(Date.now() - 40 * DAY));
  keep("refs/ws/TASK-2/feat/fresh", b, new Date());
  // The same head kept again later takes the newer retention, so it outlives its first note.
  keep("refs/ws/TASK-3/feat/again", b, new Date(Date.now() - 40 * DAY));
  keep("refs/ws/TASK-3/feat/again", b, new Date(Date.now() - 20 * DAY));
  assert.deepEqual(await pruneReviewedRefs(cacheDir, { days: 30 }), ["refs/ws/TASK-1/feat/old"]);
  assert.equal(has("refs/ws/TASK-1/feat/old"), false);
  assert.equal(has("refs/ws/TASK-2/feat/fresh") && has("refs/ws/TASK-3/feat/again"), true);
  assert.equal(sh(bare, "rev-parse", "refs/heads/main"), a, "no branch was touched");

  // A ref that went missing leaves the index at the next sweep rather than pointing at nothing.
  sh(bare, "update-ref", "-d", "refs/ws/TASK-2/feat/fresh");
  assert.deepEqual(await pruneReviewedRefs(cacheDir, { days: 30 }), ["refs/ws/TASK-2/feat/fresh"]);
  assert.deepEqual(await pruneReviewedRefs(cacheDir, { days: 0, now: Date.now() + 1000 }), ["refs/ws/TASK-3/feat/again"]);

  // The service's sweep does the same once a day, starting now.
  keep("refs/ws/TASK-4/feat/x", b, new Date(Date.now() - 31 * DAY));
  const stop = startTidy({ cacheDir });
  t.after(stop);
  for (let i = 0; i < 100 && has("refs/ws/TASK-4/feat/x"); i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(has("refs/ws/TASK-4/feat/x"), false);
});
