import { describe, expect, it } from "vitest";
import { voiceFileId } from "../src/chat.js";
import { quickCommand } from "../src/commands.js";

describe("voice notes", () => {
  it("finds a voice note from the owner chat only", () => {
    const voice = { message: { chat: { id: 42 }, voice: { file_id: "F1", duration: 4 } } };
    expect(voiceFileId(voice, "42")).toBe("F1");
    expect(voiceFileId(voice, "7")).toBeNull();
    expect(voiceFileId({ message: { chat: { id: 42 }, text: "hi" } }, "42")).toBeNull();
    // An attached audio file may be someone else's voice: only notes recorded in the app count.
    expect(voiceFileId({ message: { chat: { id: 42 }, audio: { file_id: "A1" } } }, "42")).toBeNull();
  });
});

describe("quick commands", () => {
  const issues = [
    { identifier: "WOR-9", title: "Move brief to 08:45", status: "in_review" },
    { identifier: "WOR-12", title: "Reply to <Sam>", status: "in_review" },
  ];
  const api = async (_m: string, path: string): Promise<any> => {
    if (path.includes("/agents")) return [{ name: "Aiden", status: "running" }, { name: "Grace", status: "paused" }, { name: "Ada", status: "error" }];
    if (path.includes("status=in_review")) return issues;
    if (path.includes("/issues")) return [...issues, { identifier: "WOR-1", title: "x", status: "todo" }];
    return [];
  };

  it("/waiting lists what needs the owner, with an Apply button per task, without waking Aiden", async () => {
    const r = await quickCommand("/waiting", api, "co");
    expect(r?.text).toContain("WOR-9 Move brief to 08:45");
    expect(r?.actions).toEqual(["Apply WOR-9", "Apply WOR-12"]);
  });
  it("/status counts agents and open tasks and names agents in error", async () => {
    const r = await quickCommand("/status", api, "co");
    expect(r?.text).toMatch(/1 running/);
    expect(r?.text).toMatch(/Ada/);
    expect(r?.text).toMatch(/3 open tasks/);
  });
});

describe("voice notes are the optional voice module", () => {
  it("is on only when the voice module's Whisper resolves on this network", async () => {
    const { voiceOn } = await import("../src/voice.js");
    const seen: string[] = [];
    const up = async (h: string) => { seen.push(h); return { address: "10.0.0.5", family: 4 }; };
    const down = async () => { throw Object.assign(new Error("getaddrinfo ENOTFOUND whisper"), { code: "ENOTFOUND" }); };
    expect(await voiceOn("http://whisper:9000", up as never)).toBe(true);
    expect(seen).toEqual(["whisper"]);
    expect(await voiceOn("http://whisper:9000", down as never)).toBe(false);
    expect(await voiceOn("", up as never)).toBe(false);
  });
  it("tells the owner how to turn voice notes on", async () => {
    const { VOICE_OFF } = await import("../src/chat.js");
    expect(VOICE_OFF).toMatch(/Voice notes are off/);
    expect(VOICE_OFF).toMatch(/Modules page/);
  });
});
