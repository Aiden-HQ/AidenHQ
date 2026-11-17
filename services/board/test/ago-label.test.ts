import { describe, expect, it } from "vitest";
import { agoLabel } from "../web/src/util.js";

describe("agoLabel", () => {
  const now = Date.parse("2026-11-18T12:00:00Z");
  it("reads as a relative time or a date, never both", () => {
    expect(agoLabel("2026-11-18T11:55:00Z", now)).toBe("5m ago");
    expect(agoLabel("2026-11-18T11:59:50Z", now)).toBe("just now");
    expect(agoLabel("2026-11-10T12:00:00Z", now)).not.toMatch(/ago/);
  });
});
