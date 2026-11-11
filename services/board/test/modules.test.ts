import { describe, expect, it } from "vitest";
import { moduleStates } from "../src/modules.js";

describe("moduleStates", () => {
  it("tells core, chosen, dependency and off apart", () => {
    const e = (name: string, enabled: boolean, chosen = false) => ({ name, description: "", enabled, chosen, requires: [], agents: [] });
    const rows = moduleStates(JSON.stringify([e("core", true), e("jira", true, true), e("fleet-ops", true), e("design", false)]));
    expect(rows.map((r) => r.state)).toEqual(["core", "on", "dependency", "off"]);
  });
});
