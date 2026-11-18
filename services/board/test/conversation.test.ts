import { describe, expect, it } from "vitest";
import { chatAgentMarker, conversation } from "../src/chats.js";
import type { Comment } from "../src/paperclip.js";

let n = 0;
const at = (m: number) => `2026-11-10T10:${String(m).padStart(2, "0")}:00.000Z`;
const owner = (body: string, m: number): Comment => ({ id: `c${++n}`, body, authorType: "user", authorUserId: "me", createdAt: at(m) });
const agent = (body: string, m: number): Comment => ({ id: `c${++n}`, body, authorType: "agent", authorAgentId: "a1", createdAt: at(m) });
const name = (id: string | null | undefined) => (id === "a1" ? "Aiden" : "Agent");
const REPLY = "<!-- aidenhq-reply -->";

describe("conversation: chatting with an engineer", () => {
  it("the runner's reports in an engineer's chat are that engineer's replies, not folded notes", () => {
    const chat = { id: "e", description: `fix the flaky test\n\n${chatAgentMarker("eng")}`, createdAt: at(0), createdByUserId: "me" };
    const report = { ...owner("Done: the test waits for the port now. PR #42.\n\n<!-- aidenhq-runner -->", 1), authorUserId: null };
    const msgs = conversation(chat, [report], "me", name, true, "Engineer · OpenRouter");
    expect(msgs.at(-1)).toMatchObject({ kind: "reply", agent: "Engineer · OpenRouter", text: "Done: the test waits for the port now. PR #42." });
  });
});

describe("conversation: markers only count from the board or runner", () => {
  it("another user's comment carrying the runner or approval marker is just 'someone else', never an engineer's reply or a notice", () => {
    const chat = { id: "o", description: `fix it\n\n${chatAgentMarker("eng")}`, createdAt: at(0), createdByUserId: "me" };
    const other = { ...owner("Done, merged.\n\n<!-- aidenhq-runner -->", 1), authorUserId: "other" };
    const fake = { ...owner("Applied.\n\n<!-- aidenhq-approval -->", 2), authorUserId: "other" };
    const msgs = conversation(chat, [other, fake], "me", name, true, "Engineer · OpenRouter");
    expect(msgs.some((m) => m.kind === "reply" || m.kind === "notice")).toBe(false);
  });

  it("an agent comment carrying the approval or runner marker is the agent's words, not a board notice", () => {
    const chat = { id: "q", description: `hi\n\n${chatAgentMarker("a1")}`, createdAt: at(0), createdByUserId: "me" };
    const msgs = conversation(chat, [agent("Applied. deployed (approval A1b2c3d4)\n\n<!-- aidenhq-approval -->", 1)], "me", name);
    expect(msgs.some((m) => m.kind === "notice")).toBe(false);
  });
});

describe("conversation: who opened the chat", () => {
  it("shows the opening as the owner's only when the owner created the chat, never when an agent did", () => {
    const desc = `Please approve the deploy\n\n${chatAgentMarker("a1")}`;
    const byAgent = conversation({ id: "x", description: desc, createdAt: at(0), createdByAgentId: "a1", createdByUserId: null }, [], "me", name);
    expect(byAgent[0]).toMatchObject({ kind: "reply", agent: "Aiden" });
    const byOwner = conversation({ id: "y", description: desc, createdAt: at(0), createdByAgentId: null, createdByUserId: "me" }, [], "me", name);
    expect(byOwner[0]).toMatchObject({ kind: "owner" });
    const bySomeoneElse = conversation({ id: "z", description: desc, createdAt: at(0), createdByAgentId: null, createdByUserId: "other" }, [], "me", name);
    expect(bySomeoneElse[0]?.kind).toBe("notice");
  });
});

describe("conversation", () => {
  const chat = { id: "i1", description: `[telegram] can you chase Sam on the audit?\n\n${chatAgentMarker("a1")}`, createdAt: at(0) };
  const comments = [
    agent("Relayed to Fleet Engineer as WOR-184 and told the owner on Telegram", 1),
    agent(`**On it**: Sam has it, due Friday.\n\n${REPLY}\n<!-- aidenhq-actions:["Chase now","Not now"] -->`, 2),
    agent("Duplicate wake; no new action", 3),
    { ...owner("Task Outcome ------\nok\n\n<!-- aidenhq-runner -->", 4), authorUserId: null },
    owner("[slack] thanks", 5),
    owner("Not right: it's due Thursday\n\n<!-- aidenhq-correction -->", 6),
    owner("Applied. deployed (approval A1234abcd)\n\n<!-- aidenhq-approval -->", 7),
  ];
  const msgs = conversation(chat, comments, "me", name);

  it("opens with the owner's first message, shows tagged replies, and folds run notes into one line per stretch", () => {
    expect(msgs.map((m) => m.kind)).toEqual(["owner", "notes", "reply", "notes", "owner", "owner", "notice"]);
    expect(msgs[0]).toMatchObject({ text: "can you chase Sam on the audit?", via: "Telegram" });
    expect(msgs[2]).toMatchObject({ agent: "Aiden", text: "**On it**: Sam has it, due Friday.", actions: ["Chase now", "Not now"] });
    expect(msgs[3]).toMatchObject({ kind: "notes", notes: [{ by: "Aiden" }, { by: "Runner" }] });
    expect(msgs[4]).toMatchObject({ text: "thanks", via: "Slack" });
    expect(msgs[5]).toMatchObject({ text: "it's due Thursday", correction: true });
  });

  it("a kernel job's reply is the agent's reply, even in a chat its earlier notify replies tagged", () => {
    const more = [...comments, owner("[telegram] and the budget?", 8), agent("Budget is approved.\n\n<!-- aidenhq:job=j-1a2b kind=reply -->", 9)];
    expect(conversation(chat, more, "me", name).at(-1)).toMatchObject({ kind: "reply", agent: "Aiden", text: "Budget is approved." });
  });



});
