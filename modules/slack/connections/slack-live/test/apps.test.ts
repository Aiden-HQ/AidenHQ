import { expect, it } from "vitest";
import { apps, MANIFESTS } from "../src/apps.js";
import { openStore } from "../src/store.js";

// Built at run time, so no secret scanner takes a test value for a real token.
const TOKEN = ["xoxe", `xoxp-test-${"a".repeat(24)}`].join(".");

it("makes the app from a pasted config token, then updates it to the bot manifest; the token is never kept", async () => {
  const calls: { method: string; auth: string; body: Record<string, string> }[] = [];
  const slack = (async (url: string, init: RequestInit) => {
    const method = url.split("/api/")[1]!;
    calls.push({ method, auth: (init.headers as Record<string, string>).authorization!, body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify(method === "apps.manifest.create" ? { ok: true, app_id: "A0123ABCD", credentials: { client_id: "111.222", client_secret: "shh" } } : { ok: true }));
  }) as typeof fetch;
  const store = openStore(":memory:");
  const a = apps(store, slack);
  expect(a.status()).toEqual({ app_id: null, part: null, current: false, url: null });

  // Sign-in only: a new app from the basic manifest; its public client id comes back, its secret never does.
  const made = await a.apply({ token: TOKEN, part: "basic" });
  expect(made).toEqual({ app_id: "A0123ABCD", part: "basic", current: true, url: "https://api.slack.com/apps/A0123ABCD", secrets: { slack_client_id: "111.222" } });
  expect(calls[0]).toEqual({ method: "apps.manifest.create", auth: `Bearer ${TOKEN}`, body: { manifest: JSON.stringify(MANIFESTS.basic) } });

  // Adding the bot later: the same app, updated to the advanced manifest.
  const updated = await a.apply({ token: TOKEN, part: "advanced", app_id: "A0123ABCD" });
  expect(updated).toEqual({ app_id: "A0123ABCD", part: "advanced", current: true, url: "https://api.slack.com/apps/A0123ABCD" });
  expect(calls[1]).toMatchObject({ method: "apps.manifest.update", body: { app_id: "A0123ABCD", manifest: JSON.stringify(MANIFESTS.advanced) } });
  expect(JSON.stringify(store.listKv(""))).not.toMatch(/xoxe|shh/);

  // Slack's refusal comes back in words; a wrong-looking token never reaches Slack.
  const refuse = (async () => new Response(JSON.stringify({ ok: false, error: "token_expired" }))) as unknown as typeof fetch;
  await expect(apps(store, refuse).apply({ token: TOKEN, part: "advanced" })).rejects.toThrow(/expired/);
  await expect(a.apply({ token: "xoxb-nope", part: "basic" })).rejects.toThrow(/Configuration Token/);
  expect(calls).toHaveLength(2);
});
