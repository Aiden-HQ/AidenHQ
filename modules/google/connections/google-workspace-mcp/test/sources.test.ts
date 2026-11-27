import { expect, it } from "bun:test";
import type { SourceStore } from "../src/source-store.js";
import { syncDrive } from "../src/sources.js";

// The writer side against a fake store (the SQL is the shared source-store's): what lands, with which baseline flag.
function fakeStore(due: Record<string, unknown>[] = []) {
  const scopes = new Map<string, { baselined: boolean; cursor: string | null }>();
  const writes: { row: Record<string, any>; baseline: boolean }[] = [];
  const queries: unknown[][] = [];
  const store = {
    migrate: async () => undefined,
    scope: async (s: string) => scopes.get(s) ?? { baselined: false, cursor: null },
    saveScope: async (s: string, cursor: string | null, baselined = false) => void scopes.set(s, { baselined: baselined || !!scopes.get(s)?.baselined, cursor }),
    upsert: async (_t: unknown, row: Record<string, any>, o: { baseline: boolean }) => (writes.push({ row, baseline: o.baseline }), "new"),
    pool: { query: async (_q: string, v: unknown[]) => (queries.push(v), { rows: due }) },
  };
  return { store: store as unknown as SourceStore, writes, scopes, queries };
}

const file = (id: string, modifiedTime: string) => ({
  id, name: `Doc ${id}`, mimeType: "application/vnd.google-apps.document", modifiedTime, version: "12", webViewLink: `https://docs.google.com/d/${id}`,
  driveId: "drv1", owners: [{ displayName: "Ann", emailAddress: "Ann@X.com" }],
});

it("src_docs: a pass that hits the file cap resumes the same query at its page token, so one shared timestamp never loops", async () => {
  const { store, scopes } = fakeStore();
  const pages: [string, string | undefined][] = [];
  const same = "2026-11-09T10:00:00.000Z";
  const drive = {
    changedFiles: async (since: string, page?: string) => {
      pages.push([since, page]);
      const n = Number(page ?? 0);
      return { files: Array.from({ length: 250 }, (_, i) => file(`d${n}-${i}`, same)), nextPageToken: n < 2 ? String(n + 1) : undefined };
    },
    readFile: async () => ({ text: "", truncated: false }),
  };
  const now = Date.parse("2026-11-11T00:00:00Z");
  await syncDrive(store, drive, now);
  expect(scopes.get("drive")).toEqual({ baselined: false, cursor: `2026-10-12T00:00:00.000Z#2#${same}` });
  await syncDrive(store, drive, now);
  expect(pages.at(-1)).toEqual(["2026-10-12T00:00:00.000Z", "2"]);
  expect(scopes.get("drive")).toEqual({ baselined: true, cursor: same });
});
