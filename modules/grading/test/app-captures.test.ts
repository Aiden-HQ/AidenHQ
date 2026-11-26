// An app deliverable's attached captures are judged against the commit the app runs: a screenshot taken at an earlier
// iteration shows that code, never this deploy's page, so it is not sent to the grader and the fact says which code it shows.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { crc32, deflateSync } from "node:zlib";
import { fileEvidence } from "../service/src/grader/evidence.ts";

const DEPLOYED = "d".repeat(40);
const OLD = "a".repeat(40);

/** A 1x1 8-bit RGB PNG with the `aidenhq` tEXt stamp aidenhq-browse and ui-review write (a white pixel is enough here). */
function stampedPng(stamp: Record<string, unknown>): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, "latin1");
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
    return Buffer.concat([head, data, tail]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const text = Buffer.concat([Buffer.from("aidenhq", "latin1"), Buffer.from([0]), Buffer.from(JSON.stringify(stamp), "latin1")]);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("tEXt", text), chunk("IDAT", deflateSync(Buffer.from([0, 255, 255, 255]))), chunk("IEND", Buffer.alloc(0))]);
}

const file = (name: string) => ({ id: name, originalFilename: name, contentType: "image/png", byteSize: 100, createdAt: "2026-01-01T00:00:00.000Z", label: "file_1" });
const read = (bufl: Buffer) => async () => bufl;

describe("an app's attached captures", () => {
  it("sends a capture stamped at the deployed commit", async () => {
    const png = stampedPng({ commit: DEPLOYED, tree: "b".repeat(40), url: "http://127.0.0.1:8080/", width: 1280, mode: "light", takenAt: "2026-01-01T00:00:00.000Z" });
    const ev = await fileEvidence([file("home.png")], read(png), { deployed: DEPLOYED });
    assert.equal(ev.images.length, 1, "this deploy's own capture is sent");
    assert.doesNotMatch(ev.facts.join("\n"), /not sent/);
  });

  it("leaves out a capture stamped at another commit, and says which code it shows", async () => {
    const png = stampedPng({ commit: OLD, tree: "c".repeat(40), url: "http://127.0.0.1:8080/", width: 1280, mode: "light", takenAt: "2026-01-01T00:00:00.000Z" });
    const ev = await fileEvidence([file("home.png")], read(png), { deployed: DEPLOYED });
    assert.equal(ev.images.length, 0, "an earlier iteration's screenshot is not this deploy's page");
    const fact = ev.facts.find((f: string) => f.includes("file_1"))!;
    assert.match(fact, new RegExp(`stamped as taken at commit ${OLD.slice(0, 12)}`));
    assert.match(fact, new RegExp(`not the deployed commit ${DEPLOYED.slice(0, 12)}`));
  });

  it("still sends an unstamped image, and does not stamp-check for a pr's evidence", async () => {
    const plain = stampedPng({ url: "http://127.0.0.1:8080/" });
    const ev = await fileEvidence([file("mockup.png")], read(plain), { deployed: DEPLOYED });
    assert.equal(ev.images.length, 1, "a stamp with no commit proves nothing, so it is sent as before");
    const pr = await fileEvidence([file("home.png")], read(stampedPng({ commit: OLD })), { heads: [{ commits: [DEPLOYED], trees: ["e".repeat(40)] }] });
    assert.equal(pr.images.length, 0, "a pr's capture at another head is left out too");
  });
});
