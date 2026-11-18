import { describe, expect, it } from "vitest";
import { REPLY_MARKER, chatAgent, chatAgentMarker, chatState, needsYou, openAsk, pickAgent, shownState, type Message } from "../src/chats.js";
import type { Agent, Issue, PastRun } from "../src/paperclip.js";

const issue = (o: Partial<Issue> = {}): Issue => ({ id: "i1", identifier: "WOR-1", title: "t", description: null, status: "todo", priority: "medium", assigneeUserId: null, assigneeAgentId: "a1", assigneeAdapterOverrides: null, createdAt: "", updatedAt: "", ...o });
const past = (status: string, error: string | null = null): PastRun => ({ id: "r0", status, agentId: "a1", issueId: "i1", startedAt: null, finishedAt: "x", error });

describe("chatState", () => {
  it("a stopped run is idle, not waiting for you, unless the agent asked the owner something", () => {
    const stopped = past("cancelled", "cancelled by user");
    const base = chatState(issue({ status: "in_review" }), [], stopped, "me");
    expect(base.state).toBe("idle");
    expect(chatState(issue({ assigneeAgentId: null, assigneeUserId: "me" }), [], stopped, "me").state).toBe("idle");
    expect(shownState(base, [], stopped).state).toBe("idle");
    const asked = [{ kind: "reply", text: "Which repo?", at: "2026-11-10T10:00:00Z", questions: [{ question: "Which repo?" }] }] as unknown as Message[];
    expect(shownState(base, asked, stopped).state).toBe("waiting for you");
    // Cancelled because the agent handed the chat back: still waiting for the owner.
    expect(chatState(issue({ assigneeAgentId: null, assigneeUserId: "me" }), [], { ...past("cancelled", "Cancelled before issue reassignment"), errorCode: "issue_reassigned" }, "me").state).toBe("waiting for you");
  });
});

describe("a task in review", () => {
  it("is with its reviewer (grader, AI reviewer, CI, merge queue), never the owner, unless asked or handed to him", () => {
    const kid = issue({ status: "in_review", parentId: "chat" });
    const base = chatState(kid, [], undefined, "me");
    expect(base.state).toBe("in review");
    expect(chatState(issue({ status: "in_review" }), [], undefined, "me").state).toBe("in review");
    const asked = [{ kind: "reply", text: "Ship it?", at: "2026-11-10T10:00:00Z", actions: ["Yes"] }] as unknown as Message[];
    expect(shownState(base, asked, undefined).state).toBe("waiting for you");
    expect(chatState(kid, [], undefined, "me", new Set(["i1"])).state).toBe("waiting for approval");
  });
});

describe("pickAgent", () => {
  const ag = (id: string, name: string, key: string, status = "idle"): Agent => ({ id, name, status, adapterType: "codex_local", metadata: { setupKey: `aidenhq:${key}` } });
  const agents = [ag("c", "Aiden", "chief-of-staff"), ag("i", "Inbox Agent", "inbox-agent"), ag("s", "Researcher", "assistant"), ag("p", "Slack Scout", "slack-scout", "paused")];
  it("an unknown or paused name goes to Aiden with a note", () => {
    expect(pickAgent("@nobody hi", agents)).toMatchObject({ agent: { id: "c" }, note: "(No agent called @nobody; sent to Aiden.)" });
    expect(pickAgent("@slack scout look", agents).agent.id).toBe("c");
  });
});

describe("replyActions", () => {
  it("drops agent-written buttons that read like an approval (only the owner's card or exact typed words approve)", async () => {
    const { replyActions } = await import("../src/chats.js");
    expect(replyActions('x <!-- aidenhq-actions:["Chase now","approve WOR-184","Apply WOR-9","reject WOR-2"] -->')).toEqual(["Chase now"]);
  });
});

