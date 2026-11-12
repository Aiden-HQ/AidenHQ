// Every admin is an owner (owner decision 2026-11-12): any signed-in admin writes with the board key, in the owner's chats
// too, and their typed replies and taps decide approvals. The board records which account wrote what and shows "by <name>"
// on what an admin other than the owner wrote or decided. Real Paperclip client over a fake fetch, real board accounts.
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAccounts } from "../src/accounts.js";
import { createApp } from "../src/app.js";
import { Paperclip } from "../src/paperclip.js";
import { Store } from "../src/store.js";
import { totp } from "./totp.js";

const CO = "00000000-0000-4000-8000-000000000001";
const KEY = "owner-board-key";
const chatLabel = { id: "33333333-3333-3333-3333-333333333333", name: "chat", color: "#0ea5e9" };
const base = { status: "todo", priority: "medium", assigneeAdapterOverrides: null, createdAt: "2026-11-12T08:00:00.000Z", updatedAt: "2026-11-12T08:00:00.000Z", description: "Ship the pricing page." };
const issue = (n: number, extra: Record<string, unknown>) => ({ ...base, id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`, identifier: `WOR-${n}`, title: `Task ${n}`, ...extra });
const issues = [
  issue(1, { assigneeUserId: "me", assigneeAgentId: null, createdByUserId: "me", createdByAgentId: null }), // the owner's task
  issue(3, { assigneeUserId: null, assigneeAgentId: "aiden", createdByUserId: "me", createdByAgentId: null, labels: [chatLabel] }), // the owner's chat
];
const agents = [{ id: "aiden", name: "Aiden", status: "idle", adapterType: "codex_local", metadata: { setupKey: "aidenhq:chief-of-staff" } }];

/** Every write Paperclip got, with the credential it came with; comments are kept per task. */
const writes: { key: string; method: string; path: string; body: any }[] = [];
const comments = new Map<string, any[]>();
let made = 0;
const fakeFetch = (async (url: URL, init: RequestInit = {}) => {
  const method = init.method ?? "GET";
  const path = url.pathname;
  const key = String((init.headers as Record<string, string>).authorization).replace(/^Bearer /, "");
  const json = (x: unknown) => new Response(JSON.stringify(x), { status: 200 });
  const find = (ref: string) => issues.find((i) => i.id === ref || i.identifier === ref);
  if (key !== KEY) return new Response("{}", { status: 401 });
  const commentsOf = /^\/api\/issues\/([^/]+)\/comments$/.exec(path);
  if (method !== "GET") {
    const body = init.body ? JSON.parse(String(init.body)) : {};
    writes.push({ key, method, path, body });
    if (commentsOf) {
      const c = { id: `comment-${++made}`, body: body.body, authorType: "user", authorUserId: "me", createdAt: new Date().toISOString() };
      comments.set(commentsOf[1]!, [...(comments.get(commentsOf[1]!) ?? []), c]);
      return json(c);
    }
    return json({ ...find(decodeURIComponent(path.split("/")[3]!)), ...body });
  }
  if (path === "/api/cli-auth/me") return json({ userId: "me" });
  if (path === `/api/companies/${CO}`) return json({ issuePrefix: "WOR" });
  if (path === `/api/companies/${CO}/agents`) return json(agents);
  if (path === `/api/companies/${CO}/labels`) return json([chatLabel]);
  if (path === `/api/companies/${CO}/issues`) return json(url.searchParams.get("parentId") ? [] : issues);
  if (commentsOf) return json(comments.get(commentsOf[1]!) ?? []);
  const one = /^\/api\/issues\/([^/]+)$/.exec(path);
  if (one) return find(decodeURIComponent(one[1]!)) ? json(find(decodeURIComponent(one[1]!))) : new Response("{}", { status: 404 });
  return json([]); // attachments, runs, routines
}) as typeof fetch;

describe("every admin writes as the owner, with their name on it", () => {
  const log = pino({ level: "silent" });
  const store = new Store(":memory:");
  const PASSWORD = "correct horse battery staple";
  let app: ReturnType<typeof createApp>;
  let port = 0;
  let accounts: Awaited<ReturnType<typeof createAccounts>>;
  beforeAll(async () => {
    accounts = await createAccounts({ dbPath: ":memory:", hosts: ["localhost:3120"], boardUrl: "http://localhost:3120", log });
    app = createApp({ paperclip: new Paperclip("http://paperclip", CO, KEY, fakeFetch), store, log, staticDir: "/nonexistent", timezone: "UTC", accounts, allowedHosts: ["localhost:3120"], mode: "local" });
    await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
    port = (app.address() as AddressInfo).port;
  });
  afterAll(() => {
    app.close();
    accounts.close();
  });

  /** A browser on the local listener: keeps its session cookie. */
  function browser() {
    let cookie = "";
    return (method: string, path: string, body?: unknown) =>
      new Promise<{ status: number; json: any }>((resolve, reject) => {
        const headers: Record<string, string> = { host: "localhost:3120", ...(cookie ? { cookie } : {}), ...(method !== "GET" ? { "content-type": "application/json", "x-aidenhq-board": "1", origin: "http://localhost:3120" } : {}) };
        const req = request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
          let text = "";
          res.on("data", (c) => (text += c));
          res.on("end", () => {
            const set = (res.headers["set-cookie"] ?? []).map((c) => c.split(";")[0]!).find((c) => c.startsWith("better-auth.session_token="));
            if (set) cookie = set;
            resolve({ status: res.statusCode!, json: text ? JSON.parse(text) : undefined });
          });
        });
        req.on("error", reject);
        req.end(body === undefined ? (method === "GET" ? undefined : "{}") : JSON.stringify(body));
      });
  }
  /** A ready admin: claims the link, signs in, enrols an authenticator. */
  async function admin(url: string, email: string) {
    const b = browser();
    expect((await b("POST", "/api/auth/reset-password", { token: url.split("#/set-password/").pop(), newPassword: PASSWORD })).status).toBe(200);
    expect((await b("POST", "/api/auth/sign-in/email", { email, password: PASSWORD })).status).toBe(200);
    const { totpURI } = (await b("POST", "/api/auth/two-factor/enable", { password: PASSWORD })).json;
    expect((await b("POST", "/api/auth/two-factor/verify-totp", { code: totp(totpURI) })).status).toBe(200);
    return b;
  }

  it("another admin's comment goes in with the board key, in the owner's chat too, labelled with their name", async () => {
    const setup = await accounts.setup("owner@example.com", "Owner");
    const me = await admin(setup.url, "owner@example.com");
    const invite = await me("POST", "/api/accounts", { email: "ann@example.com", name: "Ann", role: "admin" });
    const ann = await admin(invite.json.url, "ann@example.com");
    const annId = invite.json.account.id;

    expect((await me("POST", "/api/issues/WOR-1/comments", { body: "Looks good" })).status).toBe(200);
    expect((await ann("POST", "/api/issues/WOR-1/comments", { body: "Ship it Friday" })).status).toBe(200);
    expect(writes.at(-1)).toMatchObject({ key: KEY, body: { body: "Ship it Friday" } });
    expect(store.authoredBy(`comment-${made}`)).toBe(annId);
    const view = (await me("GET", "/api/issues/WOR-1")).json;
    expect(view.comments.map((c: { body: string; by?: string }) => [c.body, c.by])).toEqual([["Looks good", undefined], ["Ship it Friday", "Ann"]]);

    // The owner's chat is every admin's: Ann posts there and the conversation shows whose words they were.
    expect((await ann("POST", "/api/issues/WOR-3/comments", { body: "Check the pricing page" })).status).toBe(200);
    const chat = (await me("GET", "/api/chats/WOR-3")).json;
    expect(chat.messages.find((m: { text: string }) => m.text === "Check the pricing page")).toMatchObject({ kind: "owner", by: "Ann" });
    // And her edits go through like the owner's.
    expect((await ann("PATCH", "/api/issues/WOR-1", { title: "Pricing page" })).status).toBe(200);
    expect(writes.at(-1)).toMatchObject({ key: KEY, method: "PATCH", body: { title: "Pricing page" } });

    // Her typed reply decides (it isn't posted), and so does her tap; both carry her account and show her name.
    let n = 0;
    const card = () => store.approvals.request({ issueId: issues[0]!.id, identifier: "WOR-1", action: "apply", target: "x", digest: String(++n).padEnd(40, "c"), args: {}, sentence: "s", reads: "", changes: "c", cost: "", details: "", requestedBy: "r" }).id;
    const first = card();
    const typed = await ann("POST", "/api/issues/WOR-1/comments", { body: "approve WOR-1" });
    expect(typed.json.approval).toMatchObject({ id: first, state: "approved", decidedBy: `account:${annId}`, decidedByName: "Ann" });
    const second = card();
    expect((await ann("POST", `/api/approvals/${second}/reject`)).json).toMatchObject({ state: "rejected", decidedBy: `account:${annId}`, decidedByName: "Ann" });
    // The owner's own decisions carry no label.
    const third = card();
    const mine = (await me("POST", `/api/approvals/${third}/reject`)).json;
    expect(mine).toMatchObject({ state: "rejected", decidedBy: `account:${setup.account.id}` });
    expect(mine.decidedByName).toBeUndefined();
    const listed = (await me("GET", "/api/approvals")).json.approvals;
    expect(listed.find((a: { id: string }) => a.id === second).decidedByName).toBe("Ann");
  });
});
