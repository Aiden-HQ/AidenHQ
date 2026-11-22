import { expect, it } from "vitest";
import { fleetOnly } from "../src/open-prs.js";

it("lists only PRs the kernel has a record of: a hand-made PR in the fleet org is not listed", () => {
  const rows = [
    { repo: "aidenhq-alpha/rate-limit-probe", number: 2 },
    { repo: "AidenHQ-Alpha/app", number: 5 },
    { repo: "acme/other", number: 5 },
  ];
  expect(fleetOnly(rows, [{ repo: "aidenhq-alpha/app", number: 5 }])).toEqual([rows[1]]);
  expect(fleetOnly(rows, [])).toEqual([]);
});
