// End to end against a fake Primer event stream and a fake kernel: a comment wakes its document's task once (a replay after a
// restart doesn't); a burst is one wake until the agent's next reply or version; the connector's own reply never wakes; a
// version covers the comments pending when it started; people's live edits wake like a comment; notices say whether the owner
// wrote; a closed task gets one Revisions task, reused.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { COALESCE_MS, createSubscriber, type Kernel } from "../src/subscriber.js";

const T1 = "11111111-1111-4111-8111-111111111111";

function harness(closed = new Set<string>(), gone = new Set<string>(), me: Record<string, unknown> | null = { id: "u_agents", kind: "agent", viaUserId: "u_owner" }) {
  const clock = { t: 1_000_000 };
  const wakes: { task: string; text: string }[] = [], filed: any[] = [];
  const owners: Record<string, { task: string; agent: string }> = { d1: { task: T1, agent: "agent-1" } };
  const kernel: Kernel = {
    wake: async (task, text) => {
      if (gone.has(task)) throw Object.assign(new Error("no task"), { status: 404 });
      return closed.has(task) ? { posted: false, closed: true } : (wakes.push({ task, text }), { posted: true });
    },
    file: async (b) => (filed.push(b), { id: `rev-${filed.length}` }),
  };
  // Primer's stream: each connection gets the events after its Last-Event-ID, then stays open until the test closes it.
  const events: string[] = [];
  const streams: { ctl: ReadableStreamDefaultController<Uint8Array>; from: number }[] = [];
  const seen: (string | null)[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    if (String(url).endsWith("/api/documents/d1")) return new Response(JSON.stringify({ title: "Q3 plan" }));
    if (String(url).endsWith("/api/me")) return me ? new Response(JSON.stringify(me)) : new Response("{}", { status: 503 });
    const h = new Headers(init.headers);
    seen.push(h.get("last-event-id"));
    const from = Number(h.get("last-event-id") ?? 0);
    const body = new ReadableStream<Uint8Array>({ start: (ctl) => { streams.push({ ctl, from }); events.slice(from).forEach((e) => ctl.enqueue(new TextEncoder().encode(e))); } });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as typeof globalThis.fetch;
  const emit = (data: Record<string, unknown>) => {
    // Primer's frames: unnamed, id = the row id, data = the event row (namespace primer, dotted type, snake_case payload).
    const e = `id: ${events.length + 1}\ndata: ${JSON.stringify({ id: events.length + 1, namespace: "primer", type: "comment.created", payload: data })}\n\n`;
    events.push(e);
    streams.at(-1)?.ctl.enqueue(new TextEncoder().encode(e));
  };
  const stateFile = join(mkdtempSync(join(tmpdir(), "primer-sub-")), "comments.json");
  const make = () => createSubscriber({ primer: "http://primer-server:3000", headers: async () => ({ authorization: "Bearer primer_pat_test" }), kernel, owner: (d) => owners[d], recordOwner: (d, o) => void (owners[d] = o), stateFile, log: () => {}, fetch, now: () => clock.t });
  const later = () => void (clock.t += COALESCE_MS + 1);
  return { wakes, filed, emit, streams, seen, make, owners, later };
}
const settle = () => new Promise((r) => setTimeout(r, 20));
const c = (comment_id: string, thread_id = "th1", document_id = "d1", author_id = "u_someone") => ({ document_id, version_id: "v1", thread_id, comment_id, author_id });
const edit = (version_id: string, author_id: string, automatic = true) => ({ type: "primer.version.published", data: { document_id: "d1", version_id, number: 3, author_id, ...(automatic ? { automatic } : {}) } });
const woken = (h: { wakes: { text: string }[] }) => h.wakes.map((w) => w.text.match(/comment (\S+);/)?.[1] ?? w.text.slice(0, 40));

describe("the comment wake loop", () => {
  it("wakes the publishing task once per comment, with ids only; a replay after a restart wakes nobody", async () => {
    const h = harness();
    const s = h.make();
    void s.run();
    await settle();
    h.emit({ ...c("c1"), body: "Please cut section 2" });
    h.emit(c("x1", "th9", "unmapped-doc")); // a document no agent published: nothing
    await settle();
    expect(h.wakes).toHaveLength(1);
    expect(h.wakes[0]!.task).toBe(T1);
    expect(h.wakes[0]!.text).toMatch(/document d1 \(thread th1, comment c1;/);
    expect(h.wakes[0]!.text).not.toMatch(/section 2/);
    expect(h.wakes[0]!.text).toMatch(/^New comment by someone else on/);
    // Later, while the agent's run is live: a second notice on the same task (dispatch delivers it into that run).
    h.later();
    h.emit(c("c2", "th2"));
    await settle();
    expect(h.wakes.map((w) => w.task)).toEqual([T1, T1]);
    expect(h.wakes[1]!.text).toMatch(/comment c2; 2 comments not yet addressed/);
    s.stop();
    // A restart resumes after the last handled event; even a full replay is no second wake.
    const again = h.make();
    void again.run();
    await settle();
    expect(h.seen.at(-1)).toBe("3");
    await again.handle({ id: "1", type: "primer.comment.created", data: c("c1") });
    expect(h.wakes).toHaveLength(2);
    again.stop();
  });

  it("never wakes on the connector's own reply, even when its event beats the receipt; a version covers what was pending when it started", async () => {
    const h = harness();
    const s = h.make();
    await s.handle({ id: "1", type: "primer.comment.created", data: c("c1") });
    let answer!: (v: { text: string }) => void;
    const replying = s.guard("primer_reply_to_thread", { thread_id: "th1", body: "Addressed in v2" }, () => new Promise<{ text: string }>((r) => (answer = r)));
    const held = s.handle({ id: "2", type: "primer.comment.created", data: c("c-own") }); // the reply's own event, first
    await settle();
    answer({ text: '{"thread_id":"th1","comment_id":"c-own"}' });
    await replying;
    await held;
    expect(woken(h)).toEqual(["c1"]);
    // A read through the same path (the reply executor's primer_get_comments) names people's comments: never taken as ours.
    await s.guard("primer_get_comments", { documentId: "d1" }, async () => ({ text: '{"comments":[{"thread_id":"th5","comment_id":"c5"}]}' }));
    expect(s.state().docs.d1!.pending).toEqual(["c1"]);
    // The reply above was on d1's thread th1: it addressed c1 and ended the burst, so the next comment wakes again.
    await s.guard("primer_reply_to_thread", { thread_id: "th1", body: "Done in v2" }, async () => ({ text: '{"thread_id":"th1","comment_id":"c-own2"}' }), "d1");
    expect(s.state().docs.d1!.pending).toEqual([]);
    await s.handle({ id: "2b", type: "primer.comment.created", data: c("c5", "th5") });
    expect(woken(h)).toEqual(["c1", "c5"]);
    // A version: c5 was pending when it started; c3 arrives mid-publish and waits for the next batch (its event is held until
    // the write returns, which ended the burst, so it wakes).
    let done!: (v: { text: string }) => void;
    const publishing = s.guard("primer_add_version", { documentId: "d1", content: "v2", baseVersionNumber: 1 }, () => new Promise<{ text: string }>((r) => (done = r)));
    const mid = s.handle({ id: "3", type: "primer.comment.created", data: c("c3", "th3") });
    done({ text: '{"versionId":"v2","versionNumber":2}' });
    await publishing;
    await mid;
    expect(s.state().docs.d1!.batches).toEqual([{ version: "v2", comments: ["c5"] }]);
    expect(s.state().docs.d1!.pending).toEqual(["c3"]);
    expect(woken(h)).toEqual(["c1", "c5", "c3"]);
    // A version Primer didn't make (every change became a suggestion) addresses nothing.
    await s.guard("primer_add_version", { documentId: "d1", content: "v3" }, async () => ({ text: '{"url":"https://p/d/d1","reconciliation":{}}' }));
    expect(s.state().docs.d1!.pending).toEqual(["c3"]);
  });

  it("coalesces a burst of comments into one wake, but never the owner's; people's live edits wake, the connector's own never", async () => {
    const h = harness();
    const s = h.make();
    await s.handle({ id: "1", type: "primer.comment.created", data: c("c1") });
    await s.handle({ id: "2", type: "primer.comment.created", data: c("c2", "th2") });
    await s.handle({ id: "3", type: "primer.comment.created", data: c("c3", "th3", "d1", "u_owner") });
    expect(woken(h)).toEqual(["c1", "c3"]);
    expect(h.wakes[1]!.text).toMatch(/^New comment by the owner on Primer document d1 \(thread th3, comment c3; 3 comments/);
    // The agent answers c1: the burst ends, and c2, which arrived in it unwoken and is still unanswered, gets one wake.
    await s.guard("primer_reply_to_thread", { thread_id: "th1", body: "Done" }, async () => ({ text: "{}" }), "d1");
    expect(s.state().docs.d1!.pending).toEqual(["c2", "c3"]);
    expect(h.wakes).toHaveLength(3);
    expect(h.wakes[2]!.text).toMatch(/^More happened on Primer document d1 since your last wake \(2 comments not yet addressed/);
    // Checkpoints: the connector's own live edit and a non-automatic version (its own publish) wake nobody; a person's does.
    h.later();
    await s.handle({ id: "4", ...edit("v4", "u_agents") });
    await s.handle({ id: "5", ...edit("v5", "u_someone", false) });
    expect(h.wakes).toHaveLength(3);
    await s.handle({ id: "6", ...edit("v6", "u_owner") });
    expect(h.wakes.at(-1)!.text).toBe("Primer document d1 was edited directly by the owner (checkpoint version v6). Read it and handle it as the primer-docs skill says.");
    await s.handle({ id: "6", ...edit("v6", "u_owner") }); // a replay
    expect(h.wakes).toHaveLength(4);
  });

  it("marks every author as someone else while Primer doesn't say who the connector is", async () => {
    const h = harness(new Set(), new Set(), null);
    const s = h.make();
    await s.handle({ id: "1", type: "primer.comment.created", data: c("c1", "th1", "d1", "u_owner") });
    expect(h.wakes[0]!.text).toMatch(/^New comment by someone else/);
  });

  it("files one Revisions task for a closed publishing task and reuses it", async () => {
    const h = harness(new Set([T1]));
    const s = h.make();
    await s.handle({ id: "1", type: "primer.comment.created", data: c("c1") });
    h.later();
    await s.handle({ id: "2", type: "primer.comment.created", data: c("c2", "th2") });
    expect(h.filed).toHaveLength(1);
    expect(h.filed[0]).toMatchObject({ title: "Revisions: Q3 plan", agent: "agent-1", source: "primer-revisions:d1:0", parent: T1 });
    expect(h.filed[0].description).toMatch(/document d1/);
    // The new task starts its agent by itself; the next comment is a notice on it.
    expect(h.wakes).toEqual([{ task: "rev-1", text: expect.stringMatching(/comment c2;/) }]);
    expect(h.owners.d1).toEqual({ task: "rev-1", agent: "agent-1" }); // its versions and replies there are the agent's own
  });

  it("skips a comment whose task is gone for good, without replaying it forever", async () => {
    const h = harness(new Set(), new Set([T1]));
    const s = h.make();
    await s.handle({ id: "1", type: "primer.comment.created", data: c("c1") });
    expect([h.wakes.length, s.state().processed, s.state().cursor]).toEqual([0, ["c1"], "1"]);
  });
});
