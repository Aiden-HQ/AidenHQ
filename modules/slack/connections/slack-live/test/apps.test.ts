import { expect, it } from "bun:test";
import { apps, botName, MANIFESTS, named, slugOf } from "../src/apps.js";
import { adoptLegacy } from "../src/installs.js";
import { openStore } from "../src/store.js";

// Built at run time, so no secret scanner takes a test value for a real token.
// The app as the owner left it: their own name, a write scope they added, another redirect.
const OWNERS = { display_information: { name: "My Slack helper" }, oauth_config: { redirect_urls: ["https://example.com/cb"], scopes: { user: ["chat:write", "search:read.public"] } }, settings: { socket_mode_enabled: false } };
const TOKEN = ["xoxe", `xoxp-test-${"a".repeat(24)}`].join(".");

it("makes the app from a pasted config token, named after the instance, then updates it to the bot manifest; the token is never kept", async () => {
  process.env.INSTANCE_NAME = "";
  process.env.OWNER_NAME = "Sam";
  const calls: { method: string; auth: string; body: Record<string, string> }[] = [];
  const slack = (async (url: string, init: RequestInit) => {
    const method = url.split("/api/")[1]!;
    calls.push({ method, auth: (init.headers as Record<string, string>).authorization!, body: JSON.parse(String(init.body)) });
    if (method === "apps.manifest.export") return new Response(JSON.stringify({ ok: true, manifest: OWNERS }));
    return new Response(JSON.stringify(method === "apps.manifest.create" ? { ok: true, app_id: "A0123ABCD", credentials: { client_id: "111.222", client_secret: "shh" } } : { ok: true }));
  }) as typeof fetch;
  const store = openStore(":memory:");
  const a = apps(store, slack);
  expect(a.status()).toEqual({ app_id: null, part: null, current: false, url: null });

  // Sign-in only: a new app from the basic manifest; its public client id comes back, its secret never does.
  const made = await a.apply({ token: TOKEN, part: "basic" });
  expect(made).toEqual({ app_id: "A0123ABCD", part: "basic", current: true, url: "https://api.slack.com/apps/A0123ABCD", secrets: { slack_client_id: "111.222" } });
  // A new app takes the instance's name (INSTANCE_NAME unset here, so the owner's): the @handle Slack fixes at first install
  // is per instance, and the app name says which one it is.
  const created = JSON.parse(calls[0]!.body.manifest!);
  expect(created.display_information.name).toBe("AidenHQ (sam)");
  expect(MANIFESTS.basic).toMatchObject({ display_information: { name: "AidenHQ" } });
  expect(JSON.stringify(MANIFESTS.basic)).not.toBe(calls[0]!.body.manifest);

  // Adding the bot later: the same app, updated to the advanced manifest. The app has no bot yet, so this is the bot's first
  // install and it takes the instance's name too (Slack fixes the @handle then, not at the sign-in app's create).
  const updated = await a.apply({ token: TOKEN, part: "advanced", app_id: "A0123ABCD" });
  expect(updated).toEqual({ app_id: "A0123ABCD", part: "advanced", current: true, url: "https://api.slack.com/apps/A0123ABCD" });
  expect(calls[1]).toMatchObject({ method: "apps.manifest.export", body: { app_id: "A0123ABCD" } });
  expect(calls[2]).toMatchObject({ method: "apps.manifest.update", body: { app_id: "A0123ABCD" } });
  // Ours on top of theirs: their name, scope and redirect stay; the bot's settings are ours.
  const sent = JSON.parse(calls[2]!.body.manifest!);
  expect(sent.display_information).toEqual({ name: "My Slack helper" });
  expect(sent.oauth_config.redirect_urls).toEqual(["https://example.com/cb", "http://localhost:3121/slack/callback"]);
  expect(sent.oauth_config.scopes.user).toContain("chat:write");
  expect(sent.settings.socket_mode_enabled).toBe(true);
  // The update keeps the app's own display_information, and the bot it just gained is named after the instance.
  expect(sent.features.bot_user.display_name).toBe("aidenhq-sam");
  expect(JSON.stringify(store.listKv(""))).not.toMatch(/xoxe|shh/);

  // Slack's refusal comes back in words; a wrong-looking token never reaches Slack.
  const refuse = (async () => new Response(JSON.stringify({ ok: false, error: "token_expired" }))) as unknown as typeof fetch;
  await expect(apps(store, refuse).apply({ token: TOKEN, part: "advanced" })).rejects.toThrow(/expired/);
  await expect(a.apply({ token: "xoxb-nope", part: "basic" })).rejects.toThrow(/Configuration Token/);
  expect(calls).toHaveLength(3);
});

