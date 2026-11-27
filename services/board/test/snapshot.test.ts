import { expect, it } from "bun:test";
import { Paperclip, type Issue } from "../src/paperclip.js";
import { Swr } from "../src/swr.js";

const at = (s: number) => new Date(Date.now() + s * 1000).toISOString();
const issue = (n: number, status: string, updatedAt: string): Issue => ({ id: `id-${n}`, identifier: `WOR-${n}`, title: `T${n}`, description: null, status, priority: "medium", assigneeUserId: null, assigneeAgentId: null, assigneeAdapterOverrides: null, createdAt: at(-900), updatedAt });

it("serves the open and recent closed issues from memory, brought up to date by what changed", async () => {
  let rows = [issue(1, "todo", at(-600)), issue(2, "todo", at(-600)), issue(3, "done", at(-60))];
  const asked: string[] = [];
  const fetchImpl = (async (url: URL, init: RequestInit = {}) => {
    const q = url.searchParams;
    asked.push(`${init.method ?? "GET"} ${q.get("status")}`);
    if ((init.method ?? "GET") !== "GET") return new Response("{}", { status: 200 });
    const want = new Set(String(q.get("status")).split(","));
    const since = q.get("updatedSince");
    return new Response(JSON.stringify(rows.filter((i) => want.has(i.status) && (!since || i.updatedAt > since))), { status: 200 });
  }) as unknown as typeof fetch;
  const pc = new Paperclip("http://kernel", "co", "key", fetchImpl);

  expect((await pc.openIssues()).map((i) => i.identifier).sort()).toEqual(["WOR-1", "WOR-2"]);
  await pc.closedListed(at(-3600));
  const full = asked.length; // one full inventory: open and closed
  await pc.openIssues();
  expect(asked.length).toBe(full); // fresh: no read

  // An agent closes WOR-1; a later read sees it through one incremental read, not a full inventory.
  rows = [issue(1, "done", at(0)), rows[1]!, rows[2]!];
  await pc.updateIssue("id-1", { status: "done" }); // the board's own write: the next read looks again
  expect((await pc.openIssues()).map((i) => i.identifier)).toEqual(["WOR-2"]);
  expect((await pc.closedListed(at(-3600))).issues.map((i) => i.identifier).sort()).toEqual(["WOR-1", "WOR-3"]);
  expect(asked.slice(full).filter((a) => a.startsWith("GET")).length).toBe(1);
});

it("fails the read when its refresh fails, rather than serve inventory that may have changed", async () => {
  let down = false;
  const fetchImpl = (async () => (down ? new Response("{}", { status: 500 }) : new Response(JSON.stringify([issue(1, "todo", at(-600))]), { status: 200 }))) as unknown as typeof fetch;
  const pc = new Paperclip("http://kernel", "co", "key", fetchImpl);
  await pc.openIssues();
  down = true;
  await pc.updateIssue("id-1", {}).catch(() => {}); // dirty: the next read tries again, and fails
  await expect(pc.openIssues()).rejects.toThrow();
});

it("serves the last good response while a fresh one is read, one read at a time", async () => {
  const swr = new Swr();
  let reads = 0;
  let release!: (v: { n: number }) => void;
  const load = () => (++reads === 1 ? Promise.resolve({ n: 1 }) : new Promise<{ n: number }>((r) => (release = r)));
  expect(await swr.serve("k", load)).toEqual({ n: 1 });
  expect(await swr.serve("k", load)).toEqual({ n: 1 }); // fresh: no second read
  swr.touch();
  const [a, b] = await Promise.all([swr.serve("k", load), swr.serve("k", load)]);
  expect(a).toEqual({ n: 1, stale: true });
  expect(b).toEqual({ n: 1, stale: true });
  expect(reads).toBe(2); // both shared one read
  release({ n: 2 });
  await new Promise((r) => setTimeout(r, 5));
  swr.touch();
  expect(await swr.serve("k", async () => ({ n: 3 }))).toEqual({ n: 3 });
});

it("keeps one read per key, and marks what a change outran as stale", async () => {
  const swr = new Swr();
  let reads = 0;
  let release!: (v: { n: number }) => void;
  const load = () => (++reads === 1 ? new Promise<{ n: number }>((r) => (release = r)) : Promise.resolve({ n: 2 }));
  const first = swr.serve("k", load);
  swr.touch(); // a change while that read is under way
  const second = swr.serve("k", load); // joins it: no pile-up of reads
  release({ n: 1 });
  expect(await first).toEqual({ n: 1, stale: true });
  expect(await second).toEqual({ n: 1, stale: true });
  expect(reads).toBe(1);
  expect(await swr.serve("k", load)).toEqual({ n: 2 }); // the client's retry reads again
});
