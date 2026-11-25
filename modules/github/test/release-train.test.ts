// The release train's loop (service/src/train.ts) against a fake kernel and GitHub: a green product tip past the batch window
// files one kernel.apply for its bump on the Platform Engineer's task; a restart between filing and saving adopts the same
// card, which the kernel answers with the same record; a bump that ends is closed and its tip never tried again; a bump that
// ends failed or unknown — even one whose written-down state was lost — closes its task cancelled with a "Not landed" note,
// while only one whose card ended done closes done; a lasting refusal to file the apply closes "Not filed", also cancelled.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createReleaseTrain } from "../service/src/train.ts";

const [OLD, NEW] = ["a", "b"].map((c) => c.repeat(40));
const INSTANCE = `product: ${OLD}\nmodules: [core]\n`;

function fakes() {
  // `tasks`: every filing call; `made`: the tasks the control plane actually created (one per source, as the kernel's
  // idempotency key makes it); `closeFails`: close calls to fail before answering 502; `stranded`: the open tasks the kernel's
  // source listing answers with (a task a process filed and this one never had in hand).
  const k = { tasks: [], made: [], writes: [], closed: [], records: {}, closeFails: 0, stranded: [], lists: [] };
  const kernel = async (method, path, body) => {
    const l = /^\/v1\/tasks\?source=(.+)$/.exec(path);
    if (l) {
      k.lists.push(decodeURIComponent(l[1]));
      // The control plane's listing is open tasks: one the fake kernel has just closed is no longer in it.
      return { tasks: k.stranded.filter((t) => decodeURIComponent(l[1]) === "release:instance:" && t.source.startsWith("release:instance:") && !k.closed.some((c) => c.task === t.id)) };
    }
    if (path === "/v1/tasks") {
      k.tasks.push(body);
      const same = k.made.find((t) => t.source === body.source);
      if (same) return { id: same.id, identifier: same.identifier, deduplicated: true };
      const t = { id: `t-${body.source}`, identifier: "ACME-7", source: body.source };
      k.made.push(t);
      return { id: t.id, identifier: t.identifier };
    }
    const w0 = /^\/v1\/work\?task=(.+)$/.exec(path);
    if (w0) {
      const task = decodeURIComponent(w0[1]);
      return { records: Object.values(k.records).filter((r) => r.task === task).map((r) => ({ ...r, outcome_text: r.outcome?.text ?? null })) };
    }
    if (path === "/v1/writes") {
      // The kernel: the same request still open is that record.
      const same = Object.values(k.records).find((r) => r.sha === body.args.sha && ["review", "owner"].includes(r.state));
      k.writes.push(body);
      if (same) return { id: same.id, tier: 1, state: same.state };
      const id = `k-${String(Object.keys(k.records).length).padStart(16, "0")}`;
      k.records[id] = { id, kind: body.kind, sha: body.args.sha, task: body.task, state: "review" };
      return { id, tier: 1, state: "review" };
    }
    const w = /^\/v1\/writes\/(k-\d+)$/.exec(path);
    if (w) return k.records[w[1]];
    const c = /^\/v1\/tasks\/(.+)\/close$/.exec(path);
    if (c) {
      if (k.closeFails > 0) { k.closeFails -= 1; throw new Error("/v1/tasks/x/close answered 502: the control plane answered 502"); }
      k.closed.push({ task: c[1], ...body });
      return {};
    }
    throw new Error(`no route ${path}`);
  };
  const github = {
    tip: async () => ({ tip: NEW, green: true }),
    text: async (repo, path) => (path === "instance.yaml" ? INSTANCE : undefined),
    commits: async (repo, from, to) => [{ repo, sha: to, subject: "(#1)" }],
  };
  return { k, kernel, github };
}
const train = (dir, f, clock, extra = {}) => createReleaseTrain({
  dir, productRepo: "acme/aidenhq", instanceRepo: "acme/aidenhq-instance", windowMinutes: 15,
  kernel: f.kernel, github: f.github, now: () => clock.t,
  commit: async (repo, path, edit) => { const t = edit(f.head ?? INSTANCE); f.committed = t; return t.includes(NEW) ? "e".repeat(40) : "0".repeat(40); }, ...extra,
});

/**
 * A task a process filed and this train never had in hand: `state` is its newest kernel.apply's state (`null`: none was ever
 * filed), `createdAt` its filing time. Written to the fake kernel's listing and work log, never to `s.flight`.
 */
function stranded(f, { source = "release:instance:1795022489866", state = "failed", text = "the service codehost-github isn't running", createdAt = "2026-11-18T09:00:00Z" } = {}) {
  const id = `t-${source}`;
  f.k.stranded.push({ id, identifier: "WOR-8308", source, createdAt, status: "in_review" });
  if (state) f.k.records[`k-${source}`] = { id: `k-${source}`, kind: "kernel.apply", task: id, state, created_at: createdAt, outcome: { ok: state === "done", text } };
  return id;
}

