// End to end against a fake Primer event stream and a fake kernel: a comment wakes its document's task once (a replay after a
// restart doesn't); a burst is one wake until the agent's next reply or version; the connector's own reply never wakes; a
// version covers the comments pending when it started; people's live edits wake like a comment; notices say whether the owner
// wrote; a closed task gets one Revisions task, reused.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
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

});
