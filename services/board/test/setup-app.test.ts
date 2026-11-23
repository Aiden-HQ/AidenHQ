// A flow's `app` (setup-flows.ts): the module makes or updates the vendor app from the owner's pasted token. The board sends it
// on with the pair token, keeps nothing, and saves only the public values the flow declares, never one the organisation supplies.
import { expect, it } from "vitest";
import type { AccountSession, KernelAuth } from "../src/kernel-auth.js";
import { setupFlowRoutes, type SetupFlowPoint } from "../src/setup-flows.js";
import { Store } from "../src/store.js";

// Built at run time, so no secret scanner takes a test value for a real token.
const TOKEN = ["xoxe", `xoxp-test-${"a".repeat(24)}`].join(".");
const flow: SetupFlowPoint & { token: string } = {
  module: "chat", order: 1, title: "Chat", why: "w", effort: "e", steps: "s", secrets: ["chat_client_id"], signin: "chat", token: "pair-secret",
  fields: [{ secret: "chat_client_id", label: "Client ID", pattern: "^[0-9]+\\.[0-9]+$" }],
  app: { url: "http://chat-live:8089/setup/app", label: "App Configuration Token", pattern: "^xoxe\\.xoxp-[A-Za-z0-9-]{20,400}$", help: "h" },
  advanced: { title: "Bot", why: "w", effort: "e", steps: "s", capabilities: ["c"], secrets: ["chat_bot_token"], fields: [{ secret: "chat_bot_token", label: "Bot", pattern: "^xoxb-.+$" }], pair_url: "http://chat-live:8089/pair" },
};
const who = (owner: boolean) => ({ account: { id: "u", email: "a@example.com", name: "A", role: "admin", owner }, session: { id: "s", expiresAt: "" }, ready: true, token: "t" }) as AccountSession;

it("makes the app with the pasted token and saves only the flow's own public values", async () => {
  const sent: { url: string; auth: string; body?: unknown }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    sent.push({ url, auth: (init.headers as Record<string, string>).authorization!, ...(init.body ? { body: JSON.parse(String(init.body)) } : {}) });
    if (init.method === "GET") return new Response(JSON.stringify({ app_id: "A0123ABCD", part: "basic", current: true, url: "https://api.slack.com/apps/A0123ABCD" }));
    // A module that answers more than the flow declares: the bot token is not a value it may hand the board.
    return new Response(JSON.stringify({ app_id: "A0123ABCD", secrets: { chat_client_id: "111.222", chat_bot_token: "xoxb-nope", other: "x" } }));
  }) as typeof fetch;
  const saves: unknown[] = [];
  const accounts = { call: async (op: string, _w: unknown, body: unknown) => (op === "save_secret" ? (saves.push(body), { ok: true }) : { secrets: {} }) } as unknown as KernelAuth;
  let orgSecrets: string[] = [];
  const { routes } = setupFlowRoutes({ flows: [flow], accounts, store: new Store(":memory:"), signedIn: async () => false, scopeChoice: async () => false, connected: async () => undefined, boardUrl: () => "https://board.example.com", redirectUrl: () => undefined, settings: () => undefined, file: async () => ({ identifier: "X-1" }), orgSecrets: () => orgSecrets, fetchImpl });
  const post = routes.find((r) => r.method === "POST" && r.path.test("/api/setup-flows/chat/app"))!;
  const call = (body: unknown, owner = true) => post.handle("/api/setup-flows/chat/app".match(post.path)!, body, who(owner), "localhost:3121");

  const r = await call({ token: ` ${TOKEN} `, part: "basic" });
  expect(r).toEqual({ status: { app_id: "A0123ABCD", part: "basic", current: true, url: "https://api.slack.com/apps/A0123ABCD" }, saved: ["chat_client_id"] });
  expect(sent[0]).toEqual({ url: "http://chat-live:8089/setup/app", auth: "Bearer pair-secret", body: { token: TOKEN, part: "basic" } });
  expect(saves).toEqual([{ module: "chat", secret: "chat_client_id", value: "111.222" }]);

  // Beside an organisation's sign-in, its client id is the organisation's: the app made for the bot never replaces it.
  orgSecrets = ["chat_client_id"];
  expect(await call({ token: TOKEN, part: "advanced" })).toMatchObject({ saved: [] });
  expect(saves).toHaveLength(1);

  // A token that isn't one never leaves the board; only the owner makes the app.
  await expect(call({ token: "xoxb-nope", part: "basic" })).rejects.toThrow(/doesn't look like/);
  await expect(call({ token: TOKEN, part: "basic" }, false)).rejects.toThrow(/only the owner/);
  expect(sent.filter((s) => s.body)).toHaveLength(2);
});