test("a green tip past the window files one kernel.apply; a restart adopts that same card, and an ended bump is never retried", async () => {
  const dir = mkdtempSync(join(tmpdir(), "train-"));
  const f = fakes();
  const clock = { t: new Date("2026-11-18T10:00:00Z") };
  await train(dir, f, clock).step();
  assert.equal(f.k.writes.length, 0, "opened: the window runs");
  clock.t = new Date("2026-11-18T10:20:00Z");
  // The kernel's answer is lost (a restart before the train saves the flight): the next train adopts the card it filed.
  let lost = true;
  const flaky = { ...f, kernel: async (m, p, b) => { const r = await f.kernel(m, p, b); if (p === "/v1/writes" && lost) { lost = false; throw new Error("socket hang up"); } return r; } };
  await assert.rejects(train(dir, flaky, clock).step(), /hang up/);
  await train(dir, f, clock).step();
  assert.equal(f.k.tasks.length, 1, "one task per tip");
  assert.equal(f.k.tasks[0].role, "platform-engineer");
  assert.equal(f.k.tasks[0].quiet, true, "filed quiet: the card carries the bump and no agent is woken for it");
  assert.deepEqual(f.k.writes.map((w) => [w.kind, w.args.repo, w.args.sha, w.task]), [["kernel.apply", "acme/aidenhq-instance", "e".repeat(40), "t-release:instance:" + NEW]], "the filed card is adopted, not requested again");
  assert.equal(Object.keys(f.k.records).length, 1, "one record: the same request");
  // In flight: nothing else files. Applied: the task closes and the same tip is never filed again.
  await train(dir, f, clock).step();
  assert.equal(f.k.writes.length, 1);
  Object.values(f.k.records)[0].state = "done";
  await train(dir, f, clock).step();
  await train(dir, f, clock).step();
  assert.deepEqual(f.k.closed.map((c) => c.body), ["Applied: this instance runs the bump."]);
  assert.equal(f.k.writes.length, 1);
});


/**
 * The sweep: the tip is the live pin, so trainStep is idle and nothing is filed or followed here; only the tasks the kernel's
 * source listing returns are settled, from their cards, with no memory of them in this process at all.
 */
function idle(f) {
  f.github.tip = async () => ({ tip: OLD, green: true });
  return f;
}

/**
 * A bump whose card has already ended, settled where it is found: with `follow` the train filed it and holds it in flight
 * (`follow()` closes it); without, the sweep finds it from the kernel's listing and this process never had it (`sweep()` closes it).
 */
async function endedCard(state, text, { follow = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "train-"));
  const f = fakes();
  const clock = { t: new Date("2026-11-18T10:00:00Z") };
  const task = `t-release:instance:${NEW}`;
  let rec;
  if (follow) {
    await train(dir, f, clock).step();
    clock.t = new Date("2026-11-18T10:20:00Z");
    await train(dir, f, clock).step();
    assert.equal(Object.keys(f.k.records).length, 1, "the bump is filed");
    rec = Object.values(f.k.records)[0];
  } else {
    idle(f); // the tip is the live pin: nothing is filed here, only the stranded task is settled
    const id = `k-${task}`;
    rec = f.k.records[id] = { id, kind: "kernel.apply", task, state: "review" };
    f.k.stranded.push({ id: task, identifier: "ACME-7", source: `release:instance:${NEW}`, createdAt: clock.t.toISOString(), status: "in_review" });
  }
  rec.state = state;
  rec.outcome = { ok: state === "done", text };
  await train(dir, f, clock).step();
  return f.k.closed;
}

const FAILED = "generation 12: refused, the staged compile failed; nothing was switched or restarted";

test("a card that ended failed closes its task cancelled with the Not landed body, followed or swept", async () => {
  const closed = [{ task: `t-release:instance:${NEW}`, status: "cancelled", body: `**Not landed:** it was approved but failed: ${FAILED}. The next merge to the product files the next bump.` }];
  assert.deepEqual(await endedCard("failed", FAILED, { follow: true }), closed, "follow()");
  assert.deepEqual(await endedCard("failed", FAILED), closed, "sweep()");
});

test("a card that ended done still closes its task done with the Applied body, followed or swept", async () => {
  const closed = [{ task: `t-release:instance:${NEW}`, status: "done", body: "Applied: this instance runs the bump." }];
  assert.deepEqual(await endedCard("done", "generation 12: the bump is live", { follow: true }), closed, "follow()");
  assert.deepEqual(await endedCard("done", "generation 12: the bump is live"), closed, "sweep()");
});

test("a lasting refusal to file the apply closes the bump's task cancelled with the Not filed body", async () => {
  const dir = mkdtempSync(join(tmpdir(), "train-"));
  const f = fakes();
  const clock = { t: new Date("2026-11-18T10:00:00Z") };
  await train(dir, f, clock).step();
  clock.t = new Date("2026-11-18T10:20:00Z");
  const refused = { ...f, kernel: async (m, p, b) => { if (p === "/v1/writes") throw new Error("/v1/writes answered 422: the rules refuse this apply"); return f.kernel(m, p, b); } };
  await train(dir, refused, clock).step();
  assert.equal(f.k.writes.length, 0, "no card is filed");
  assert.deepEqual(f.k.closed, [{ task: `t-release:instance:${NEW}`, status: "cancelled", body: "**Not filed:** /v1/writes answered 422: the rules refuse this apply" }]);
});
