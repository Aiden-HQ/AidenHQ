// The grader's reads: a module token the kernel says holds apps.read reads, one without is refused, and neither deploys.
import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { internalAccess } from "../src/readers.js";

const who: Record<string, object> = { "grading-token": { kind: "module", module: "grading", roles: ["kernel.cp-read", "apps.read"] }, "tasks-token": { kind: "module", module: "tasks", roles: ["kernel.tasks"] }, "job-token": { kind: "job", roles: ["apps.read"] } };
const kernel = (async (_url: string, init: { headers: Record<string, string> }) => {
  const w = who[init.headers.authorization!.replace("Bearer ", "")];
  return new Response(JSON.stringify(w ?? { error: "unauthorized" }), { status: w ? 200 : 401 });
}) as unknown as typeof fetch;
const access = internalAccess("http://kernel", "internal-token", kernel);
const req = (token: string) => ({ headers: { authorization: `Bearer ${token}` } }) as IncomingMessage;

describe("apps-mcp internal access", () => {
  it("a module holding apps.read reads; the internal token reads and writes", async () => {
    expect(await access(req("grading-token"), "read")).toBe(0);
    expect(await access(req("internal-token"), "read")).toBe(0);
    expect(await access(req("internal-token"), "write")).toBe(0);
  });
  it("a module without apps.read, or a job holding it, is refused; an unknown token is unauthorized", async () => {
    expect(await access(req("tasks-token"), "read")).toBe(403);
    expect(await access(req("job-token"), "read")).toBe(403);
    expect(await access(req("nope"), "read")).toBe(401);
  });
  it("a read token can't deploy", async () => {
    expect(await access(req("grading-token"), "write")).toBe(401);
  });
});
