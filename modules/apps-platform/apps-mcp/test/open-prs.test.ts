import { expect, it } from "vitest";
import { openPrs } from "../src/open-prs.js";

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
