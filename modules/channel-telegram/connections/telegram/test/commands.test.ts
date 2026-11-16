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
