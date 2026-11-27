import { readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { PathRejectedError } from "../src/util/errors.js";
import { resolveAbsoluteWithin, resolveVaultPath } from "../src/util/paths.js";
import { Vault } from "../src/vault/vault.js";
import { makeEnv } from "./helpers.js";

describe("transcript path safety", () => {
  it("rejects ../ traversal and symlinks outside the transcript root", async () => {
    const env = makeEnv();
    const secret = join(env.dir, "secret.txt");
    writeFileSync(secret, "top secret");
    expect(() => resolveAbsoluteWithin(join(env.transcripts, "../../secret.txt"), [env.transcripts])).toThrow(PathRejectedError);
    expect(() => resolveAbsoluteWithin(join(env.transcripts, "../secret.txt"), [env.transcripts])).toThrow(PathRejectedError);

    symlinkSync(secret, join(env.transcripts, "evil.txt"));
    const report = await env.app.meetings.scan();
    expect(report.new_sources).toBe(0);
    expect(report.rejected).toEqual([{ file: "evil.txt", reason: "Path rejected: outside configured roots" }]);
  });

});

describe("vault path safety", () => {
  it("rejects traversal, absolute, hidden and out-of-scope paths", () => {
    const env = makeEnv();
    writeFileSync(join(env.vault, "Personal", "diary.md"), "private");
    const roots = ["Projects", "Meetings"];
    for (const bad of ["../secret.md", "Projects/../../x.md", "/etc/passwd", ".obsidian/app.json", "Personal/diary.md", "Projects/../Personal/diary.md"]) {
      expect(() => resolveVaultPath(env.vault, bad, roots), bad).toThrow(PathRejectedError);
    }
    expect(resolveVaultPath(env.vault, "Projects/New Note.md", roots).rel).toBe("Projects/New Note.md");
  });

  it("rejects a symlinked folder that escapes the allowed roots", () => {
    const env = makeEnv();
    symlinkSync(join(env.vault, "Personal"), join(env.vault, "Projects", "sneaky"));
    const vault = new Vault(env.cfg.vault);
    expect(() => vault.createNote("Projects/sneaky/x.md", "hi")).toThrow(PathRejectedError);
    expect(() => vault.read("Projects/sneaky/x.md")).toThrow(PathRejectedError);
  });

  it("never overwrites an existing note on create", () => {
    const env = makeEnv();
    const vault = new Vault(env.cfg.vault);
    writeFileSync(join(env.vault, "Projects", "A.md"), "human content");
    expect(() => vault.createNote("Projects/A.md", "machine")).toThrow(/EEXIST/);
    expect(readFileSync(join(env.vault, "Projects", "A.md"), "utf8")).toBe("human content");
  });
});

describe("Obsidian concurrency", () => {
  it("detects a change between read and write, refetches, retries and keeps human edits", () => {
    const env = makeEnv();
    const vault = new Vault(env.cfg.vault);
    const path = join(env.vault, "Projects", "P.md");
    writeFileSync(path, "# P\n\n## Meeting Log\n\n");
    let calls = 0;
    vault.beforeCommit = (abs, attempt) => {
      calls++;
      if (attempt === 1) writeFileSync(abs, readFileSync(abs, "utf8") + "human line added mid-write\n");
    };
    const r = vault.appendUnderHeading("Projects/P.md", "Meeting Log", "### entry\n<!-- paperclip-meeting:e1 -->", "<!-- paperclip-meeting:e1 -->");
    expect(r).toMatchObject({ status: "written", attempts: 2 });
    expect(calls).toBe(2);
    const after = readFileSync(path, "utf8");
    expect(after).toContain("human line added mid-write");
    expect(after).toContain("paperclip-meeting:e1");
  });

});
