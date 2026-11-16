import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createGrading, gradePassed } from "../src/grading.js";

describe("grading client", () => {
  it("sends the bearer from the key file, and an unreachable module throws", async () => {
    const keyFile = join(mkdtempSync(join(tmpdir(), "grading-")), "key");
    writeFileSync(keyFile, "secret\n");
    const seen: { url: string; auth: string; body: unknown }[] = [];
    const ok = (async (url: string, init: RequestInit) => {
      seen.push({ url, auth: (init.headers as Record<string, string>).authorization!, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ on: true, grades: { a: { issueId: "a", state: "escalated" } } }));
    }) as unknown as typeof fetch;
    const view = await createGrading({ url: "http://grading:8096/", keyFile, fetchFn: ok }).grades(["a", "b"]);
    expect(seen).toEqual([{ url: "http://grading:8096/board/grades", auth: "Bearer secret", body: { ids: ["a", "b"] } }]);
    expect([gradePassed(view, "a"), gradePassed(view, "b"), gradePassed({ ...view, on: false }, "a")]).toEqual([false, true, true]);
    const down = createGrading({ keyFile, fetchFn: (async () => Promise.reject(new Error("ECONNREFUSED"))) as unknown as typeof fetch });
    await expect(down.grades(["a"])).rejects.toThrow();
  });
});