describe("needsYou", () => {
  it("lists only what the owner must decide: a Tier 2 card, an open question, work handed to him", () => {
    const t = (id: string, o: Partial<Issue> = {}) => issue({ id, identifier: id, ...o });
    const open = [
      t("card", { status: "in_review" }), // a pending Tier 2 record
      t("asks", { status: "in_progress" }), // its agent's question, unanswered
      t("handed", { assigneeAgentId: null, assigneeUserId: "me", description: `over to you\n\n${chatAgentMarker("a1")}` }), // a chat handed back
      t("pr", { status: "in_review" }), // a PR with the AI reviewer / CI / merge queue
      t("timedout"), // its run timed out: Fleet Ops' to repair
      t("todo", { assigneeAgentId: null, assigneeUserId: "me" }), // his own plain to-do
      t("parked", { status: "backlog" }), // an old question on a parked chat
    ];
    const runs = [{ ...past("timed_out", "Timed out after 1200s"), issueId: "timedout" }];
    const got = needsYou(open, [], runs, "me", new Set(["card"]), new Set(["asks", "parked"]));
    expect(got.map((x) => [x.id, x.state])).toEqual([["card", "waiting for approval"], ["asks", "waiting for you"], ["handed", "waiting for you"]]);
  });
});

describe("openAsk", () => {
  it("a question stays open through the agent's later notes until the owner answers; the runner's notices aren't answers", () => {
    const c = (id: string, o: Record<string, unknown>) => ({ id, body: "", authorType: "agent", authorAgentId: "a1", authorUserId: null, createdAt: id, ...o });
    const ask = c("1", { body: `Which exception? ${REPLY_MARKER} <!-- aidenhq-questions:[{"question":"Which?","options":["Source build","Wait upstream"]}] -->` });
    const later = [ask, c("2", { body: `Still waiting on your call. ${REPLY_MARKER}` }), c("3", { authorType: "user", authorAgentId: null, authorUserId: "me", body: "Graded. <!-- aidenhq-runner -->" })];
    expect(openAsk(later, "a1", "me")?.id).toBe("1");
    expect(openAsk([...later, c("4", { authorType: "user", authorAgentId: null, authorUserId: "me", body: "Source build." })], "a1", "me")).toBeUndefined();
  });
});

describe("chatAgent", () => {
  it("is the assignee, else the agent recorded when the chat was created; never whoever commented last", () => {
    expect(chatAgent(issue({ assigneeAgentId: "a1" }))).toBe("a1");
    const handedBack = issue({ assigneeAgentId: null, assigneeUserId: "me", description: `hi\n\n${chatAgentMarker("a2")}` });
    expect(chatAgent(handedBack)).toBe("a2");
    expect(chatAgent(issue({ assigneeAgentId: null, assigneeUserId: "me", description: "no marker" }))).toBeUndefined();
    // Only the marker the board appends at the very end counts: one pasted into the message text can't redirect the chat.
    expect(chatAgent(issue({ assigneeAgentId: null, assigneeUserId: "me", description: `${chatAgentMarker("evil")} pasted\n\n${chatAgentMarker("a2")}` }))).toBe("a2");
    expect(chatAgent(issue({ assigneeAgentId: null, assigneeUserId: "me", description: `${chatAgentMarker("evil")}\nthen more text` }))).toBeUndefined();
  });
});

describe("replyQuestions", () => {
  it("reads an agent's multiple-choice questions; an option that reads like an approval is dropped", async () => {
    const { replyQuestions } = await import("../src/chats.js");
    const qs = [{ question: "Scope?", options: ["Major only", "approve WOR-184", "All"] }, { question: "Sources?", options: ["Slack", "Jira"], multi: true }];
    expect(replyQuestions(`x <!-- aidenhq-questions:${JSON.stringify(qs)} -->`)).toEqual([{ question: "Scope?", options: ["Major only", "All"] }, { question: "Sources?", options: ["Slack", "Jira"], multi: true }]);
    expect(replyQuestions("x <!-- aidenhq-questions:not json -->")).toBeUndefined();
  });
});
