import { request, type ClientRequest } from "node:http";
import type { AddressInfo } from "node:net";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { card, type Request } from "../src/approvals.js";
import { createApp } from "../src/app.js";
import type { Paperclip } from "../src/paperclip.js";
import { Store } from "../src/store.js";

const posted: string[] = [];
const pc = { addComment: async (id: string) => void posted.push(id), issue: async () => ({ parentId: null }) } as unknown as Paperclip;
const log = pino({ level: "silent" });
const store = new Store(":memory:");

function listen(app: ReturnType<typeof createApp>) {
  let port = 0;
  beforeAll(async () => {
    await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
    port = (app.address() as AddressInfo).port;
  });
  afterAll(() => app.close());
  return { port: () => port };
}
function call(port: number, method: string, path: string, body: unknown, headers: Record<string, string>) {
  return new Promise<{ status: number; json: any }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      let text = "";
      res.on("data", (c) => (text += c));
      res.on("end", () => resolve({ status: res.statusCode!, json: text ? JSON.parse(text) : undefined }));
    });
    req.on("error", reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

const board = listen(createApp({ paperclip: pc, store, log, allowedHosts: ["localhost:3120"], staticDir: "/nonexistent", timezone: "UTC", session: () => ({ accountId: "owner", role: "admin" as const }) }));
const tap = (path: string, body: unknown) => call(board.port(), "POST", path, body, { host: "localhost:3120", "content-type": "application/json", "x-aidenhq-board": "1" });

let n = 0;
/** A pending apply card on its own task (Tier 2 unless said). */
function file(sha = "a", task = `WOR-${++n}`, tier: 1 | 2 = 2) {
  const args = { repo: "acme/instance", branch: "fleet/x", sha: sha.repeat(40), files: ["instance.yaml"] };
  const req: Request = { issueId: `issue-${task}`, identifier: task, action: "apply", args, requestedBy: "Fleet Engineer", tier, ...card("apply", args, "") };
  return store.approvals.request(req);
}
const item = (a: { id: string; digest: string }) => ({ id: a.id, digest: a.digest });

describe("batch approvals", () => {
  it("decides all or nothing: a card re-filed since the list was shown refuses the whole batch, naming it", async () => {
    const [a, b, c] = [file(), file(), file()];
    const shown = [a, b, c].map(item);
    const refiled = file("e", c.identifier); // the agent changed its request after the owner saw the list
    const r = await tap("/api/approvals/batch/approve", { items: shown });
    expect(r.status).toBe(409);
    expect(r.json.error).toContain(`${c.identifier} (${c.id}) is expired`);
    expect([a, b].map((x) => store.approvals.get(x.id)!.state)).toEqual(["pending", "pending"]); // nothing decided
    // The fresh list (the re-filed card with its new digest) goes through; each card is its own record, stamped as a tap.
    const ok = await tap("/api/approvals/batch/approve", { items: [item(a), item(b), item(refiled)] });
    expect(ok.status).toBe(200);
    expect(ok.json.approvals.map((x: any) => [x.state, x.decidedBy])).toEqual(Array(3).fill(["approved", "account:owner"]));
  });

  it("refuses a Tier 1 card (the reviewer's), a wrong digest, and more than 10 cards", async () => {
    const t1 = file("b", undefined, 1);
    const t2 = file("c");
    expect((await tap("/api/approvals/batch/reject", { items: [item(t1), item(t2)] })).json.error).toContain("with the AI reviewer");
    expect((await tap("/api/approvals/batch/reject", { items: [{ id: t2.id, digest: "0".repeat(40) }] })).json.error).toContain("changed since it was shown");
    expect((await tap("/api/approvals/batch/reject", { items: Array.from({ length: 11 }, () => file("d")).map(item) })).status).toBe(400);
    expect(store.approvals.get(t2.id)!.state).toBe("pending");
  });
});

describe("live updates", () => {
  it("an open board hears `approvals` when a card is decided", async () => {
    const a = file();
    let text = "";
    let req: ClientRequest | undefined;
    const heard = new Promise<void>((resolve) => {
      req = request({ host: "127.0.0.1", port: board.port(), path: "/api/events", headers: { host: "localhost:3120" } }, (res) => {
        expect(res.headers["content-type"]).toBe("text/event-stream");
        res.on("data", (c) => {
          text += c;
          if (text.includes("event: ping") && !text.includes("event: approvals")) void tap(`/api/approvals/${a.id}/approve`, {});
          if (text.includes("event: approvals")) resolve();
        });
      });
      req.on("error", () => {});
      req.end();
    });
    await heard;
    req!.destroy();
    expect(text).toContain(`event: approvals\ndata: {"issue":"${a.issueId}"}`);
  });
});
