import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "bun:test";
import { createAccess } from "../src/client.js";
import { denyExcept, officialProxy, signIn } from "../src/official.js";

const dir = () => mkdtempSync(join(tmpdir(), "github-official-"));

it("a new instance has no sign-in until Connect: the client says GitHub isn't connected", async () => {
  const state = dir();
  const access = createAccess({ auth: signIn({ clientId: "", mcpUrl: "https://api.githubcopilot.com/mcp/", stateDir: state }) });
  expect(existsSync(join(state, "token.json"))).toBe(false);
  expect(access.connected()).toBe(false);
  await expect(access.token()).rejects.toThrow("GitHub isn't connected");
});

/** The module's read tags for github_official, as compile hands them over (GITHUB_OFFICIAL_READ). */
function manifestReads(): string[] {
  const manifest = readFileSync(join(import.meta.dirname, "..", "..", "..", "module.yaml"), "utf8").split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
  const block = manifest.slice(manifest.indexOf("\n  github_official:"), manifest.indexOf("\ncodehost:"));
  const group = (key: string) => (new RegExp(`^\\s+${key}: \\[([^\\]]*)\\]`, "m").exec(block)?.[1] ?? "").split(",").map((t) => t.trim()).filter(Boolean);
  expect([...group("write"), ...group("destructive")]).toEqual([]);
  return group("read");
}

it("official denies every mutating tool", async () => {
  const reads = manifestReads();
  expect(reads).toContain("issue_read");
  const deny = denyExcept(reads);
  for (const t of ["add_issue_comment", "issue_write", "create_pull_request", "pull_request_review_write", "push_files", "merge_pull_request", "issue_read2"]) expect(deny.test(t), t).toBe(true);
  for (const t of reads) expect(deny.test(t), t).toBe(false);
  expect(denyExcept([]).test("issue_read"), "no list: nothing passes").toBe(true);

  // Through the proxy: a refused tool never reaches the upstream; a read is passed on (here to an upstream that isn't there).
  const state = dir();
  writeFileSync(join(state, "token.json"), JSON.stringify({ access_token: "gho_owner" }));
  const auth = signIn({ clientId: "Ov23example", mcpUrl: "http://127.0.0.1:9/mcp", stateDir: state });
  const log = { info: () => {}, warn: () => {}, error: () => {} } as never;
  const proxy = officialProxy({ auth, access: createAccess({ auth }), reads, mcpUrl: "http://127.0.0.1:9/mcp", log, stateDir: state, caller: async () => ({}) });
  for (const t of ["add_issue_comment", "issue_write", "create_pull_request"]) await expect(proxy.call(t, {})).rejects.toThrow(/not available through AidenHQ/);
  await expect(proxy.call("issue_read", {})).rejects.not.toThrow(/not available through AidenHQ/);
});
