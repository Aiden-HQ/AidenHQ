import { describe, expect, it } from "vitest";
import { nextSeen } from "../web/src/notify.js";

describe("nextSeen", () => {
  const item = (identifier: string, state = "waiting for you") => ({ identifier, title: "t", agent: "A", state });
  it("notifies once per waiting item, and again when the same chat asks again later", () => {
    let seen = new Set<string>();
    let r = nextSeen(seen, [item("WOR-5")]);
    expect(r.fresh.map((i) => i.identifier)).toEqual(["WOR-5"]);
    seen = r.seen;
    expect(nextSeen(seen, [item("WOR-5")]).fresh).toEqual([]); // still waiting: no repeat
    seen = nextSeen(seen, []).seen; // answered: forgotten
    r = nextSeen(seen, [item("WOR-5")]); // asks again
    expect(r.fresh.map((i) => i.identifier)).toEqual(["WOR-5"]);
  });
});
