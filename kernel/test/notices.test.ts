// A write's notices on its task (notices.ts): kept until the control plane takes them, so a blip never loses the comment that
// wakes the agent waiting on the write.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createNotices } from "../src/notices.ts";

test("a notice the control plane can't take now is posted on a later try; a closed task gets none; a refusal is told to the owner", async () => {
  let now = 1_000_000, posts = 502;
  const posted = [], alerts = [];
  const tasks = { "t-1": { status: "in_progress", parentId: "t-0" }, "t-0": { status: "todo" }, "t-2": { status: "done" } };
  const api = async (m, p, body) => {
    const id = decodeURIComponent(p.split("/")[3]);
    if (m === "GET" && p.includes("/comments")) return { status: 200, json: [] };
    if (m === "GET") return tasks[id] ? { status: 200, json: tasks[id] } : { status: 404, json: {} };
    if (posts !== 201) return { status: posts, json: {} };
    posted.push([id, body.body.replace(/\n\n<!-- aidenhq-kernel-notice:[^>]*-->$/, "")]);
    return { status: 201, json: {} };
  };
  const n = createNotices({ db: new DatabaseSync(":memory:"), api, alert: (t) => alerts.push(t), now: () => now });
  n.queue("t-1", "**Done** (approval r-1)");
  n.queue("t-1", "**Rejected** on WOR-1", { parent: true });
  n.queue("t-2", "**Failed** (approval r-2)");
  await n.send();
  assert.deepEqual(posted, []);
  posts = 201;
  await n.send();
  assert.deepEqual(posted, [], "not before its backoff");
  now += 60_000;
  await n.send();
  assert.deepEqual(posted, [["t-1", "**Done** (approval r-1)"], ["t-0", "**Rejected** on WOR-1"]]);
  now += 3600_000;
  posts = 403;
  n.queue("t-1", "**Stale** (approval r-3)");
  await n.send();
  assert.equal(alerts.length, 1);
  posts = 201;
  now += 3600_000;
  await n.send();
  assert.equal(posted.length, 2, "nothing left to send");
});
