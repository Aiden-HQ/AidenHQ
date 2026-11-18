// task_team routes by each report's compiled `description:`, read from the directory setup writes, never from its handbook.
import { test } from "node:test";
import assert from "node:assert/strict";
import { bridge } from "./helpers.mjs";

const AGENTS = [
  { id: "me", name: "Chief of Staff", metadata: { setupKey: "aidenhq:chief-of-staff" } },
  { id: "ol", name: "Open Loops", title: "Loops", reportsTo: "me", metadata: { setupKey: "aidenhq:open-loops" } },
];

test("task_team returns each report's directory description", async () => {
  const handler = (req, res) => {
    const send = (x) => (res.setHeader("content-type", "application/json"), res.end(JSON.stringify(x)));
    if (req.url === "/api/agents/me") return send({ id: "me", companyId: "C1", name: "Chief of Staff" });
    if (req.url === "/api/companies/C1/agents") return send(AGENTS);
    res.statusCode = 404;
    res.end("{}");
  };
  const agents = { me: { key: "chief-of-staff", roles: [] }, ol: { key: "open-loops", roles: ["loops"], description: "Owns every follow-up loop." } };
  const r = await bridge({ handler, agents, task: "cur" }).call("task_team", {});
  const out = JSON.parse(r.result.content[0].text);
  assert.deepEqual(out.reports, [{ key: "open-loops", name: "Open Loops", title: "Loops", description: "Owns every follow-up loop.", roles: ["loops"] }]);
});
