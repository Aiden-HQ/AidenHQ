import { expect, it } from "vitest";
import { mayPropose, type PagePoint } from "../src/module-views.js";

const page: PagePoint = { id: "ship", title: "Ship", icon: "rocket", order: 10, module: "ship", connection: "ship", view: "ui://ship/page", tools: [], settings: ["code_review", "maintainer_repos"] };

it("a page proposes its module's own settings and the keys it lists, nothing else", () => {
  expect(mayPropose(page, "ship", ["ship"])).toBe(true);
  expect(mayPropose(page, "maintainer_repos", ["github"])).toBe(true);
  expect(mayPropose(page, "github_orgs", ["github"])).toBe(false);
  expect(mayPropose(page, "spend_day_usd", [])).toBe(false);
});
