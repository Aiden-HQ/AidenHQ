// Grading parity, recorded from the board's grade routes before grading became a module (lean-core 3h). One scripted
// scenario drives every completion outcome (pass, held, refused, accepted, cancelled, released) through today's routes with
// a frozen clock and records each answer, the grade row and the exact Paperclip patches. modules/grading/test/parity.test.mjs
// replays the same script through the kernel's finish gate and the grading module and must produce this file unchanged.
// RECORD=1 rewrites modules/grading/test/golden.json.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { asAgent } from "./caller.js";
import type { Paperclip } from "../src/paperclip.js";
import { Store } from "../src/store.js";

const GOLDEN = join(import.meta.dirname, "../../../modules/grading/test/golden.json");
const script = JSON.parse(readFileSync(join(import.meta.dirname, "../../../modules/grading/test/script.json"), "utf8"));

it("grading golden: every completion outcome, recorded from the board's routes", async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date(script.now) });
  const grantsFile = join(mkdtempSync(join(tmpdir(), "golden-")), "grants.json");
  const grants = (off = false) => writeFileSync(grantsFile, JSON.stringify({ ...script.grants, ...(off ? { grading: "off" } : {}) }));
  grants();
  process.env.AIDENHQ_GRANTS_FILE = grantsFile;
  const issues: Record<string, any> = structuredClone(script.issues);
  const byRef = (ref: string) => Object.values(issues).find((i) => i.id === ref || i.identifier === ref);
  let patches: { task: string; patch: unknown }[] = [];
  const pc = {
    companyId: "co",
    issue: async (ref: string) => structuredClone(byRef(ref) ?? (() => { throw new Error(`no task ${ref}`); })()),
    comments: async () => [],
    labels: async () => [{ id: "lbl-grading", name: "grading" }],
    agents: async () => script.agents,
    updateIssue: async (id: string, body: Record<string, unknown>) => {
      patches.push({ task: byRef(id).identifier, patch: body });
      Object.assign(byRef(id), body);
      return structuredClone(byRef(id));
    },
  } as unknown as Paperclip;
  const store = new Store(":memory:");
  const TOKEN = "t".repeat(64), RUNNER = "r".repeat(48);
  const app = createApp({ paperclip: pc, store, log: pino({ level: "silent" }), allowedHosts: ["board:3122"], staticDir: "/nonexistent", timezone: "UTC", mode: "internal", internalToken: TOKEN, reviewerKey: RUNNER });
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
  const port = (app.address() as AddressInfo).port;
  const call = (method: string, path: string, headers: Record<string, string>, body?: unknown) =>
    new Promise<{ status: number; json: any }>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, method, path, headers: { host: "board:3122", "content-type": "application/json", authorization: `Bearer ${TOKEN}`, ...headers } }, (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => resolve({ status: res.statusCode!, json: text ? JSON.parse(text) : undefined }));
      });
      req.on("error", reject);
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  const runner = { "x-reviewer-key": RUNNER };
  const id = (ref: string) => byRef(ref).id;
  const out: unknown[] = [];
  try {
    for (const s of script.steps) {
      patches = [];
      let r: { status: number; json: any } | undefined;
      if (s.set) Object.assign(byRef(s.task), s.set);
      if (s.grading) grants(s.grading === "off");
      if (s.op === "file") r = await call("POST", "/internal/grades", asAgent(s.as, { tool: s.tool ?? "task_delegate" }), { issue: s.task, rubric: s.rubric, deliverable: s.deliverable });
      if (s.op === "close") r = await call("POST", `/internal/grades/${id(s.task)}/gate`, s.via.startsWith("finish_") ? runner : asAgent(s.as, { tool: s.via }), { via: s.via });
      if (s.op === "verdict") r = await call("POST", `/internal/grades/${s.task}/verdict`, runner, s.verdict);
      if (s.op === "resubmit") r = await call("POST", `/internal/grades/${s.task}/resubmit`, runner, { version: s.version });
      if (s.op === "release") r = await call("POST", `/internal/grades/${s.task}/release`, runner, {});
      if (s.op === "list") r = await call("GET", "/internal/grades", runner);
      if (s.op === "state") r = await call("GET", `/internal/grades/${id(s.task)}`, runner);
      out.push({ step: s.name, ...normalize(s, r!), row: row(store.grades.get(id(s.task ?? "WOR-1"))), patches });
    }
  } finally {
    app.close();
    vi.useRealTimers();
  }
  if (process.env.RECORD) writeFileSync(GOLDEN, JSON.stringify(out, null, 1) + "\n");
  expect(out).toEqual(JSON.parse(readFileSync(GOLDEN, "utf8")));
});

/** One answer in the shape both implementations share: a close passes, is held in a grade state, or is refused with a status. */
function normalize(s: { op: string }, r: { status: number; json: any }) {
  if (r.status >= 300) return { status: r.status, error: r.json?.error ?? null };
  if (s.op === "close") return { close: r.json.pass ? "pass" : `held:${r.json.state}` };
  if (s.op === "list") return { on: r.json.on, due: r.json.grades.map((g: any) => g.issueId), resubmitted: r.json.resubmitted.map((g: any) => g.issueId) };
  if (s.op === "verdict" || s.op === "resubmit") return { state: r.json.state };
  return { body: r.json };
}

/** A grade row without its timestamps (the clock is frozen, so they would match anyway; this keeps the file readable). */
function row(g: any) {
  if (!g) return null;
  const { createdAt, updatedAt, ...rest } = g;
  return { ...rest, verdicts: g.verdicts.map(({ at, ...v }: any) => v) };
}
