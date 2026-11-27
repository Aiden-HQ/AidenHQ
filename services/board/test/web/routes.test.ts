// Old addresses land on their new homes once (App.tsx redirectOld), and closing an overlay goes back to the page under it.
import { afterEach, describe, expect, it } from "bun:test";
import { key, mountApp, settle, unmountApp } from "./app-fixture";

afterEach(unmountApp);

describe("routes", () => {
  it("sends an old chat link to the task drawer", async () => {
    await mountApp("#/c/WOR-7");
    expect(location.hash).toBe("#/t/WOR-7");
  });
  it("sends a Fleet page to its module page under Team", async () => {
    await mountApp("#/fleet/code-review");
    expect(location.hash).toBe("#/team/m/code-review");
  });
  it("sends the old board to Tasks", async () => {
    await mountApp("#/board");
    expect(location.hash).toBe("#/tasks");
  });
  it("closes a task opened from Team back to Team, not Home", async () => {
    await mountApp("#/team");
    location.hash = "#/t/WOR-7";
    await settle();
    await key("Escape");
    await settle();
    expect(location.hash).toBe("#/team");
  });
});
