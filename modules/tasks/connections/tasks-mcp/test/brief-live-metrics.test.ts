// A daily brief's numbers are measured when it is written. One brief carried a disk figure from the previous night's note
// and led the owner with a problem an overnight cleanup had already fixed; the brief is filed with a warning until the
// figure names when it was measured, and a brief without host metrics is never flagged.
import { test } from "node:test";
import assert from "node:assert/strict";
import { bridge } from "./helpers.ts";

const FIX = /Read the value live at brief time; quote it with the time you measured it/;
const iso = (minsAgo) => new Date(Date.now() - minsAgo * 60_000).toISOString().replace(/\.\d{3}Z$/, "Z");

function filed() {
  const created = [];
  const patched = [];
  const handler = (req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const url = req.url ?? "";
      const send = (x, code = 200) => ((res.statusCode = code), res.setHeader("content-type", "application/json"), res.end(JSON.stringify(x)));
      if (url === "/api/agents/me") return send({ id: "cos", companyId: "c", name: "Aiden" });
      if (url === "/api/companies/c") return send({ defaultResponsibleUserId: "owner" });
      if (url.endsWith("/labels")) return send([{ id: "00000000-0000-4000-8000-000000000001", name: "daily-brief" }]);
      if (req.method === "POST" && url.endsWith("/issues")) return (created.push(JSON.parse(body)), send({ id: "new", identifier: "WOR-9", title: "Daily Brief", status: "todo", createdAt: iso(0) }));
      if (req.method === "PATCH" && url.startsWith("/api/issues/")) return (patched.push(JSON.parse(body)), send({ id: "cur", identifier: "WOR-5", title: "Daily Brief", status: "todo", createdAt: iso(0) }));
      if (url.startsWith("/api/issues/WOR-5")) return send({ id: "cur", identifier: "WOR-5", title: "Daily Brief", status: "todo", createdAt: iso(0), description: "brief\n\n<!-- source:brief:2026-11-18 -->" });
      send([]);
    });
  };
  return { created, patched, handler };
}

const create = (f, args) => bridge({ handler: f.handler, agents: { cos: { key: "chief-of-staff" } }, agent: "cos", task: "run" }).call("task_create", { title: "Daily Brief", marker: "brief:2026-11-18", ...args });
const update = (f, description) => bridge({ handler: f.handler, agents: { cos: { key: "chief-of-staff" } }, agent: "cos", task: "run" }).call("task_update", { issue: "WOR-5", description });

test("a brief stating a host metric without a measurement time is flagged where it is filed, and still filed", async () => {
  const f = filed();
  for (const line of ["The host disk is 86% used, 70 GB free, ~2.5 days of runway.", "Host memory is 91% used.", "Spend yesterday was $41.20."]) {
    const r = await create(f, { description: `**Needs you:**\n- Disk cleanup: ${line}` });
    assert.equal(r.result?.isError, undefined, r.result?.content?.[0]?.text);
    assert.match(r.result.content[0].text, FIX, line);
  }
  assert.equal(f.created.length, 3);
});

test("each figure is measured within 15 minutes of the brief, in its own line; a metric-free brief is never flagged", async () => {
  const f = filed();
  const live = await create(f, { description: `- Disk cleanup: the host disk is 69% used, 138 GB free, measured ${iso(2)}.` });
  assert.doesNotMatch(live.result.content[0].text, FIX);
  const stale = await create(f, { description: `- Disk cleanup: the host disk is 86% used, 70 GB free, measured ${iso(600)}.` });
  assert.match(stale.result.content[0].text, /no time it was measured within 15 minutes/);
  // A fresh timestamp on another line does not cover a second figure of its own.
  const shared = await create(f, { description: `- Spend: $41 yesterday, measured ${iso(1)}.\n- Disk: 86% used, 70 GB free.` });
  assert.match(shared.result.content[0].text, /Disk: 86% used, 70 GB free\./);
  const none = await create(f, { description: "**Needs you:**\n- Backup retention: the decision waits for you.\n\n**Next:** 2 meetings." });
  assert.doesNotMatch(none.result.content[0].text, FIX);
  assert.doesNotMatch(none.result.content[0].text, /warning/);
});

test("the `daily-brief` label counts too, and a brief moved with task_update gets the same warning", async () => {
  const f = filed();
  const labelled = await create(f, { marker: "today", labels: ["daily-brief"], description: "Disk is 86% used." });
  assert.match(labelled.result.content[0].text, FIX);
  const updated = await update(f, `Disk is 69% used, 138 GB free, measured ${iso(600)}.`);
  assert.match(updated.result.content[0].text, /no time it was measured within 15 minutes/);
  const fresh = await update(f, `Disk is 69% used, 138 GB free, measured ${iso(1)}.`);
  assert.doesNotMatch(fresh.result.content[0].text, FIX);
});
