import { expect, it } from "bun:test";
import { openPrs, recordedOpenPrs } from "../src/open-prs.js";

const none = async () => null;

const row = (repo: string, number: number) => ({ repo, number, opened_at: "2026-11-22T10:00:00Z", draft: false });

it("lists the GitHub PRs the kernel recorded and the local change requests together", async () => {
  expect(await openPrs(async () => [row("local/app", 1)], async () => [row("acme/app", 7)], () => {})).toEqual({ prs: [row("acme/app", 7), row("local/app", 1)] });
});

it("a failed GitHub read still returns the local rows, marked so the detector keeps its GitHub incidents", async () => {
  let warned = 0;
  const out = await openPrs(async () => [row("local/app", 1)], async () => { throw new Error("the kernel said 503"); }, () => warned++);
  expect(out).toEqual({ prs: [row("local/app", 1)], github_error: true });
  expect(warned).toBe(1);
});

it("a GitHub read that stalls past the deadline returns the local rows, marked", async () => {
  const out = await openPrs(async () => [row("local/app", 1)], () => new Promise(() => {}), () => {}, 20);
  expect(out).toEqual({ prs: [row("local/app", 1)], github_error: true });
});

it("a recorded PR the warehouse has no row for gets its state from the code host's list of the repo, one call per repo", async () => {
  const ours = [{ repo: "acme/app", number: 7 }, { repo: "acme/app", number: 8 }, { repo: "other/tool", number: 3 }, { repo: "other/tool", number: 4 }, { repo: "acme/app", number: 9 }];
  // 7 is open in the warehouse, 9 is closed there; 8, 3 and 4 have no row.
  const rows = [{ ...row("Acme/App", 7), kind: "pr", state: "open" }, { ...row("acme/app", 9), kind: "pr", state: "closed" }];
  const calls: string[] = [];
  const list = async (repo: string) => (calls.push(repo), repo === "acme/app" ? [{ number: 8, draft: true, created_at: "2026-11-22T09:00:00Z" }, { number: 50, created_at: "2026-11-22T09:00:00Z" }] : [{ number: 3, created_at: "2026-11-22T08:00:00Z" }]);
  const out = await recordedOpenPrs(ours, rows, list, none);
  expect(calls).toEqual(["acme/app", "other/tool"]);
  expect(out.map((x) => `${x.repo}#${x.number}${x.draft ? " draft" : ""}`)).toEqual(["acme/app#7", "acme/app#8 draft", "other/tool#3"]);
});

it("a code host failure for a repo the warehouse doesn't hold fails the GitHub read", async () => {
  await expect(recordedOpenPrs([{ repo: "other/tool", number: 3 }], [], async () => { throw new Error("the kernel said 403"); }, none)).rejects.toThrow("403");
});

it("a recorded issue's warehouse row rules it out; a repo outside the grant is skipped, another failure or a full list with a number missing throws", async () => {
  const issue = { ...row("acme/app", 5), kind: "issue", state: "open" };
  const calls: string[] = [];
  expect(await recordedOpenPrs([{ repo: "acme/app", number: 5 }], [issue], async (r) => (calls.push(r), []), none)).toEqual([]);
  expect(calls).toEqual([]);
  const denied = async () => { throw Object.assign(new Error("no read grant"), { status: 403 }); };
  expect(await recordedOpenPrs([{ repo: "far/away", number: 1 }], [], denied, none)).toEqual([]);
  // A deleted repo: the code host wraps GitHub's 404 as a 502, and one such repo doesn't fail the others.
  const gone = async (r: string) => { if (r === "gone/repo") throw Object.assign(new Error("the kernel said 502 to read: GitHub GET /repos/gone/repo/pulls: 404 Not Found"), { status: 502 }); return [{ number: 2, created_at: "2026-11-22T08:00:00Z" }]; };
  expect(await recordedOpenPrs([{ repo: "gone/repo", number: 1 }, { repo: "far/away", number: 2 }], [], gone, none)).toEqual([{ repo: "far/away", number: 2, opened_at: "2026-11-22T08:00:00Z", draft: false }]);
  await expect(recordedOpenPrs([{ repo: "far/away", number: 1 }], [], async () => { throw Object.assign(new Error("the kernel said 502 to read: GitHub GET /repos/far/away/pulls: 500 Server Error"), { status: 502 }); }, none)).rejects.toThrow("500");
  await expect(recordedOpenPrs([{ repo: "far/away", number: 1 }], [], async () => { throw Object.assign(new Error("503"), { status: 503 }); }, none)).rejects.toThrow("503");
});

it("a full open list is not read as closed: each recorded PR missing from it is read on its own", async () => {
  const full = Array.from({ length: 500 }, (_, i) => ({ number: 1000 + i, created_at: "2026-11-22T08:00:00Z" }));
  const read: number[] = [];
  const pr = async (_r: string, n: number) => (read.push(n), n === 1 ? { state: "OPEN", isDraft: true, createdAt: "2026-11-21T08:00:00Z" } : n === 2 ? { state: "MERGED", isDraft: false, createdAt: "2026-11-21T08:00:00Z" } : null);
  const out = await recordedOpenPrs([{ repo: "far/away", number: 1 }, { repo: "far/away", number: 2 }, { repo: "far/away", number: 3 }, { repo: "far/away", number: 1000 }], [], async () => full, pr);
  expect(read).toEqual([1, 2, 3]);
  expect(out.map((x) => `${x.number}${x.draft ? " draft" : ""}`)).toEqual(["1000", "1 draft"]);
});

it("every row's repo is lower-case whichever source answers", async () => {
  const ours = [{ repo: "acme/app", number: 7 }, { repo: "acme/app", number: 8 }];
  const viaHost = await recordedOpenPrs(ours, [], async () => [{ number: 7, created_at: "2026-11-22T08:00:00Z" }], async () => null);
  const viaWarehouse = await recordedOpenPrs(ours, [{ ...row("Acme/App", 7), kind: "pr", state: "open" }], async () => [], none);
  expect([...viaHost, ...viaWarehouse].map((x) => `${x.repo}#${x.number}`)).toEqual(["acme/app#7", "acme/app#7"]);
});

it("in a full list's per-PR reads, an unreadable PR skips only itself", async () => {
  const full = Array.from({ length: 500 }, (_, i) => ({ number: 1000 + i }));
  const read: number[] = [];
  const pr = async (_r: string, n: number) => {
    read.push(n);
    if (n === 1) throw Object.assign(new Error("gone"), { status: 404 });
    if (n === 2) throw Object.assign(new Error("the kernel said 502 to read: GitHub GET /repos/far/away/pulls: 410 Gone"), { status: 502 });
    return { state: "OPEN", isDraft: false, createdAt: "2026-11-21T08:00:00Z" };
  };
  const out = await recordedOpenPrs([1, 2, 3].map((number) => ({ repo: "far/away", number })), [], async () => full, pr);
  expect(read).toEqual([1, 2, 3]);
  expect(out.map((x) => x.number)).toEqual([3]);
});
