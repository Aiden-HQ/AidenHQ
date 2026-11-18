// A delegation that repeats a brief its agent still has open under the same parent is refused, naming the open task; other
// open tasks of that agent there are named on the new one, so a replaced task gets cancelled.
import { test } from "node:test";
import assert from "node:assert/strict";
import { bridge, parse } from "./helpers.mjs";

const origin = "Delegated by Aiden (agent) from WOR-5. This is an agent request, not the owner's words.";
const open = [{ id: "o1", identifier: "WOR-7", title: "Fix apps-platform health probe: name the failure class", description: `${origin}\n\nThe probe says "no answer" for every failure: name the class (timeout, refused, 5xx) in app_check.\n\nWhen done: comment your result, then call task_finish.`, status: "in_progress", parentId: "cur", assigneeAgentId: "eng" }];

function server() {
  const created = [];
  const handler = (req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const url = req.url ?? "";
      const send = (x) => (res.setHeader("content-type", "application/json"), res.end(JSON.stringify(x)));
      if (url === "/api/agents/me") return send({ id: "cos", name: "Aiden" });
      if (url.endsWith("/agents")) return send([{ id: "eng", name: "Engineer", metadata: { setupKey: "aidenhq:engineer-openrouter", persona: { name: "Linus" } }, status: "idle", reportsTo: "cos" }]);
      if (req.method === "GET" && url.includes("/issues?") && url.includes("assigneeAgentId=eng")) return send(open);
      if (req.method === "POST" && url.endsWith("/issues")) return (created.push(JSON.parse(body)), send({ id: "new", identifier: "WOR-9" }));
      if (url.startsWith("/api/issues/")) return send({ id: "cur", identifier: "WOR-5", status: "in_progress", assigneeAgentId: "cos" });
      send([]);
    });
  };
  const { call } = bridge({ handler, agents: { cos: { key: "chief-of-staff" }, eng: { key: "engineer-openrouter" } }, agent: "cos", task: "cur" });
  return { call, created };
}

test("a refile of an open brief is refused with the open task; different work is filed, naming the open one", async () => {
  const { call, created } = server();
  const again = parse(await call("task_delegate", { agent: "Linus", title: "Fix apps-platform health probe: name the failure class", description: "The probe says no answer for every failure: name the class in app_check.", deliverable: { kind: "none" } }));
  assert.match(again.error, /Refused: WOR-7 .* is already Linus's open task for this brief under WOR-5\. To change it, comment on WOR-7/);
  assert.equal(created.length, 0);

  const other = parse(await call("task_delegate", { agent: "Linus", title: "Pin the voice module's whisper base image", description: "Move voice/whisper/Dockerfile to a digest-pinned trixie base.", deliverable: { kind: "none" } }));
  assert.equal(other.out.identifier, "WOR-9");
  assert.match(other.out.open_tasks, /Linus still has WOR-7 .* open under WOR-5: if this task replaces one, cancel it/);
});
