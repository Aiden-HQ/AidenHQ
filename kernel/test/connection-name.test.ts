// One rule for a connection's name, read by every layer that lists or routes one: the module compiler, the launcher's box
// config and its route, and the backplane's `/c/:connection/mcp`. A hyphen (modules/server-manager's `server-manager`) must
// pass all four together, so a name one accepts is never dropped or refused by another.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CONNECTION_NAME, isConnectionName } from "../src/connection-name.ts";
import { routeRegex } from "../src/backplane.ts";
import { emitsServer, jobServers } from "../../services/computer/lib.ts";
import { jobcapEntries } from "../../scripts/modules.ts";

const HYPHENATED = "server-manager";
test("a connection name's one rule: a hyphen passes the compiler, the launcher and the backplane route", () => {
  assert.equal(isConnectionName(HYPHENATED), true);
  assert.equal(CONNECTION_NAME.test("server_manager"), true);
  assert.equal(CONNECTION_NAME.test("server.manager"), false);
  // The module compiler's jobcap rule.
  const caps = jobcapEntries("sm", { connections: { [HYPHENATED]: { url: "http://sm-mcp:1/mcp", auth: "sm_service_key", tools: { read: ["sm_get"], write: [] } } }, jobcaps: [{ id: "sm-read", connection: HYPHENATED, tools: ["sm_get"], read_url: "http://sm-mcp:81/mcp/read", read_secret: "sm_mcp_token" }] });
  assert.equal(caps["sm-read"].connection, HYPHENATED);
  // The launcher's box config, and the same segment its route matches.
  assert.deepEqual(jobServers({ [HYPHENATED]: ["sm_get"] }, { [HYPHENATED]: {} }, "http://gw").map((s) => s.url), [`http://gw/c/${HYPHENATED}/mcp`]);
  assert.equal(emitsServer(HYPHENATED, { [HYPHENATED]: ["sm_get"] }, { [HYPHENATED]: {} }), true);
  const routeRe = routeRegex("/c/:connection/mcp");
  assert.equal(routeRe.test(`/c/${HYPHENATED}/mcp`), true);
  assert.equal(routeRe.test("/c/server_manager/mcp"), true);
  // Another `:name` segment keeps its own rule.
  assert.equal(routeRegex("/v1/writes/:id").test("/v1/writes/k-0123456789abcdef"), true);
  // A dot stays refused everywhere.
  assert.equal(emitsServer("server.manager", { "server.manager": ["x"] }, { "server.manager": {} }), false);
  assert.equal(routeRegex("/c/:connection/mcp").test("/c/server.manager/mcp"), false);
});
