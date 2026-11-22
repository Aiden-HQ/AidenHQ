import { expect, it } from "vitest";
import { fleetOnly } from "../src/open-prs.js";

it("lists only PRs the kernel has a record of: a hand-made PR in the fleet org is not listed", () => {
  const rows = [
    { repo: "acme-agents/probe", number: 2 },
    { repo: "Acme-Agents/app", number: 5 },
    { repo: "acme/other", number: 5 },
  ];
  expect(fleetOnly(rows, [{ repo: "acme-agents/app", number: 5 }])).toEqual([rows[1]]);
  expect(fleetOnly(rows, [])).toEqual([]);
});
