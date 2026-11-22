// Graded done through the task tools: task_delegate files the rubric with the grading module (a graded assignee must name its
// deliverable; the ref is one strict token, so it can't forge a hidden marker in the description), and task_finish on a
// task the kernel's finish gate holds keeps the result as a comment and leaves the status to the grader.
import { test } from "node:test";
import assert from "node:assert/strict";
import { bridge } from "./helpers.ts";

async function call(name, args, { finish, gradingDown = false, assignee = "cos", feedback } = {}) {
  const seen = { created: [], filed: [], patches: [], comments: [] };
  const handler = (req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const url = req.url ?? "";
      const send = (x, code = 200) => ((res.statusCode = code), res.setHeader("content-type", "application/json"), res.end(JSON.stringify(x)));
      const json = body ? JSON.parse(body) : {};
      // The grading module: the caller assertion says whose call it is.
      const as = req.headers["x-aidenhq-caller"] ? "caller" : "nobody";
      if (url === "/grades") return (seen.filed.push({ ...json, as }), send({ created: true, state: "open" }));
      if (url === "/api/agents/me") return send({ id: "cos", name: "Aiden" });
      if (url.endsWith("/agents")) return send([
        { id: "eng", name: "Kai", metadata: { setupKey: "aidenhq:engineer-openrouter", runnerEngine: true }, status: "idle" },
        { id: "ops", name: "Fleet Ops", metadata: { setupKey: "aidenhq:fleet-ops" }, status: "idle" },
      ]);
      if (req.method === "POST" && url.endsWith("/issues")) return (seen.created.push(json), send({ id: "new", identifier: "WOR-9", title: "t", status: "todo" }));
      if (req.method === "POST" && url.endsWith("/comments")) return (seen.comments.push(json.body), send({ id: "c1" }));
      // The kernel's finish gate on a move to done: held (202, nothing forwarded) or a failed check (503).
      if (req.method === "PATCH" && json.status === "done" && finish) return (seen.patches.push(json), send(finish.body, finish.status));
      if (req.method === "PATCH") return (seen.patches.push(json), send({ id: "cur", identifier: "WOR-5", status: json.status }));
      if (url.startsWith("/api/issues/")) return send({ id: "cur", identifier: "WOR-5", title: "t", status: "in_progress", assigneeAgentId: assignee, parentId: null });
      send([]);
    });
  };
  const agents = { cos: { key: "chief-of-staff", roles: [], ...(feedback ? { feedback_for: feedback } : {}) }, eng: { key: "engineer-openrouter", roles: [], graded: true }, ops: { key: "fleet-ops", roles: [] } };
  const board = gradingDown ? (req) => req.socket.destroy() : handler;
  const r = await bridge({ handler, board, agents, agent: "cos", task: "cur" }).call(name, args);
  return { r, text: r.result?.content?.[0]?.text ?? "", ...seen };
}

const ask = { agent: "Kai", title: "Fix the total", description: "Show VAT on the totals page of acme/app." };
const rubric = ["merged into main", "checks green on the merged head", "the totals page shows the VAT line"];

test("a graded assignee needs a deliverable; the rubric goes to the board as the caller, a copy in the description", async () => {
  const missing = await call("task_delegate", ask);
  assert.equal(missing.r.result?.isError, true);
  assert.match(missing.text, /graded: name the deliverable/);
  assert.equal(missing.created.length, 0);

  const ok = await call("task_delegate", { ...ask, deliverable: { kind: "pr", ref: "acme/app" }, rubric });
  assert.equal(ok.r.result?.isError, undefined, ok.text);
  assert.deepEqual(ok.filed, [{ issue: "new", rubric, deliverable: { kind: "pr", ref: "acme/app" }, as: "caller" }]);
  assert.match(ok.created[0].description, /Graded before done \(pr: acme\/app\):\n1\. merged into main/);

  const none = await call("task_delegate", { ...ask, deliverable: { kind: "none" } });
  assert.equal(none.filed.length, 0);
  // Read-only work (a diagnosis, research) is not graded: its answer is the deliverable, read by the delegator.
  const report = await call("task_delegate", { ...ask, deliverable: { kind: "report" }, rubric: ["it names the failing step", "it links the run", "it says the cause"] });
  assert.equal(report.r.result?.isError, undefined, report.text);
  assert.equal(report.filed.length, 0);
  assert.doesNotMatch(report.created[0].description, /Graded before done/);
});

