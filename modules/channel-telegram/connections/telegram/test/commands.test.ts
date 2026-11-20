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
  const api = async (_m: string, path: string): Promise<any> => {
    if (path.includes("/agents")) return [{ name: "Aiden", status: "running" }, { name: "Grace", status: "idle", lifecycleHolds: ["manual"] }, { name: "Devops", status: "paused" }, { name: "Ada", status: "error" }];
    if (path.includes("/issues")) return [{ identifier: "WOR-8812", title: "Reply to <Sam>" }, { identifier: "WOR-8859", title: "Move brief to 08:45" }];
    return [];
  };
  const owner = [{ who: "owner" }];
  const state = async () => ({
    tasks: [
      { identifier: "WOR-8812", kind: "waiting", since: "2026-11-20T10:00:00Z", attention: owner },
      { identifier: "WOR-8859", kind: "idle", since: "2026-11-20T08:00:00Z", attention: owner },
      { identifier: "WOR-1", kind: "working", since: "2026-11-20T09:00:00Z", attention: [] },
    ],
    counts: { needs_you: 2, failed: 1, unexplained_idle: 0 },
  });

  it("/waiting lists owner attention, oldest first, with an Apply button per task, without waking Aiden", async () => {
    const r = await quickCommand("/waiting", api, "co", state);
    expect(r?.text).toContain("WOR-8859 Move brief to 08:45");
    expect(r!.text.indexOf("WOR-8859")).toBeLessThan(r!.text.indexOf("WOR-8812"));
    expect(r?.text).not.toContain("WOR-1 ");
    expect(r?.actions).toEqual(["Apply WOR-8859", "Apply WOR-8812"]);
  });
  it("/status counts agents, names agents in error and counts tasks from the kernel", async () => {
    const r = await quickCommand("/status", api, "co", state);
    expect(r?.text).toMatch(/1 running, 0 idle, 1 paused/);
    expect(r?.text).toMatch(/Ada/);
    expect(r?.text).toMatch(/3 open: 1 working, 1 waiting, 1 idle \(failed 1, unexplained 0\), needs you 2/);
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
