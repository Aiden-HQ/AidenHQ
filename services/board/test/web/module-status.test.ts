// A module switched on whose setup finishes by pairing a phone (web/src/ModuleParts.tsx moduleState): it says so in one
// status, never "On" beside "Needs setup", and its action is to pair.
import { describe, expect, it } from "vitest";
import { moduleState } from "../../web/src/ModuleParts";

describe("a module's one status", () => {
  it("an enabled module whose pairing is unfinished is not on", () => {
    expect(moduleState({ state: "on" }, { setup: true, pairing: true })).toEqual({ tone: "needs", word: "Enabled, not paired", action: "Pair your phone" });
  });
  it("an unfinished flow that isn't pairing still says Needs setup, and a paired module is On", () => {
    expect(moduleState({ state: "on" }, { setup: true, pairing: false })).toEqual({ tone: "needs", word: "Needs setup" });
    expect(moduleState({ state: "on" }, { setup: false, pairing: false })).toEqual({ tone: "working", word: "On" });
    expect(moduleState({ state: "off" }, { setup: true, pairing: true })).toEqual({ tone: "needs", word: "Needs setup" });
  });
});
