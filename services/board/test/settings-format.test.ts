import { describe, expect, it } from "vitest";
import { cronText, modelShort } from "../web/src/settings-format.js";

describe("settings in plain words", () => {
  it("reads the schedules agents run on", () => {
    expect(cronText("45 8 * * 1-5")).toBe("weekdays 8:45");
    expect(cronText("12 */4 * * *")).toBe("every 4h");
    expect(cronText("0 9 * * 1")).toBe("Mondays 9:00");
    expect(cronText("*/30 8-20 * * *")).toBe("every 30 min, 8:00 to 20:59");
    expect(cronText("0 7 1 * *")).toBe("monthly on the 1st, 7:00");
    expect(cronText("0 0 1 1 *")).toBe("0 0 1 1 *"); // unusual: the cron itself
  });
  it("shortens model ids", () => {
    expect(modelShort("openrouter/~deepseek/deepseek-flash-latest")).toBe("deepseek-flash");
    expect(modelShort("openrouter/moonshotai/kimi-k3.1-pro")).toBe("kimi-k3.1-pro");
  });
});