it("names two instances' apps differently, so their @handles don't collide", () => {
  const acme = named(MANIFESTS.advanced, slugOf("Acme Inc."));
  const other = named(MANIFESTS.advanced, slugOf("Globex"));
  const name = (m: unknown) => (m as { features: { bot_user: { display_name: string } } }).features.bot_user.display_name;
  const app = (m: unknown) => (m as { display_information: { name: string } }).display_information.name;
  expect(name(acme)).toBe("aidenhq-acme-inc");
  expect(name(other)).toBe("aidenhq-globex");
  expect(name(acme)).not.toBe(name(other));
  expect(app(acme)).toBe("AidenHQ (acme-inc)");
  expect(app(other)).toBe("AidenHQ (globex)");
  expect(app(acme)).not.toBe(app(other));
  // The rest of the manifest is ours, untouched (the source of truth at slack-app-manifest.yml).
  expect((acme as { settings: unknown }).settings).toEqual((MANIFESTS.advanced as { settings: unknown }).settings);
  expect((acme as { oauth_config: unknown }).oauth_config).toEqual((MANIFESTS.advanced as { oauth_config: unknown }).oauth_config);
});

it("slugs an instance name: lowers it, turns anything outside a-z0-9- into -, and trims the ends", () => {
  expect(slugOf("Acme Inc.")).toBe("acme-inc");
  expect(slugOf("  Acme / HQ  ")).toBe("acme-hq");
  expect(slugOf("Acme_Inc (EU)")).toBe("acme-inc-eu");
  expect(slugOf("aidenhq-alpha")).toBe("aidenhq-alpha");
  expect(slugOf(undefined)).toBe("");
  // Nothing left to name it with (an owner name in another script and no instance name): the manifest's own labels stay.
  const m = named(MANIFESTS.advanced, slugOf("Пример")) as { display_information: { name: string } };
  expect(m.display_information.name).toBe("AidenHQ");
});

it("keeps the bot name within Slack's 21 characters and the app name within 35, and both well formed", () => {
  const long = "a".repeat(40);
  const m = named(MANIFESTS.advanced, long) as { display_information: { name: string }; features: { bot_user: { display_name: string } } };
  // Too long to fit whole: the head plus a 4-character hash of the whole slug, still within 21.
  expect(m.features.bot_user.display_name).toBe(`aidenhq-${"a".repeat(8)}-${botName(long).slice(-4)}`);
  expect(m.features.bot_user.display_name).toHaveLength(21);
  expect(m.display_information.name).toBe(`AidenHQ (${"a".repeat(25)})`);
  expect(m.display_information.name).toHaveLength(35);
  // Allowed in a handle: a-z0-9-_. with no trailing separator, and it never ends on one after the cut.
  expect(m.features.bot_user.display_name).toMatch(/^[a-z0-9-_.]+$/);
  const trimmed = named(MANIFESTS.advanced, `${"a".repeat(12)}-`) as { features: { bot_user: { display_name: string } } };
  expect(trimmed.features.bot_user.display_name).toBe(`aidenhq-${"a".repeat(12)}`);
  expect(trimmed.features.bot_user.display_name).not.toMatch(/[-_.]$/);
});

it("keeps bot names distinct when two instance names share a long head (a plain cut would collide)", () => {
  for (const [a, b] of [["acme-finance-eu", "acme-finance-us"], ["acme-platform-prod", "acme-platform-dev"], ["production-east-1", "production-east-2"]]) {
    const na = botName(slugOf(a)), nb = botName(slugOf(b));
    expect(na).not.toBe(nb);
    expect(na.length).toBeLessThanOrEqual(21);
    expect(nb.length).toBeLessThanOrEqual(21);
    expect(na).toMatch(/^[a-z0-9-_.]+$/);
  }
  // A name that fits whole stays whole, and the same name always gives the same handle (Slack fixes it once).
  expect(botName(slugOf("Acme Inc."))).toBe("aidenhq-acme-inc");
  expect(botName(slugOf("acme-finance-eu"))).toBe(botName(slugOf("acme-finance-eu")));
});

