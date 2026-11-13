import { describe, expect, it } from "vitest";
import { connectionStatus, sourceStatus, type ConnectionRow } from "../web/src/connections.js";

const at = "2026-11-13T06:00:00Z";
const row = (over: Partial<ConnectionRow>): ConnectionRow => ({ name: "x", module: "x", kind: "connection", transport: "http x:1", tools: { read: 1, write: 0 }, grants: [], setup: null, probe: null, signIn: null, ...over });
const probe = (p: Partial<NonNullable<ConnectionRow["probe"]>>) => ({ ok: false, checkedAt: at, ...p });
const here = { signIn: true, google: true };
const phone = { signIn: false, google: false };

// The shapes seen from a live instance's /healthz answers and the board's sign-in states.
describe("connection status", () => {
  it("maps health and sign-in answers to the owner's words", () => {
    expect(connectionStatus(row({ probe: probe({ ok: true }) }), here).status).toBe("connected");
    // Jira answers ok with a warning: still connected, the warning is the reason.
    expect(connectionStatus(row({ probe: probe({ ok: true, state: "ok", detail: "Atlassian no longer offers createJiraIssue" }) }), here)).toMatchObject({ status: "connected", reason: expect.stringContaining("no longer offers") });
    // Primer: no state, only a detail naming the unset URL.
    expect(connectionStatus(row({ probe: probe({ status: 503, detail: "PRIMER_MCP_URL not set" }) }), here)).toMatchObject({ status: "not_configured" });
    expect(connectionStatus(row({ probe: probe({ detail: "unreachable: ENOTFOUND" }) }), here)).toMatchObject({ status: "error", reason: "Unreachable: ENOTFOUND" });
    expect(connectionStatus(row({ probe: probe({ status: 500 }) }), here)).toMatchObject({ status: "error", reason: "health check answered HTTP 500" });
    // The tasks bridge runs inside each run: nothing to probe.
    expect(connectionStatus(row({ transport: "built in" }), here).status).toBe("unknown");
  });

  it("offers Connect where the board can start the sign-in, and says where to go otherwise", () => {
    const glean = row({ name: "glean", signIn: { state: "missing", configured: true, since: at }, probe: probe({ state: "missing", detail: "not signed in" }) });
    expect(connectionStatus(glean, here)).toMatchObject({ status: "signed_out", action: { label: "Connect", href: "/glean/connect" } });
    expect(connectionStatus(glean, phone)).toMatchObject({ status: "signed_out", hint: expect.stringContaining("127.0.0.1:3120") });
    expect(connectionStatus(glean, phone).action).toBeUndefined();
    expect(connectionStatus(row({ name: "jira", signIn: { state: "expired", configured: true, since: at } }), here)).toMatchObject({ status: "signed_out", action: { label: "Reconnect" } });
    // Not set up at all: no Connect button (the setup steps say what to do).
    expect(connectionStatus(row({ name: "glean", signIn: { state: "missing", configured: false, since: at, detail: "GLEAN_MCP_URL not set" } }), here)).toEqual({ status: "not_configured", reason: "GLEAN_MCP_URL not set" });
  });

  it("puts an expired Google account ahead of a healthy service", () => {
    const google = row({ name: "google_workspace", probe: probe({ ok: true }), google: { accounts: [{ email: "a@example.com", primary: true, state: "expired", since: at }] } });
    expect(connectionStatus(google, here)).toMatchObject({ status: "signed_out", action: { href: "/google/connect?account=a%40example.com" } });
    expect(connectionStatus({ ...google, google: { accounts: [], error: "no token" } }, here)).toMatchObject({ status: "signed_out", action: { label: "Connect Google" } });
  });

  it("flags only stale sources", () => {
    expect(sourceStatus({ name: "src_slack", lastOk: at, failing: true, stale: false }).status).toBe("connected");
    expect(sourceStatus({ name: "src_slack", lastOk: null, failing: true, stale: true }).status).toBe("error");
  });
});
