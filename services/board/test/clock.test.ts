import { describe, expect, it } from "bun:test";
import { clockWords, hhmmWords, timeFormatOf } from "../src/clock.js";

describe("time_format", () => {
  it("reads 12h by default and 24h on request", () => {
    expect(timeFormatOf(undefined)).toBe("12h");
    expect(timeFormatOf("24h")).toBe("24h");
    expect(clockWords(20, 0, "12h")).toBe("8:00 PM");
    expect(clockWords(0, 5, "12h")).toBe("12:05 AM");
    expect(clockWords(12, 30, "12h")).toBe("12:30 PM");
    expect(clockWords(20, 0, "24h")).toBe("20:00");
    expect(hhmmWords("07:00", "12h")).toBe("7:00 AM");
  });
});
