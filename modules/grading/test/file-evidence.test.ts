// A task that hands in a report as an attached text file: the grader sees the whole file, not its first few thousand characters.
// The report used to be cut at 6,000 characters (WOR-13241), so a 28,789-byte audit's findings were "not shown" and the task
// closed ungraded. Now the text goes as sequential FILES_<n> pages, each under the prompt's 20,000-character fence.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileEvidence } from "../service/src/grader/evidence.ts";
import { gradePrompt } from "../service/src/grader/grade.ts";

const file = (name: string, label = "file_1") => ({ id: name, originalFilename: name, contentType: "text/markdown", byteSize: 30_000, createdAt: "2026-01-01T00:00:00.000Z", label });
const read = (text: string) => async () => Buffer.from(text, "utf8");

/** A 30,000-character report whose last section sits well past the old 6,000-character cut. */
function audit(): string {
  const head = "# AppSec audit\n\n";
  const body = ("Finding: the session cookie is set without Secure.\n".repeat(20) + "\n").repeat(40);
  const last = "\n## Last section: the remaining findings\n\nRotate the leaked deploy key and require MFA on the admin console.\n";
  return (head + body).slice(0, 30_000 - last.length) + last;
}

test("a 30,000-character markdown attachment reaches the grader whole, as named pages", async () => {
  const text = audit();
  assert.equal(text.length, 30_000);
  const ev = await fileEvidence([file("audit.md")], read(text), { rubric: "the audit's last section is summarised" });
  assert.equal(ev.awaiting, undefined, "a readable file is not a wait");

  const blocks = Object.keys(ev.data).filter((k) => /^FILES_\d+$/.test(k)).sort();
  assert.ok(blocks.length >= 2, `the file is paged (${blocks.join(", ")})`);
  for (const name of blocks) {
    assert.match(ev.data[name]!, /^=== file_1: audit\.md, page \d+ of \d+ ===\n/, "each page is headed with the label, its name and the page");
    assert.ok(ev.data[name]!.length < 20_000, `${name} stays under the prompt's fence: ${ev.data[name]!.length}`);
  }

  const fact = ev.facts.find((f: string) => f.startsWith("file_1:"))!;
  assert.match(fact, /text, 30000 characters, shown in \d+ pages \(FILES_1, FILES_2/);
  assert.doesNotMatch(fact, /cut/, "the whole file fits, so nothing is marked cut");
  assert.doesNotMatch(Object.values(ev.data).join("\n"), /\[cut:/);

  // What gradePrompt builds is what the grader reads: the last section survives, and no page is cut by its 20,000 fence.
  const { user } = gradePrompt({ rubric: ["the audit's last section is summarised"], deliverable: { kind: "task" }, facts: ev.facts, data: ev.data });
  const prompt = typeof user === "string" ? user : user.map((p: any) => p.text ?? "").join("\n");
  assert.match(prompt, /Rotate the leaked deploy key and require MFA on the admin console\./, "the last section is in the prompt");
  assert.doesNotMatch(prompt, /\[cut: \d+ of 30000 characters not shown\]/, "no page is cut");
});

test("a text file past the total budget is cut, and its last page and fact say how much", async () => {
  const text = "a".repeat(90_000);
  const ev = await fileEvidence([file("huge.md")], read(text));
  const fact = ev.facts.find((f: string) => f.startsWith("file_1:"))!;
  assert.match(fact, /cut at the text budget of \d+ characters/);
  const joined = Object.values(ev.data).join("\n");
  assert.match(joined, /\[cut: \d+ of 90000 characters not shown\]/);
  for (const block of Object.values(ev.data)) assert.ok(block.length < 20_000, "a cut page still fits its fence");
});

test("a file that cannot be read stays awaiting, never silently not shown", async () => {
  const ev = await fileEvidence([file("audit.md")], async () => {
    throw new Error("the file store timed out");
  });
  assert.match(ev.awaiting, /the attached file_1 could not be read yet \(the file store timed out\)/);
  assert.equal(ev.data?.FILES_1, undefined, "nothing is sent as if the file were empty");
});
