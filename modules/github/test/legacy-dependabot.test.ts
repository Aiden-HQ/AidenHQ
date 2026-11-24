// The old PR watch's Dependabot tasks: github closes each once its PR is gone, keeps the rest, and deletes the file when none is left.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sweepLegacyDependabot } from "../service/src/legacy-dependabot.ts";

test("the old PR watch's Dependabot tasks are closed by github once their PR is gone, then its file is deleted", async () => {
  const dir = mkdtempSync(join(tmpdir(), "legacy-"));
  writeFileSync(join(dir, "pr-watch.json"), JSON.stringify({ "acme/app": { dependabot: { "https://github.com/acme/app/pull/1": "T1", "https://github.com/acme/app/pull/2": "T2" }, wakes: {} } }));
  let open2 = true;
  const closed = [];
  const gh = async (m, path) => ({ status: 200, body: { state: path.endsWith("/2") && open2 ? "open" : "closed" } });
  const kernel = async (m, path) => void closed.push(path);
  await sweepLegacyDependabot(dir, gh, kernel);
  assert.deepEqual(closed, ["/v1/tasks/T1/close"]);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "pr-watch.json"), "utf8")), { "acme/app": { dependabot: { "https://github.com/acme/app/pull/2": "T2" } } }, "a PR still open keeps its task");
  open2 = false;
  await sweepLegacyDependabot(dir, gh, kernel);
  assert.deepEqual(closed, ["/v1/tasks/T1/close", "/v1/tasks/T2/close"]);
  assert.equal(existsSync(join(dir, "pr-watch.json")), false);
});
