import { chmodSync, existsSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EXTRACTION, event, makeEnv, writeAt } from "./helpers.js";

/** A PCM WAV header at `byteRate` bytes/s followed by `seconds` of silence. */
function writeWav(path: string, seconds: number, mtime: string, byteRate = 100): void {
  const data = Buffer.alloc(seconds * byteRate);
  const h = Buffer.alloc(44);
  h.write("RIFF", 0, "ascii");
  h.writeUInt32LE(36 + data.length, 4);
  h.write("WAVEfmt ", 8, "ascii");
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(2, 22);
  h.writeUInt32LE(byteRate / 4, 24);
  h.writeUInt32LE(byteRate, 28);
  h.writeUInt16LE(4, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36, "ascii");
  h.writeUInt32LE(0, 40); // unfinalized, as when the recorder dies: the file size is used instead
  writeFileSync(path, Buffer.concat([h, data]));
  utimesSync(path, Date.parse(mtime) / 1000, Date.parse(mtime) / 1000);
}

const self = { email: "alex@example.com", self: true };
const dana = event({ id: "dana_1", title: "Alex / Dana (weekly)", start: "2026-10-04T15:00:00+02:00", end: "2026-10-04T15:30:00+02:00", attendees: [self, { email: "dana@example.com" }] });
const eli = event({ id: "eli_1", title: "Alex / Eli", start: "2026-10-04T15:30:00+02:00", end: "2026-10-04T16:00:00+02:00", attendees: [self, { email: "eli@example.com" }] });
const NOTE = "Meetings/2026/10/2026-10-04 1500 - Alex Dana (weekly).md";

async function record(env: ReturnType<typeof makeEnv>) {
  writeWav(join(env.transcripts, "2026-10-04_15-13-58.wav"), 8 * 60 + 42, "2026-10-04T15:22:40+02:00");
  writeAt(join(env.transcripts, "2026-10-04_15-13-58.txt"), "[Them] shall we start?\n[Me] Sure.\n", "2026-10-04T15:28:18+02:00");
  env.now.ms = Date.parse("2026-10-04T15:40:00+02:00");
  const scan = (await env.app.meetings.scan()) as { work: { source_id: string; label: string }[] };
  return scan.work.find((w) => w.label === "2026-10-04_15-13-58.txt")!.source_id;
}

describe("recorded transcripts", () => {
  it("auto-match by the recording's span, then get the meeting's name and lose the audio", async () => {
    const env = makeEnv({ routing: "routes: []\n" });
    const id = await record(env);
    const m = (await env.app.meetings.match({ source_id: id, calendar_status: "ok", events: [dana, eli], hints: { title_guesses: [], people: [] } })) as { status: string; event_id: string };
    expect(m).toMatchObject({ status: "matched", event_id: "dana_1" });
    expect(env.paperclip.byLabel("needs-review")).toHaveLength(0);

    const pub = await env.app.meetings.publish(id, { ...EXTRACTION, actions: [] });
    expect(pub.status).toBe("processed");
    expect(pub.transcript).toEqual({ file: "Dana-2026-10-04.txt", audio_deleted: true });
    expect(readdirSync(env.transcripts).sort()).toEqual(["1-1s"]);
    expect(readdirSync(join(env.transcripts, "1-1s"))).toEqual(["Dana-2026-10-04.txt"]);
    expect(readFileSync(join(env.vault, NOTE), "utf8")).toContain("- local-transcript: Dana-2026-10-04.txt");

    // The renamed file is the same source: nothing new to do, and its text is still readable.
    const again = (await env.app.meetings.scan()) as { new_sources: number; work: unknown[] };
    expect(again).toMatchObject({ new_sources: 0, work: [] });
    expect((env.app.meetings.readSource(id) as { content: string }).content).toContain("shall we start?");
  });

  it("never overwrites: a second recording of the same 1:1 that day keeps its time", async () => {
    const env = makeEnv({ routing: "routes: []\n" });
    writeAt(join(env.transcripts, "1-1s", "Dana-2026-10-04.txt"), "earlier, named by hand\n", "2026-10-04T10:00:00+02:00");
    const id = await record(env);
    await env.app.meetings.match({ source_id: id, calendar_status: "ok", events: [dana, eli], hints: { title_guesses: [], people: [] } });
    const pub = await env.app.meetings.publish(id, { ...EXTRACTION, actions: [] });
    expect(pub.transcript?.file).toBe("Dana-2026-10-04_15-13-58.txt");
    expect(readFileSync(join(env.transcripts, "1-1s", "Dana-2026-10-04.txt"), "utf8")).toBe("earlier, named by hand\n");
  });

  it("a rename that fails is finished on a later scan, and the note follows", async () => {
    const env = makeEnv({ routing: "routes: []\n" });
    const id = await record(env);
    await env.app.meetings.match({ source_id: id, calendar_status: "ok", events: [dana, eli], hints: { title_guesses: [], people: [] } });
    chmodSync(env.transcripts, 0o555);
    try {
      const pub = await env.app.meetings.publish(id, { ...EXTRACTION, actions: [] });
      expect(pub.status).toBe("processed");
      expect(pub.transcript).toBeUndefined();
    } finally {
      chmodSync(env.transcripts, 0o755);
    }
    expect(existsSync(join(env.transcripts, "2026-10-04_15-13-58.wav"))).toBe(true);
    expect(readFileSync(join(env.vault, NOTE), "utf8")).toContain("- local-transcript: 2026-10-04_15-13-58.txt");

    const scan = (await env.app.meetings.scan()) as { transcripts_organized: number };
    expect(scan.transcripts_organized).toBe(1);
    expect(readdirSync(env.transcripts).sort()).toEqual(["1-1s"]);
    expect(readFileSync(join(env.vault, NOTE), "utf8")).toContain("- local-transcript: Dana-2026-10-04.txt");
    expect(((await env.app.meetings.scan()) as { transcripts_organized?: number }).transcripts_organized).toBeUndefined();
  });

});

describe("meeting note tags", () => {
  it("tags notes written before tagging and keeps them AidenHQ's to update", async () => {
    const env = makeEnv({ routing: "routes: []\n" });
    env.cfg.vault.meeting_tags.length = 0;
    const id = await record(env);
    await env.app.meetings.match({ source_id: id, calendar_status: "ok", events: [dana, eli], hints: { title_guesses: [], people: [] } });
    await env.app.meetings.publish(id, { ...EXTRACTION, actions: [] });
    expect(readFileSync(join(env.vault, NOTE), "utf8")).not.toContain("tags:");

    env.cfg.vault.meeting_tags.push("type/meeting");
    await env.app.meetings.scan();
    expect(readFileSync(join(env.vault, NOTE), "utf8")).toContain('type: "meeting"\ntags:\n  - "type/meeting"\n');
    // Still unedited by the user, so a later publish may update it.
    const pub = await env.app.meetings.publish(id, { ...EXTRACTION, summary: "Updated summary.", actions: [] });
    expect(pub.canonical_note.state).toBe("updated");
  });
});

