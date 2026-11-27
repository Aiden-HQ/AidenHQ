// Settings > Connections: a `slack` tile is the owner's own Slack sign-in, never Slack as a whole. A working bot channel
// (`slack_live`) must not read as broken because this separate sign-in is absent, so its name and reason say both.
import { describe, expect, it } from "vitest";
import { connectionsView } from "../src/settings.js";
import { connectionStatus, displayName, type ConnectionRow, type SignIn } from "../web/src/connections.js";

const row = (name: string, signIn: SignIn | null): ConnectionRow => ({
  name,
  module: "slack",
  kind: "connection",
  transport: "http example.test",
  tools: { read: 1, write: 1 },
  grants: [],
  setup: null,
  probe: null,
  signIn,
});

const can = { signIn: true };
const since = "2026-01-01T00:00:00.000Z";

describe("the Slack sign-in tile", () => {
  it("is named as the owner's own sign-in, distinct from Aiden's bot", () => {
    expect(displayName("slack")).toBe("Slack: read as you");
    expect(displayName("slack_live")).toBe("Slack: Aiden's bot");
  });

  it("says what its absent sign-in gates, and that the bot doesn't depend on it, when it has no fields", () => {
    const v = connectionStatus(row("slack", { state: "missing", configured: true, since }), can);
    expect(v.status).toBe("not_connected");
    expect(v.reason).toMatch(/read Slack as you/i);
    expect(v.reason).toMatch(/separate connection/i);
    expect(v.reason).toMatch(/do(?:n.t| not) depend on/i);
    expect(v.action).toEqual({ label: "Connect", href: "/slack/connect" });
  });

  it("says the same when it isn't configured yet and has no fields", () => {
    const v = connectionStatus(row("slack", { state: "missing", configured: false, since }), can);
    expect(v.status).toBe("not_configured");
    expect(v.reason).toMatch(/read Slack as you/i);
    expect(v.reason).toMatch(/separate connection/i);
  });

  it("leaves another connection's not-connected reason as it was", () => {
    expect(connectionStatus(row("glean", { state: "missing", configured: true, since }), can).reason).toBe("Not connected yet.");
  });
});

describe("connectionsView: which connection a sign-in belongs to", () => {
  const mcp = { url: "http://x:1/mcp", tools: { read: ["a"] } };
  const catalog = [
    { name: "telegram", enabled: true, connections: ["telegram_account"] },
    { name: "channel-telegram", enabled: true, connections: ["telegram"] },
    { name: "slack", enabled: true, connections: ["slack", "slack_live"] },
  ] as never;
  const ok = (id: string) => ({ id, state: "ok", configured: true, since });
  const view = connectionsView({ compiled: { mcp_servers: { telegram_account: mcp, telegram: mcp, slack: mcp, slack_live: mcp } } as never, catalog, probes: {}, signIns: { telegram: ok("telegram"), slack: ok("slack") }, google: null, sources: [] });
  const of = (n: string) => view.connections.find((r) => r.name === n)!.signIn?.id ?? null;
  it("goes to the module's connection by the module's name, not to another module's connection of that name", () => {
    expect(of("telegram_account")).toBe("telegram");
    expect(of("telegram")).toBeNull();
  });
  it("stays on the connection named like its module", () => {
    expect(of("slack")).toBe("slack");
    expect(of("slack_live")).toBeNull();
  });
});
