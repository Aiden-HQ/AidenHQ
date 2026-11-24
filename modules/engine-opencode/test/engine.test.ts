// The engine over a stand-in opencode (test/bin/opencode): first turn, resume, the busy-session queue, the terminal, stop.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const bin = join(import.meta.dirname, "bin");
const engine = join(import.meta.dirname, "../bin/engine");
let port = 24000 + (process.pid % 1000) * 4;

function setup(session?: string, known = session ?? "", pending?: string[]) {
  const root = mkdtempSync(join(tmpdir(), "oc-engine-"));
  const lease = join(root, "l-test"), job = join(lease, "job-1"), state = join(root, "state"), work = join(root, "work", "PEN-1"), plug = join(root, "opt");
  for (const d of [job, state, work, join(plug, "node_modules")]) mkdirSync(d, { recursive: true });
  if (pending) writeFileSync(join(state, "pending.json"), JSON.stringify(pending));
  writeFileSync(join(plug, "plugins.json"), JSON.stringify({ plugins: ["opencode-pty@0.4.0"] }));
  const spec = { contract: "engine@1", job: "j1", agent: "a", task: "t1", prompt: "first prompt", ...(session ? { session } : {}), model: { base_url: "http://gw/v1", token_env: "AIDENHQ_RUN_TOKEN", id: "m1", effort: "" }, mcp: [], env: [], limits: { timeout_s: 0 }, web: true, state, sandbox: { kind: "box", writable: [], network: true } };
  writeFileSync(join(job, "job.json"), JSON.stringify(spec));
  const log = join(root, "fake.log");
  writeFileSync(log, "");
  const child = spawn(engine, [job], { cwd: work, stdio: ["ignore", "inherit", "pipe"], env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_LOG: log, AIDENHQ_OPENCODE_BIN: join(bin, "opencode"), AIDENHQ_OPENCODE_PLUGINS: plug, AIDENHQ_SESSION_PORT: String(port++), AIDENHQ_TERM_PORT: String(port++), OPENCODE_SERVER_PASSWORD: "pw", AIDENHQ_TERM_CREDENTIAL: "u:p", AIDENHQ_RUN_TOKEN: "ahqj_tok", FAKE_SESSIONS: known, FAKE_BUSY_MS: "1500" } });
  let stderr = "";
  child.stderr!.on("data", (d) => (stderr += d));
  const exited = new Promise<{ code: number | null }>((r) => child.on("close", (code) => r({ code })));
  const lines = (f: string) => readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l.startsWith("{") ? l : JSON.stringify({ raw: l })));
  const events = () => { try { return lines(join(job, "events.jsonl")); } catch { return []; } };
  const calls = () => lines(log);
  const until = async (f: () => boolean, ms = 15000) => { for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 50))) if (f()) return; throw new Error("timed out\n" + JSON.stringify({ events: events(), calls: calls() })); };
  return { child, exited, err: () => stderr, job, lease, state, events, calls, log, until };
}

test("first turn: session, progress and usage; one prompt; no final", async () => {
  const e = setup();
  try {
    await e.until(() => e.events().some((x: any) => x.t === "usage"));
    const ev = e.events() as any[];
    assert.equal(ev[0].t, "session");
    assert.ok(ev.some((x) => x.t === "progress" && x.steps?.some((s: any) => s.text.startsWith("bash: echo first prompt"))));
    assert.deepEqual(ev.find((x) => x.t === "usage"), { t: "usage", input: 10, cached: 4, output: 3, model: "m1" });
    assert.ok(!ev.some((x) => x.t === "final"));
    const prompts = e.calls().filter((c: any) => c.prompt);
    assert.equal(prompts.length, 1);
    assert.equal(prompts[0].text, "first prompt");
    const serve = e.calls().find((c: any) => c.serve) as any;
    assert.equal(serve.env.config, join(e.state, "opencode.json"));
    assert.match(readFileSync(join(e.lease, "pgid"), "utf8"), /^\d+$/);   // the engine's own group leader (real setsid)
    const cfg = JSON.parse(readFileSync(join(e.state, "opencode.json"), "utf8"));
    assert.ok(cfg.plugin[0].endsWith("/node_modules/opencode-pty"));
    // the terminal
    const raw = readFileSync(e.log, "utf8");
    assert.match(raw, /tmux new-session -d -s l-test -c \S+ -e OPENCODE_SERVER_PASSWORD=pw opencode attach http:\/\/127\.0\.0\.1:\d+ --session ses_new/);
    assert.match(raw, /ttyd --port \d+ --credential u:p --writable tmux attach -t l-test/);
  } finally { e.child.kill("SIGTERM"); await e.exited; }
});

test("resume: the reported session is opened, none created", async () => {
  const e = setup("s1");
  try {
    await e.until(() => e.calls().some((c: any) => c.prompt));
    assert.ok(!e.calls().some((c: any) => c.create));
    assert.equal((e.calls().find((c: any) => c.prompt) as any).prompt, "s1");
    assert.deepEqual((e.events()[0] as any), { t: "session", id: "s1" });
  } finally { e.child.kill("SIGTERM"); await e.exited; }
});

test("a session opencode no longer has ends as the kernel's stale session", async () => {
  const e = setup("gone", "");
  const { code } = await e.exited;
  assert.equal(code, 1);
  assert.match(e.err(), /no rollout found for thread id gone/);
  assert.ok(!e.calls().some((c: any) => c.create || c.prompt));
});

test("a comment opencode never accepted before a box replacement is sent by the next job, first", async () => {
  const e = setup(undefined, "", ["lost comment"]);
  try {
    await e.until(() => e.calls().filter((c: any) => c.prompt).length === 2);
    assert.deepEqual((e.calls().filter((c: any) => c.prompt) as any[]).map((p) => p.text), ["lost comment", "first prompt"]);
    assert.equal(readFileSync(join(e.state, "pending.json"), "utf8"), "[]");
  } finally { e.child.kill("SIGTERM"); await e.exited; }
});

test("a comment during a turn waits, in order, and never overlaps a turn", async () => {
  const e = setup();
  try {
    await e.until(() => e.calls().some((c: any) => c.prompt));   // the first turn is busy for 1.5 s
    appendFileSync(join(e.job, "inbox.jsonl"), JSON.stringify({ t: "comment", from: "o", text: "c1" }) + "\n" + JSON.stringify({ t: "comment", from: "o", text: "c2" }) + "\n");
    await e.until(() => e.calls().filter((c: any) => c.prompt).length === 3);
    const prompts = e.calls().filter((c: any) => c.prompt) as any[];
    assert.deepEqual(prompts.map((p) => p.text), ["first prompt", "c1", "c2"]);
    assert.ok(prompts.every((p) => p.busy === false), "a prompt was sent into a busy session");
  } finally { e.child.kill("SIGTERM"); await e.exited; }
});

test("stop: SIGTERM aborts the turn and exits 143 with no final", async () => {
  const e = setup();
  await e.until(() => e.calls().some((c: any) => c.prompt));
  e.child.kill("SIGTERM");
  const { code } = await e.exited;
  assert.equal(code, 143);
  assert.ok(e.calls().some((c: any) => c.abort));
  assert.match(readFileSync(e.log, "utf8"), /tmux kill-session -t l-test/);
  assert.ok(!e.events().some((x: any) => x.t === "final"));
});
