import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { DENY, ownerToken, signIn } from "../src/official.js";

const dir = () => mkdtempSync(join(tmpdir(), "github-official-"));

it("an instance's old vault token becomes the sign-in once, and the tools use it as their bearer", async () => {
  const state = dir();
  const old = join(dir(), "github_token");
  writeFileSync(old, "gho_owner\n");
  const auth = signIn({ clientId: "Ov23example", mcpUrl: "https://api.githubcopilot.com/mcp/", stateDir: state, oldTokenFile: old });
  expect(statSync(join(state, "token.json")).mode & 0o777).toBe(0o600);
  const owner = ownerToken(auth);
  expect(owner.signedIn()).toBe(true);
  expect(await owner.get()).toBe("gho_owner");
  // Seeded once: a later sign-in (Reconnect) is never overwritten by the old token.
  writeFileSync(join(state, "token.json"), JSON.stringify({ access_token: "gho_new" }));
  signIn({ clientId: "Ov23example", mcpUrl: "https://api.githubcopilot.com/mcp/", stateDir: state, oldTokenFile: old });
  expect(JSON.parse(readFileSync(join(state, "token.json"), "utf8")).access_token).toBe("gho_new");
});

it("a new instance has no sign-in until Connect: the tools say so", async () => {
  const state = dir();
  const owner = ownerToken(signIn({ clientId: "", mcpUrl: "https://api.githubcopilot.com/mcp/", stateDir: state, oldTokenFile: join(state, "missing") }));
  expect(existsSync(join(state, "token.json"))).toBe(false);
  expect(owner.signedIn()).toBe(false);
  await expect(owner.get()).rejects.toThrow(/isn't connected/);
});

it("the official server's git writes are refused and tagged nowhere; everything tagged is reachable", () => {
  const manifest = readFileSync(join(import.meta.dirname, "..", "..", "..", "module.yaml"), "utf8").split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
  const block = manifest.slice(manifest.indexOf("\n  github_official:"), manifest.indexOf("\ncodehost:"));
  const group = (key: string) => (new RegExp(`^\\s+${key}: \\[([^\\]]*)\\]`, "m").exec(block)?.[1] ?? "").split(",").map((t) => t.trim()).filter(Boolean);
  const tools = { read: group("read"), write: group("write"), destructive: group("destructive") };
  expect(tools.read).toContain("get_file_contents");
  const tagged: string[] = [...tools.read, ...tools.write, ...tools.destructive];
  for (const t of ["push_files", "create_or_update_file", "merge_pull_request", "create_branch", "create_repository", "fork_repository", "delete_file", "update_pull_request_branch"]) {
    expect(DENY.test(t)).toBe(true);
    expect(tagged).not.toContain(t);
  }
  expect(tagged.filter((t) => DENY.test(t))).toEqual([]);
  // Owner-authored writes are destructive: a grant names each, and the reviewer decides every call.
  for (const t of ["add_issue_comment", "create_pull_request", "pull_request_review_write", "issue_write"]) expect(tools.destructive).toContain(t);
});
