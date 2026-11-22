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
      const ids = JSON.parse(String(init.body)).ids as string[];
      return new Response(JSON.stringify({ grades: Object.fromEntries(ids.map((id) => [id, id === "a" ? { issueId: "a", state: "needs_revision" } : null])) }));
    }) as unknown as typeof fetch;
    const view = await createGrading({ url: "http://grading:8096/", keyFile, fetchFn: ok }).grades(["a", "b"]);
    expect(seen).toEqual([{ url: "http://grading:8096/board/grades", auth: "Bearer secret", body: { ids: ["a", "b"] } }]);
    // b: the module said it has no row. z: never answered, so unknown: never read as ungraded.
    expect([gradePassed(view, "a"), gradePassed(view, "b"), gradePassed(view, "z")]).toEqual([false, true, false]);
    const down = createGrading({ keyFile, fetchFn: (async () => Promise.reject(new Error("ECONNREFUSED"))) as unknown as typeof fetch });
    await expect(down.grades(["a"])).rejects.toThrow();
  });

  it("asks for every id, in batches of 500; an id the module didn't answer fails closed", async () => {
    const keyFile = join(mkdtempSync(join(tmpdir(), "grading-")), "key");
    writeFileSync(keyFile, "secret\n");
    const batches: number[] = [];
    // The module answers every id it is asked about but one ("t-777"): a row for t-1000, null for the rest.
    const fetchFn = (async (_url: string, init: RequestInit) => {
      const ids = JSON.parse(String(init.body)).ids as string[];
      batches.push(ids.length);
      return new Response(JSON.stringify({ grades: Object.fromEntries(ids.filter((id) => id !== "t-777").map((id) => [id, id === "t-1000" ? { issueId: id, state: "pending" } : null])) }));
    }) as unknown as typeof fetch;
    const ids = Array.from({ length: 1201 }, (_, i) => `t-${i}`);
    const view = await createGrading({ keyFile, fetchFn }).grades(ids);
    expect(batches).toEqual([500, 500, 201]);
    expect(gradePassed(view, "t-1200")).toBe(true); // past 500, answered: no row
    expect(gradePassed(view, "t-1000")).toBe(false); // past 500, held for grading
    expect(gradePassed(view, "t-777")).toBe(false); // not answered: unknown
  });
});
