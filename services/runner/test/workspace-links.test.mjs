// The workspace is the agent's to write (jail or box): a link it plants in .aidenhq never makes the runner share, publish or
// overwrite a host file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { outputs, syncFiles } from "../src/files.ts";
import { readDocument } from "../src/primer.ts";
import { readManifest } from "../../../modules/codehost-github/src/workspace.ts";

test("links in .aidenhq are never followed: no host file shared, published, read as the manifest or overwritten", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "aidenhq-links-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const secret = join(dir, "secret");
  writeFileSync(secret, "# the owner key\n[]\n");
  const ws = join(dir, "ws");
  mkdirSync(join(ws, ".aidenhq/out"), { recursive: true });
  writeFileSync(join(ws, ".aidenhq/out/report.md"), "ok\n");
  symlinkSync(secret, join(ws, ".aidenhq/out/key.md"));
  symlinkSync(secret, join(ws, ".aidenhq/primer.md"));
  symlinkSync(secret, join(ws, ".aidenhq/branches.json"));
  // Read on the open descriptor: a FIFO never blocks the runner, a file past Paperclip's limit isn't read.
  execFileSync("mkfifo", [join(ws, ".aidenhq/out/pipe.md")]);
  writeFileSync(join(ws, ".aidenhq/out/huge.log"), Buffer.alloc(11 * 1024 * 1024));
  const shared = outputs(ws);
  assert.deepEqual(shared.map((f) => f.name), ["report.md"]);
  assert.equal(shared[0].data.toString(), "ok\n", "the bytes shared are the ones read safely");
  assert.equal(readDocument(ws, "T"), undefined);
  assert.deepEqual(readManifest(ws), []);

  // .aidenhq itself a link to a folder elsewhere: nothing in it is shared, and task files aren't written through it.
  const ws2 = join(dir, "ws2");
  const elsewhere = join(dir, "elsewhere");
  mkdirSync(join(elsewhere, "out"), { recursive: true });
  mkdirSync(join(elsewhere, "files"));
  writeFileSync(join(elsewhere, "out/x.md"), "x\n");
  mkdirSync(ws2);
  symlinkSync(elsewhere, join(ws2, ".aidenhq"));
  assert.deepEqual(outputs(ws2), []);
  const pc = { attachments: async (id) => (id === "i" ? [{ id: "f1", originalFilename: "a.txt", contentType: "text/plain", byteSize: 3, createdAt: "1" }] : []), attachmentContent: async () => Buffer.from("new") };
  assert.deepEqual(await syncFiles(pc, { id: "i", identifier: "PEN-1" }, ws2), []);
  // A link where a task file goes is replaced, never written through.
  const ws3 = join(dir, "ws3");
  mkdirSync(join(ws3, ".aidenhq/files"), { recursive: true });
  symlinkSync(secret, join(ws3, ".aidenhq/files/a.txt"));
  await syncFiles(pc, { id: "i", identifier: "PEN-1" }, ws3);
  assert.equal(readFileSync(secret, "utf8"), "# the owner key\n[]\n");
  assert.equal(readFileSync(join(ws3, ".aidenhq/files/a.txt"), "utf8"), "new");
});
