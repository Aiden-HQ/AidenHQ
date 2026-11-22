import { expect, it } from "vitest";
import { openPrs, recordedOpenPrs } from "../src/open-prs.js";

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
  const out = await recordedOpenPrs(ours, rows, list);
  expect(calls).toEqual(["acme/app", "other/tool"]);
  expect(out.map((x) => `${x.repo}#${x.number}${x.draft ? " draft" : ""}`)).toEqual(["acme/app#7", "acme/app#8 draft", "other/tool#3"]);
});

it("a code host failure for a repo the warehouse doesn't hold fails the GitHub read", async () => {
  await expect(recordedOpenPrs([{ repo: "other/tool", number: 3 }], [], async () => { throw new Error("the kernel said 403"); })).rejects.toThrow("403");
});

it("a recorded issue's warehouse row rules it out; a repo outside the grant is skipped, another failure or a full list with a number missing throws", async () => {
  const issue = { ...row("acme/app", 5), kind: "issue", state: "open" };
  const calls: string[] = [];
  expect(await recordedOpenPrs([{ repo: "acme/app", number: 5 }], [issue], async (r) => (calls.push(r), []))).toEqual([]);
  expect(calls).toEqual([]);
  const denied = async () => { throw Object.assign(new Error("no read grant"), { status: 403 }); };
  expect(await recordedOpenPrs([{ repo: "far/away", number: 1 }], [], denied)).toEqual([]);
  await expect(recordedOpenPrs([{ repo: "far/away", number: 1 }], [], async () => { throw Object.assign(new Error("503"), { status: 503 }); })).rejects.toThrow("503");
  const full = Array.from({ length: 500 }, (_, i) => ({ number: 1000 + i, created_at: "2026-11-22T08:00:00Z" }));
  await expect(recordedOpenPrs([{ repo: "far/away", number: 1 }], [], async () => full)).rejects.toThrow("500 or more");
});
