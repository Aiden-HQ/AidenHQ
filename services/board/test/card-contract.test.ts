// The runner's card payload and the board's strict schema, held together: a push or PR card is built by the runner from the
// branches it is about to publish (services/runner/src/cards.mjs) and posted here through the board's own route. A field the
// runner adds and the board's ARGS doesn't know is a 400 that blocks every publish of that kind (a merge card's `ui`, a
// product branch's `base`), so the payload is taken from the runner's builder, never restated field by field here.
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ARGS } from "../src/approvals.js";
import { createApp } from "../src/app.js";
import type { Paperclip } from "../src/paperclip.js";
import { Store } from "../src/store.js";

const TOKEN = "t".repeat(64);
const RUNNER_KEY = "r".repeat(48);
const SHA = (c: string) => c.repeat(40);
const issue = { id: "11111111-1111-1111-1111-111111111111", identifier: "WOR-184", title: "T", description: "", status: "in_review", assigneeUserId: null, assigneeAgentId: "fe", createdAt: "", updatedAt: "" };
const engineer = { id: "fe", name: "Fleet Engineer", status: "idle", adapterType: "codex_local", metadata: { setupKey: "aidenhq:engineer-fleet" } };
const pc = { addComment: async () => {}, me: async () => "me-1", agents: async () => [engineer], labels: async () => [], company: async () => ({ issuePrefix: "WOR" }), issue: async () => issue } as unknown as Paperclip;
const log = pino({ level: "silent" });
const runnerCards = await import(pathToFileURL(join(import.meta.dirname, "../../runner/src/cards.mjs")).href);

function listen(app: ReturnType<typeof createApp>) {
  let port = 0;
  beforeAll(async () => {
    await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
    port = (app.address() as AddressInfo).port;
  });
  afterAll(() => void app.close());
  return (method: string, path: string, body: unknown, headers: Record<string, string>) =>
    new Promise<{ status: number; json: any }>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => resolve({ status: res.statusCode!, json: text ? JSON.parse(text) : undefined }));
      });
      req.on("error", reject);
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
}

describe("card contract", () => {
  const store = new Store(":memory:");
  const internal = listen(createApp({ paperclip: pc, store, log, allowedHosts: ["board:3122"], staticDir: "/nonexistent", timezone: "UTC", mode: "internal", internalToken: TOKEN, reviewerKey: RUNNER_KEY }));
  const post = (path: string, body: unknown) => internal("POST", path, body, { host: "board:3122", "content-type": "application/json", authorization: `Bearer ${TOKEN}`, "x-reviewer-key": RUNNER_KEY });

  // The real card args, from the runner's builder: a product branch carries its bound base, a plain one doesn't.
  const product = runnerCards.branchCardArgs([{ repo: "acme/app", branch: "fix/x", sha: SHA("a"), base: SHA("b") }], { text: { title: "Fix x", body: "Why." }, merge: true });
  const productPush = runnerCards.branchCardArgs([{ repo: "acme/app", branch: "fix/x", sha: SHA("a"), base: SHA("b") }]);
  const plain = runnerCards.branchCardArgs([{ repo: "acme/agents", branch: "fleet/y", sha: SHA("c") }]);

  it("the runner's product-branch push args, base included, are taken whole and handed back on approval", async () => {
    const filed = await post("/internal/approvals", { issue: "WOR-184", action: "push", args: productPush });
    expect(filed.status, filed.json?.error).toBe(200);
    expect(filed.json.args).toEqual(productPush);
    expect(filed.json.args.only[0]).toMatchObject({ repo: "acme/app", branch: "fix/x", base: SHA("b") });
    expect(filed.json.sentence).toBe("Push 1 branch to GitHub.");
  });

  it("the runner's product-repo PR card (text and merge) is taken whole, and its args are what the claim hands back", async () => {
    const filed = await post("/internal/approvals", { issue: "WOR-184", action: "pr", args: product });
    expect(filed.status, filed.json?.error).toBe(200);
    expect(filed.json.args).toEqual(product);
    expect(filed.json.sentence).toBe("Push and open (or update) a PR for 1 branch, then merge each PR once its checks are green.");
  });

  it("a base is a commit like any other, and a card without one (another repo's branch) is still taken", async () => {
    const filed = await post("/internal/approvals", { issue: "WOR-184", action: "push", args: plain });
    expect(filed.status, filed.json?.error).toBe(200);
    expect(filed.json.args).toEqual(plain);
    expect((await post("/internal/approvals", { issue: "WOR-184", action: "push", args: { only: [{ ...plain.only[0], base: "main" }] } })).status).toBe(400);
    // Every field the runner's builder can put on a branch entry is one the board's schema knows: a new one fails here,
    // not on the first publish of a product branch.
    const entry = ARGS.push.shape.only.element.shape;
    for (const key of new Set(productPush.only.flatMap((b: Record<string, unknown>) => Object.keys(b)))) {
      expect(Object.keys(entry)).toContain(key);
    }
    expect(new Set(Object.keys(entry))).toEqual(new Set(runnerCards.BRANCH_CARD_FIELDS));
  });
});
