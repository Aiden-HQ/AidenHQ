// The owner's words relayed through Aiden become a request only on the app they name.
import { describe, expect, it } from "vitest";
import { assertNamesApp } from "../src/app-access.js";

describe("the owner's words name the app", () => {
  it("by name or host, as a whole word; anything else is refused with what to ask", () => {
    expect(() => assertNamesApp("roadmap-keeper: make ann@x.com an editor", "roadmap-keeper", "roadmap.example.com")).not.toThrow();
    expect(() => assertNamesApp("give ann@x.com member on Roadmap.Example.com", "roadmap-keeper", "roadmap.example.com")).not.toThrow();
    expect(() => assertNamesApp("make ann@x.com an editor", "roadmap-keeper", "roadmap.example.com")).toThrow(/don't name roadmap-keeper/);
    expect(() => assertNamesApp("roadmap-keeper-2: make ann an editor", "roadmap-keeper", "roadmap.example.com")).toThrow(/don't name/);
  });
});
