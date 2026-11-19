// A connection never connected is calm ("Not connected yet", Connect in Settings > Connections); only one that worked and
// stopped alarms (a red banner on the board, the gear's dot).
import { describe, expect, it } from "vitest";
import { connectionStatus, needsAttention, type ConnectionRow, type ConnectionsData } from "../web/src/connections.js";

const row = (state: string): ConnectionRow => ({
  name: "slack", module: "slack", kind: "connection", transport: "http", tools: { read: 1, write: 0 }, grants: [], setup: null, probe: null,
  signIn: { state, configured: true, since: "2026-11-19T08:00:00Z" },
});
const can = { signIn: true, google: true };
const data = (r: ConnectionRow) => ({ connections: [r], sources: [] }) as unknown as ConnectionsData;

describe("a sign-in that was never made", () => {
  it("reads Not connected yet with a Connect, and doesn't need the owner", () => {
    const v = connectionStatus(row("missing"), can);
    expect(v).toMatchObject({ status: "not_connected", reason: "Not connected yet." });
    expect(v.action?.label).toBe("Connect");
    expect(needsAttention(data(row("missing")), can)).toBe(false);
  });
  it("alarms once it worked and stopped", () => {
    expect(connectionStatus(row("expired"), can).status).toBe("signed_out");
    expect(needsAttention(data(row("expired")), can)).toBe(true);
  });
});