it("names the bot when an app first gains one, and never renames a bot the app already has", async () => {
  process.env.INSTANCE_NAME = "acme";
  // The app as Slack has it after its bot's first install: its own name, and a bot user (its @handle is already fixed).
  const installed = { ...OWNERS, features: { bot_user: { display_name: "aidenhq-other", always_online: false } } };
  const calls: { method: string; body: Record<string, string> }[] = [];
  const slack = (async (url: string, init: RequestInit) => {
    const method = url.split("/api/")[1]!;
    calls.push({ method, body: JSON.parse(String(init.body)) });
    if (method === "apps.manifest.export") return new Response(JSON.stringify({ ok: true, manifest: installed }));
    return new Response(JSON.stringify(method === "apps.manifest.create" ? { ok: true, app_id: "A0123ABCD", credentials: { client_id: "111.222" } } : { ok: true }));
  }) as typeof fetch;
  const a = apps(openStore(":memory:"), slack);
  await a.apply({ token: TOKEN, part: "advanced" });
  expect(JSON.parse(calls[0]!.body.manifest!).display_information.name).toBe("AidenHQ (acme)");
  expect(JSON.parse(calls[0]!.body.manifest!).features.bot_user.display_name).toBe("aidenhq-acme");
  await a.apply({ token: TOKEN, part: "advanced", app_id: "A0123ABCD" });
  // Their display_information stays, and so does their bot (only its always_online and the rest of ours are added): a handle
  // Slack already fixed is left alone.
  const sent = JSON.parse(calls[2]!.body.manifest!);
  expect(sent.display_information.name).toBe("My Slack helper");
  expect(sent.features.bot_user).toEqual({ display_name: "aidenhq-other", always_online: true });
});

it("makes an agent's own app named after the agent, without the owner's user token, events or command, and keeps it apart from the instance's app", async () => {
  const calls: Record<string, string>[] = [];
  const slack = (async (url: string, init: RequestInit) => {
    const method = url.split("/api/")[1]!;
    calls.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify(method === "apps.manifest.create" ? { ok: true, app_id: "A0ARIA00", credentials: { client_id: "1.2" } } : { ok: true }));
  }) as typeof fetch;
  const a = apps(openStore(":memory:"), slack);
  const made = await a.apply({ token: TOKEN, part: "advanced", agent: { key: "aria", name: "Aria Botley" } });
  expect(made).toEqual({ app_id: "A0ARIA00", part: "advanced", current: true, url: "https://api.slack.com/apps/A0ARIA00" });
  const m = JSON.parse(calls[0]!.manifest!);
  expect(m.display_information.name).toBe("Aria Botley · AidenHQ");
  expect(m.features.bot_user.display_name).toBe("Aria Botley");
  expect(m.features.slash_commands).toBeUndefined();
  expect(m.oauth_config.scopes.user).toBeUndefined();
  expect(m.oauth_config.scopes.bot).not.toContain("commands");
  expect(m.oauth_config.scopes.bot).toContain("im:history");
  expect(m.settings.event_subscriptions.user_events).toBeUndefined();
  expect(m.settings.event_subscriptions.bot_events).toContain("app_mention");
  // Its record is its own: the instance's status is untouched.
  expect(a.status("aria").app_id).toBe("A0ARIA00");
  expect(a.status().app_id).toBeNull();
});

it("the instance app's record from before one-per-app is carried over once", () => {
  const store = openStore(":memory:");
  store.setKv("app:last", JSON.stringify({ id: "A0OLD000", part: "advanced" }));
  store.setKv("app:A0OLD000", "abc");
  adoptLegacy(store);
  adoptLegacy(store);
  expect(apps(store).status()).toEqual({ app_id: "A0OLD000", part: "advanced", current: false, url: "https://api.slack.com/apps/A0OLD000" });
  expect(store.listKv("app:")).toEqual([]);
});
