import { expect, it } from "vitest";
import { mapKeys, mayPropose, type PagePoint } from "../src/module-views.js";

const page: PagePoint = { id: "ship", title: "Ship", icon: "rocket", order: 10, module: "ship", connection: "ship", view: "ui://ship/page", tools: [], settings: ["code_review", "maintainer_repos"] };

it("a page proposes its module's own settings and the keys it lists, nothing else", () => {
  expect(mayPropose(page, "ship", ["ship"])).toBe(true);
  expect(mayPropose(page, "maintainer_repos", ["github"])).toBe(true);
  expect(mayPropose(page, "github_orgs", ["github"])).toBe(false);
  expect(mayPropose(page, "spend_day_usd", [])).toBe(false);
});

it("a secret map's keys come from its setting's applied value, once each", () => {
  const settings = { ui_testing: { apps: [{ name: "acme" }, { name: "beta" }, { name: "acme" }, { url: "x" }] } };
  expect(mapKeys("ui_testing.apps[].name", settings)).toEqual(["acme", "beta"]);
  expect(mapKeys("ui_testing.apps[].name", {})).toEqual([]);
  expect(mapKeys("ui_testing.nope[].name", settings)).toEqual([]);
});
