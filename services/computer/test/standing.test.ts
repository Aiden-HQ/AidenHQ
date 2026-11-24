// The standing session box (standing.ts): one container, many leases, each session stopped by its own process group.
// The launcher's Docker is a fake that records every call; nothing here needs Docker.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Jobs, jobEnvFile, standingMounts } from "../lib.ts";
import type { Box } from "../lib.ts";
import { SESSION_STOP, Standing } from "../standing.ts";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "standing-"));
  const envDir = join(dir, "jobs"), repo = join(dir, "repo");
  mkdirSync(join(repo, "modules/engine-opencode"), { recursive: true });
  writeFileSync(join(dir, "resolv.conf"), "nameserver 192.0.2.1\n");
  const jobs = new Jobs();
  const boxes = new Map<string, Box>();
  const calls: string[][] = [];
  let n = 0, image = "sha256:1";
  const docker = async (args: string[]) => { calls.push(args); return { exitCode: 0, stdout: "", stderr: "" }; };
  const removed: string[] = [];
  const destroy = async (name: string) => { removed.push(name); boxes.delete(name); jobs.delete(name); return true; };
  const standing = new Standing({
    jobs, boxes, docker, save: () => {}, log: () => {}, envDir,
    newName: () => `aidenhq-computer-b${++n}`,
    jobState: async () => "running",
    retire: async (name) => { jobs.retire(name); return destroy(name); },
    destroy,
    draining: () => false,
  });
  let issue = 0;
  const lease = (identifier = `PEN-${++issue}`, agentId = "a1") => standing.lease({
    agentId, issueId: `i-${identifier}`, identifier, workspace: join(dir, "work/sessions", identifier), token: `ahqj_${identifier}.sig`, roles: ["session"], stateIn: `/engine-state/a1_i-${identifier}`,
    runArgs: (name) => ["run", "-d", "--name", name, ...standingMounts({ resolvConf: join(dir, "resolv.conf"), sessionsDir: join(dir, "work/sessions"), outDir: join(envDir, "standing"), stateDir: join(dir, "state/opencode"), runnerWork: join(dir, "work"), repo, engineDir: "modules/engine-opencode" }).flatMap((m) => ["-v", m]), image, "sleep", "infinity"],
    env: (l) => jobEnvFile({ token: `ahqj_${identifier}.sig`, gatewayUrl: "http://gw", lease: l }),
  });
  const done = () => rmSync(dir, { recursive: true, force: true });
  return { dir, jobs, calls, removed, lease, standing, setImage: (i: string) => { image = i; }, done, runs: () => calls.filter((c) => c[0] === "run"), stops: () => calls.filter((c) => c[2] === SESSION_STOP).map((c) => c[3]) };
}

test("two sessions share one box", async () => {
  const t = setup();
  const a = await t.lease("PEN-1"), b = await t.lease("PEN-2");
  assert.equal(a.container, b.container);
  assert.equal(t.runs().length, 1, "one docker run");
  assert.notEqual(a.lease, b.lease);
  assert.notEqual(a.envFile, b.envFile);
  assert.match(a.lease, /^l-[0-9a-f]{8}$/);
  assert.deepEqual(t.jobs.leases(a.container).map((l) => l.ports), [{ serve: 20000, term: 20001 }, { serve: 20002, term: 20003 }]);
  assert.equal(a.boxOut, `/aidenhq-out/${a.lease}`);
  assert.equal(a.workdir, "/sessions/PEN-1");
  assert.equal(a.stateIn, "/engine-state/a1_i-PEN-1");
  assert.equal(t.jobs.byKernelToken("ahqj_PEN-1.sig")!.container, a.container);
  assert.equal(t.jobs.byKernelToken("ahqj_PEN-2.sig")!.container, a.container);
  assert.ok(existsSync(a.envFile) && existsSync(a.outDir));
  t.done();
});

test("release stops only its lease", async () => {
  const t = setup();
  const a = await t.lease("PEN-1"), b = await t.lease("PEN-2");
  assert.equal(await t.standing.stop(a.container, a.lease), true);
  assert.deepEqual(t.stops(), [a.lease]);
  assert.ok(!t.calls.some((c) => c[0] === "restart" || c[0] === "rm"), "the shared box is never restarted or removed");
  assert.equal(t.jobs.byKernelToken("ahqj_PEN-1.sig"), undefined, "the stopped session's token opens nothing");
  assert.equal(t.jobs.byKernelToken("ahqj_PEN-2.sig")!.container, b.container);
  assert.ok(!existsSync(a.outDir) && !existsSync(a.envFile), "its out folder and env file are gone");
  assert.ok(existsSync(b.outDir));
  assert.equal(await t.standing.stop(a.container, a.lease), false, "idempotent");
  assert.deepEqual(t.jobs.leases(a.container).map((l) => l.lease), [b.lease]);
  t.done();
});

test("a new image replaces the box", async () => {
  const t = setup();
  const a = await t.lease("PEN-1"), b = await t.lease("PEN-2");
  t.setImage("sha256:2");
  const c = await t.lease("PEN-3");
  assert.deepEqual(t.stops().sort(), [a.lease, b.lease].sort(), "each live lease is stopped once");
  assert.deepEqual(t.removed, [a.container]);
  assert.notEqual(c.container, a.container);
  assert.equal(t.runs().length, 2);
  assert.deepEqual(t.jobs.leases(c.container).map((l) => l.issueId), ["i-PEN-3"]);
  assert.equal(t.jobs.byKernelToken("ahqj_PEN-1.sig"), undefined);
  t.done();
});

test("restart keeps leases", async () => {
  const t = setup();
  const a = await t.lease("PEN-1"), b = await t.lease("PEN-2");
  const again = new Jobs();
  again.load(JSON.parse(JSON.stringify(t.jobs.dump())));
  assert.deepEqual(again.leases(a.container), t.jobs.leases(a.container));
  assert.equal(again.leases(a.container).length, 2);
  assert.equal(again.byKernelToken("ahqj_PEN-2.sig")!.container, b.container);
  assert.equal(again.standingBox()!.compat, t.jobs.standingBox()!.compat);
  t.done();
});

test("a lapsed lease drops only itself", async () => {
  const t = setup();
  const a = await t.lease("PEN-1"), b = await t.lease("PEN-2");
  const now = Date.now();
  // Lease 2 is renewed ten minutes in (a lease lasts 15), lease 1 is not: twenty minutes in only lease 1 has lapsed.
  assert.ok(t.jobs.renew(b.container, { issueId: "i-PEN-2", gen: 1, lease: b.lease }, now + 10 * 60_000));
  const lapsed = t.jobs.lapsed(now + 20 * 60_000);
  assert.deepEqual(lapsed, [{ container: a.container, lease: a.lease }], "the box itself and lease 2 never lapse");
  t.standing.reap(lapsed);
  await t.standing.stop(a.container, a.lease);
  assert.deepEqual(t.stops(), [a.lease]);
  assert.ok(t.jobs.get(a.container), "the standing box stays");
  assert.equal(t.jobs.byKernelToken("ahqj_PEN-2.sig")!.container, b.container);
  assert.equal(t.jobs.renew(a.container, { issueId: "i-PEN-1", gen: 1, lease: a.lease }), undefined, "a stopped lease renews nothing");
  t.done();
});
