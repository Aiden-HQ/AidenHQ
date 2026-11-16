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
const board = listen(createApp({ paperclip: pc, store, log, allowedHosts: ["localhost:3120"], staticDir: "/nonexistent", timezone: "UTC", session: () => ({ accountId: "owner", role: "admin" as const }) }));

let n = 0;
/** A pending apply card on its own task (Tier 2 unless said). */
function file(sha = "a", task = `WOR-${++n}`, tier: 1 | 2 = 2) {
  const args = { repo: "acme/instance", branch: "fleet/x", sha: sha.repeat(40), files: ["instance.yaml"] };
  const req: Request = { issueId: `issue-${task}`, identifier: task, action: "apply", args, requestedBy: "Fleet Engineer", tier, ...card("apply", args, "") };
  return store.approvals.request(req);
}

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
          // The kernel's approval page decides through the internal route, which lands here in the store.
          if (text.includes("event: ping") && !text.includes("event: approvals")) store.approvals.decide(a.id, "approve", "account:owner");
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
