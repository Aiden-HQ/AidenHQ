// The grader's reads: a module token the kernel says holds apps.read reads; any other caller, the internal token included, is refused.
import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { appsReader } from "../src/readers.js";

const who: Record<string, object> = { "grading-token": { kind: "module", module: "grading", roles: ["kernel.cp-read", "apps.read"] }, "tasks-token": { kind: "module", module: "tasks", roles: ["kernel.tasks"] }, "job-token": { kind: "job", roles: ["apps.read"] } };
const kernel = (async (_url: string, init: { headers: Record<string, string> }) => {
  const w = who[init.headers.authorization!.replace("Bearer ", "")];
  return new Response(JSON.stringify(w ?? { error: "unauthorized" }), { status: w ? 200 : 401 });
}) as unknown as typeof fetch;
const read = appsReader("http://kernel", kernel);
const req = (token: string) => ({ headers: { authorization: `Bearer ${token}` } }) as IncomingMessage;

describe("apps-mcp grader reads", () => {
  it("a module holding apps.read reads", async () => expect(await read(req("grading-token"))).toBe(0));
  it("a module without apps.read, or a job holding it, is refused; any other token (the internal one too) is unauthorized", async () => {
    expect(await read(req("tasks-token"))).toBe(403);
    expect(await read(req("job-token"))).toBe(403);
    expect(await read(req("internal-token"))).toBe(401);
  });
});