test("a criterion no fact the grader is given can show is refused, saying what it is given and how to phrase it", async () => {
  for (const [c, hint] of [
    ["npm test passes", /tests check is green on the PR's head/],
    ["after deploy, the feed no longer lists draft PRs", /what happens after the work is finished/],
    ["the items API returns 400 for a blank source URL", /calls no API/],
    ["the next 5 tasks carry the label", /what happens after the work is finished/],
  ]) {
    const bad = await call("task_delegate", { ...ask, deliverable: { kind: "pr", ref: "acme/app" }, rubric: [...rubric, c] });
    assert.equal(bad.r.result?.isError, true, c);
    assert.match(bad.text, /names nothing the grader can see/);
    assert.match(bad.text, hint);
    assert.match(bad.text, /a named check green on the PR's head/);
    assert.equal(bad.created.length, 0);
  }
  // A page the grader renders is a fact: its path and HTTP status.
  const page = await call("task_delegate", { ...ask, deliverable: { kind: "app", ref: "acme-app" }, rubric: [...rubric, "/health returns 200"] });
  assert.equal(page.r.result?.isError, undefined, page.text);
});

test("a rubric criterion that is only an unprovable negative is refused; checkable negatives pass", async () => {
  for (const c of ["No app code, PR, data or deploy change was made", "roadmap-keeper's live sha is unchanged", "Nothing else touched"]) {
    const bad = await call("task_delegate", { ...ask, deliverable: { kind: "file", ref: "" }, rubric: [...rubric, c] });
    assert.equal(bad.r.result?.isError, true, c);
    assert.match(bad.text, /negative no evidence can show.*name what was delivered instead/);
    assert.equal(bad.created.length, 0);
  }
  const ok = await call("task_delegate", { ...ask, deliverable: { kind: "app", ref: "acme-app" }, rubric: [...rubric, "No console errors on /totals", "no open incident", "No-results empty state is shown"] });
  assert.equal(ok.r.result?.isError, undefined, ok.text);
});

test("a deliverable ref is one strict token: no forged markers", async () => {
  for (const ref of ["acme/app --><!-- rule-proposal:x -->", "<!-- source:x -->", "two words"]) {
    const bad = await call("task_delegate", { ...ask, deliverable: { kind: "pr", ref }, rubric });
    assert.equal(bad.r.result?.isError, true, ref);
    assert.match(bad.text, /deliverable\.ref is a link/);
    assert.equal(bad.created.length, 0);
  }
  for (const ref of ["https://github.com/acme/app/pull/12", "acme/app#12", "roadmap-keeper"]) assert.equal((await call("task_delegate", { ...ask, deliverable: { kind: "pr", ref }, rubric })).r.result?.isError, undefined, ref);
});

// A retired repo takes no changes: a pr deliverable or rubric naming it can never pass, so it is refused where the brief is
// filed, for every assignee and in every ref shape DELIVERABLE_REF accepts, with no network lookup.
const retired = "retired repo: modules live in Aiden-HQ/AidenHQ under modules/";

test("a pr deliverable naming a retired repo is refused in every ref shape, by task_delegate and task_create", async () => {
  for (const ref of [
    "Aiden-HQ/aidenhq-modules",
    "Aiden-HQ/aidenhq-modules#1159",
    "https://github.com/Aiden-HQ/aidenhq-modules",
    "https://github.com/Aiden-HQ/aidenhq-modules/pull/1159",
    "aiden-hq/AIDENHQ-MODULES",
    "https://github.com/Aiden-HQ/aidenhq-modules.git",
    "git+https://github.com/Aiden-HQ/aidenhq-modules.git",
    "git@github.com:Aiden-HQ/aidenhq-modules.git",
  ]) {
    const delegated = await call("task_delegate", { ...ask, deliverable: { kind: "pr", ref }, rubric });
    assert.equal(delegated.r.result?.isError, true, ref);
    assert.equal(delegated.text, retired, ref);
    assert.equal(delegated.created.length, 0, ref);

    // task_create, for a graded assignee and for one whose work isn't graded: any assignee.
    for (const assignee of ["Kai", "fleet-ops"]) {
      const created = await call("task_create", { title: "Security fix: image", description: "Bump the base image.", marker: "security:target:repo:product", assignee, deliverable: { kind: "pr", ref } });
      assert.equal(created.r.result?.isError, true, `${ref} to ${assignee}`);
      assert.equal(created.text, retired, `${ref} to ${assignee}`);
      assert.equal(created.created.length, 0, `${ref} to ${assignee}`);
    }
  }
});

test("a pr rubric naming a retired repo is refused, and a live repo files normally", async () => {
  for (const c of [
    "the PR is merged into Aiden-HQ/aidenhq-modules",
    "a test in the diff covers the check in aiden-hq/AIDENHQ-MODULES#12",
    "https://github.com/Aiden-HQ/aidenhq-modules/pull/1159 is merged",
  ]) {
    const bad = await call("task_delegate", { ...ask, deliverable: { kind: "pr", ref: "Aiden-HQ/AidenHQ" }, rubric: [...rubric, c] });
    assert.equal(bad.r.result?.isError, true, c);
    assert.equal(bad.text, retired, c);
    assert.equal(bad.created.length, 0, c);
  }

  // A brief that names the retired repo only in its text is refused too: the brief and the grade must agree.
  for (const description of [
    "Open the PR in Aiden-HQ/aidenhq-modules against main.",
    "Bump the base image there: https://github.com/Aiden-HQ/aidenhq-modules/pull/1159 is the earlier attempt.",
    "Clone git@github.com:Aiden-HQ/aidenhq-modules.git and change the Dockerfile.",
  ]) {
    const bad = await call("task_delegate", { agent: "Kai", title: "Security fix: image", description, deliverable: { kind: "pr", ref: "Aiden-HQ/AidenHQ" }, rubric });
    assert.equal(bad.r.result?.isError, true, description);
    assert.equal(bad.text, retired, description);
    assert.equal(bad.created.length, 0, description);
  }

  // The same shapes for the live repo still file.
  for (const ref of ["Aiden-HQ/AidenHQ", "Aiden-HQ/AidenHQ#1188", "https://github.com/Aiden-HQ/AidenHQ/pull/1188"]) {
    const ok = await call("task_delegate", { ...ask, deliverable: { kind: "pr", ref }, rubric });
    assert.equal(ok.r.result?.isError, undefined, `${ref}: ${ok.text}`);
    assert.deepEqual(ok.filed, [{ issue: "new", rubric, deliverable: { kind: "pr", ref }, as: "caller" }]);
  }
});

test("task_finish on a held task posts the result as a comment and leaves the status to the grader", async () => {
  const held = await call("task_finish", { comment: "Merged acme/app#12." }, { finish: { status: 202, body: { held: { state: "pending", reason: "The grader checks this task against its rubric." } } } });
  assert.equal(held.r.result?.isError, undefined, held.text);
  // One move to done, which the kernel held (it forwards nothing); the result goes on as a comment.
  assert.deepEqual(held.patches.map((p) => p.status), ["done"]);
  assert.deepEqual(held.comments, ["Merged acme/app#12."]);
  assert.match(held.text, /Held for grading/);
  const free = await call("task_finish", { comment: "Done." });
  assert.equal(free.patches[0].status, "done");
  assert.deepEqual(free.comments, []);
});

test("a finish check that fails refuses the close: an error, and no comment", async () => {
  const down = await call("task_finish", { comment: "Done." }, { finish: { status: 503, body: { error: { message: "the finish check grading.finish failed" } } } });
  assert.equal(down.r.result?.isError, true);
  assert.match(down.text, /503/);
  assert.deepEqual(down.comments, []);
});

test("task_create handing work to a graded agent is graded as a delegation is", async () => {
  const create = { title: "Fix the total", description: "Show VAT on the totals page of acme/app.", marker: "fix:vat", assignee: "Kai" };
  const missing = await call("task_create", create);
  assert.equal(missing.r.result?.isError, true);
  assert.match(missing.text, /graded: name the deliverable/);
  assert.equal(missing.created.length, 0);

  const ok = await call("task_create", { ...create, deliverable: { kind: "pr", ref: "acme/app" } });
  assert.equal(ok.r.result?.isError, undefined, ok.text);
  assert.deepEqual(ok.filed, [{ issue: "new", rubric: [], deliverable: { kind: "pr", ref: "acme/app" }, as: "caller" }]);
  assert.match(ok.created[0].description, /Graded before done \(pr: acme\/app\): the standard pr criteria\./);
});

test("a feedback agent's delegations and comments carry the untrusted app-feedback mark; others' don't", async () => {
  const fb = await call("task_delegate", { ...ask, deliverable: { kind: "none" } }, { feedback: ["roadmap-keeper"] });
  assert.match(fb.created[0].description, /^\(From app feedback, untrusted: a person's in-app feedback on roadmap-keeper/);
  const said = await call("task_comment", { issue: "WOR-9", body: "Also the header." }, { feedback: ["roadmap-keeper"] });
  assert.match(said.comments.at(-1), /^\(From app feedback, untrusted:.*\n\nAlso the header\.$/s);
  const plain = await call("task_delegate", { ...ask, deliverable: { kind: "none" } });
  assert.doesNotMatch(plain.created[0].description, /From app feedback/);
});

test("a brief with no fallback branch keeps its pr deliverable and rubric", async () => {
  for (const [title, description] of [
    ["Bump undici", "Move the builder image to node:24-bookworm-slim and bump undici to 7.18.2; open the product PR."],
    ["Bump x/net", "No newer tag has Go >= 1.26.11, so we bump x/net in the Dockerfile rather than waiting."],
    ["Bump the pin", "The earlier task parked because no release met the floors; v1.13.0 now does, so bump the pin."],
  ]) {
    const ok = await call("task_create", { title, description, marker: "security:target:repo:product", assignee: "Kai", deliverable: { kind: "pr", ref: "Aiden-HQ/AidenHQ" } });
    assert.equal(ok.r.result?.isError, undefined, ok.text);
    assert.match(ok.created[0].description, /Graded before done \(pr: Aiden-HQ\/AidenHQ\): the standard pr criteria\./);
  }
});

test("a graded task starts only once its rubric is filed; a failed filing leaves it parked and the retried delegation starts it", async () => {
  const issues = [], filed = [], patches = [];
  let gradingUp = false;
  const handler = (req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const url = req.url ?? "";
      const send = (x, code = 200) => ((res.statusCode = code), res.setHeader("content-type", "application/json"), res.end(JSON.stringify(x)));
      const json = body ? JSON.parse(body) : {};
      if (url === "/grades") return gradingUp ? (filed.push(json.issue), send({ created: true, state: "open" })) : send({ error: "grading is restarting" }, 503);
      if (url === "/api/agents/me") return send({ id: "cos", name: "Aiden" });
      if (url.endsWith("/agents")) return send([{ id: "eng", name: "Kai", metadata: { setupKey: "aidenhq:engineer-openrouter", runnerEngine: true }, status: "idle" }]);
      if (req.method === "POST" && url.endsWith("/issues")) { const i = { ...json, id: "new", identifier: "WOR-9", createdByAgentId: "cos" }; issues.push(i); return send(i); }
      if (req.method === "GET" && /\/companies\/[^/]+\/issues\?/.test(url)) return send(issues);
      if (req.method === "PATCH" && url === "/api/issues/new") { patches.push(json); Object.assign(issues[0], json); return send(issues[0]); }
      if (url.startsWith("/api/issues/")) return send({ id: "cur", identifier: "WOR-5", title: "t", status: "in_progress", assigneeAgentId: "cos", parentId: null });
      send([]);
    });
  };
  const agents = { cos: { key: "chief-of-staff", roles: [] }, eng: { key: "engineer-openrouter", roles: [], graded: true } };
  const b = bridge({ handler, board: handler, agents, agent: "cos", task: "cur" });
  const args = { ...ask, marker: "vat", deliverable: { kind: "pr", ref: "acme/app" }, rubric };

  const down = await b.call("task_delegate", args);
  assert.equal(down.result?.isError, true);
  assert.match(down.result.content[0].text, /WOR-9 is filed but not started: its rubric couldn't be filed/);
  assert.equal(issues[0].status, "backlog", "parked: nothing dispatches it ungraded");
  assert.deepEqual(patches, []);

  gradingUp = true;
  const again = await b.call("task_delegate", args);
  assert.equal(again.result?.isError, undefined, again.result?.content?.[0]?.text);
  assert.deepEqual(filed, ["new"]);
  assert.deepEqual(patches, [{ status: "todo" }], "started once its rubric is on file");
  assert.equal(issues.length, 1, "the same task, not a second one");
});

test("task_create for a graded agent starts its task only once the rubric is filed; the retry with its marker starts it", async () => {
  const issues = [], filed = [], patches = [];
  let gradingUp = false;
  const handler = (req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const url = req.url ?? "";
      const send = (x, code = 200) => ((res.statusCode = code), res.setHeader("content-type", "application/json"), res.end(JSON.stringify(x)));
      const json = body ? JSON.parse(body) : {};
      if (url === "/grades") return gradingUp ? (filed.push(json.issue), send({ created: true, state: "open" })) : send({ error: "grading is restarting" }, 503);
      if (url === "/api/agents/me") return send({ id: "cos", name: "Aiden" });
      if (url.endsWith("/agents")) return send([{ id: "eng", name: "Kai", status: "idle", metadata: { setupKey: "aidenhq:engineer-openrouter", runnerEngine: true }, status: "idle" }]);
      if (req.method === "POST" && url.endsWith("/issues")) { const i = { ...json, id: "new", identifier: "WOR-9", createdByAgentId: "cos" }; issues.push(i); return send(i); }
      if (req.method === "GET" && /\/companies\/[^/]+\/issues\?/.test(url)) return send(issues.filter((i) => i.description.includes("<!-- source:fix-vat-total -->")));
      if (req.method === "PATCH" && url === "/api/issues/new") { patches.push(json); Object.assign(issues[0], json); return send(issues[0]); }
      if (url.startsWith("/api/issues/")) return send({ id: "cur", identifier: "WOR-5", title: "t", status: "in_progress", assigneeAgentId: "cos", parentId: null });
      send([]);
    });
  };
  const agents = { cos: { key: "chief-of-staff", roles: [] }, eng: { key: "engineer-openrouter", roles: [], graded: true } };
  const b = bridge({ handler, board: handler, agents, agent: "cos", task: "cur" });
  const args = { title: ask.title, description: ask.description, assignee: "Kai", marker: "fix-vat-total", deliverable: { kind: "pr", ref: "acme/app" }, rubric };

  const down = await b.call("task_create", args);
  assert.equal(down.result?.isError, true);
  assert.match(down.result.content[0].text, /WOR-9 is filed but not started: its rubric couldn't be filed/);
  assert.equal(issues[0].status, "backlog", "parked: nothing dispatches it ungraded");
  assert.deepEqual(patches, []);

  gradingUp = true;
  const again = await b.call("task_create", args);
  assert.equal(again.result?.isError, undefined, again.result?.content?.[0]?.text);
  assert.deepEqual(filed, ["new"]);
  assert.deepEqual(patches, [{ status: "todo" }], "started once its rubric is on file");
  assert.equal(issues.length, 1, "the same task, not a second one");
});

test("a start that fails once is retried; one that keeps failing tells the agent the task is parked", async () => {
  for (const [failures, ok] of [[1, true], [9, false]]) {
    let left = failures, tries = 0;
    const handler = (req, res) => {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        const url = req.url ?? "";
        const send = (x, code = 200) => ((res.statusCode = code), res.setHeader("content-type", "application/json"), res.end(JSON.stringify(x)));
        if (url === "/grades") return send({ created: true, state: "open" });
        if (url === "/api/agents/me") return send({ id: "cos", name: "Aiden" });
        if (url.endsWith("/agents")) return send([{ id: "eng", name: "Kai", status: "idle", metadata: { setupKey: "aidenhq:engineer-openrouter", runnerEngine: true } }]);
        if (req.method === "POST" && url.endsWith("/issues")) return send({ id: "new", identifier: "WOR-9", status: "backlog", createdByAgentId: "cos" });
        if (req.method === "PATCH" && url === "/api/issues/new") return (tries++, left-- > 0 ? send({ error: "bad gateway" }, 502) : send({ id: "new", status: "todo" }));
        if (url.startsWith("/api/issues/")) return send({ id: "cur", identifier: "WOR-5", title: "t", status: "in_progress", assigneeAgentId: "cos", parentId: null });
        send([]);
      });
    };
    const agents = { cos: { key: "chief-of-staff", roles: [] }, eng: { key: "engineer-openrouter", roles: [], graded: true } };
    const r = await bridge({ handler, board: handler, agents, agent: "cos", task: "cur" }).call("task_delegate", { ...ask, deliverable: { kind: "pr", ref: "acme/app" }, rubric });
    if (ok) assert.equal(r.result?.isError, undefined, r.result?.content?.[0]?.text);
    else assert.match(r.result.content[0].text, /WOR-9 is filed but not started: moving it to todo failed.*stays parked in backlog/);
    assert.equal(tries, ok ? 2 : 3);
  }
});
