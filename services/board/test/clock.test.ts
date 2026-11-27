import { describe, expect, it } from "vitest";
import { clockWords, hhmmWords, timeFormatOf } from "../src/clock.js";
import { cronText } from "../web/src/settings-format.js";
import { setTimeFormat } from "../web/src/util.js";

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
  it("writes the board's schedules in the chosen format", () => {
    setTimeFormat(undefined);
    expect(cronText("45 8 * * 1-5")).toBe("weekdays 8:45 AM");
    setTimeFormat("24h");
    expect(cronText("45 8 * * 1-5")).toBe("weekdays 08:45");
    setTimeFormat(undefined);
  });
});
