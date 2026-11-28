// The teammate page's "How to reach" rows (src/reach.ts): each declared way reads its state from the setting's applied value
// and, for an app, the stored tokens; an address row shows its addresses; a way the agent has no entry in is off.
import { expect, it } from "bun:test";
import { teammateReach, type ReachPoint } from "../src/reach.js";
import type { PagePoint } from "../src/module-views.js";

const points: ReachPoint[] = [
  { id: "app", label: "Own Slack app", kind: "app", setting: "slack_agent_apps", secret_map: "slack_agent_apps", module: "slack" },
  { id: "email", label: "Email", kind: "address", setting: "google_agent_addresses", module: "google" },
];
const settings = { slack_agent_apps: [{ agent: "aria" }], google_agent_addresses: [{ agent: "aria", address: "abotley@example.com" }, { agent: "aria", address: "a+aria@example.com" }, { agent: "eli", address: "eli@example.com" }] };
const pages = [{ id: "slack", module: "slack", secret_maps: [{ secret: "slack_agent_apps" }] }, { id: "other", module: "google" }] as unknown as PagePoint[];

it("reads each way's real state", async () => {
  const ok = await teammateReach({ agent: "aria", points, pages, settings, stored: async () => ["aria"] });
  expect(ok.rows.map((r) => [r.id, r.state])).toEqual([["slack:app", "on"], ["google:email", "on"]]);
  expect(ok.rows[1]).toMatchObject({ address: ["abotley@example.com", "a+aria@example.com"], detail: "abotley@example.com, a+aria@example.com", manage: { module: "google", page: "other" } });
  expect(ok.rows[0]!.manage).toEqual({ module: "slack", page: "slack" });
  expect(ok.address).toBe(true);

  const waiting = await teammateReach({ agent: "aria", points, pages, settings, stored: async () => [] });
  expect(waiting.rows[0]!.state).toBe("needs");
  // A failed read of the tokens is no answer, so it never reads as connected.
  expect((await teammateReach({ agent: "aria", points, pages, settings, stored: async () => null })).rows[0]!.state).toBe("needs");
});

it("shows a way the agent has no entry in as off, with no address", async () => {
  const r = await teammateReach({ agent: "nobody", points, pages: [], settings, stored: async () => [] });
  expect(r.rows.map((x) => x.state)).toEqual(["off", "off"]);
  expect(r.rows[0]!.manage).toEqual({ module: "slack" });
  expect(r.address).toBe(false);
});
